import { availableParallelism } from "node:os";
import {
  type AssetId,
  type DerivedMetadata,
  JOB_PRIORITY,
  type JobClaim,
  type JobReason,
  logger,
  parseAssetId,
} from "@roost/core";
import {
  capabilityFor,
  derive,
  EAGER_SIZES,
  hashFile,
  isFormat,
  type Thumbnail,
} from "@roost/media";
import { mapWithConcurrency } from "./concurrency.js";
import type { Library } from "./library.js";
import { alignExtension, resolveFile } from "./locate.js";

/**
 * The derive queue: thumbnails and metadata, as background work.
 *
 * Import stops at the point where the bytes are placed and the journal is
 * written (`ARCHITECTURE.md` §5). Everything a format-specific backend has to
 * say about a file happens here instead, because it costs orders of magnitude
 * more — a video is two process spawns and a quarter of a second (ADR-0017) —
 * and because it can be interrupted, resumed, and re-run without re-importing
 * anything.
 *
 * Derived data is never journalled (RL-23): a rebuild discards it and running
 * this restores it from `files/`. In version 2 that is not only the thumbnail
 * and the dimensions — the size, the modification time and the content hash are
 * derived too (RL-22), so this pass is the only thing that knows what an
 * asset's bytes currently are.
 */

const log = logger("jobs");

/** Jobs claimed at once. Two per worker, so nobody waits on the claim. */
function batchSize(concurrency: number): number {
  return Math.max(8, concurrency * 2);
}

/**
 * How many derives run at once.
 *
 * `sharp` runs on libuv's threadpool and ffmpeg runs in its own process, so
 * both scale with cores rather than with the event loop. Capped at 16 for the
 * same reason import is: past that the queue is longer without being fuller.
 */
function deriveConcurrency(): number {
  return Math.max(2, Math.min(16, availableParallelism()));
}

export interface DeriveReport {
  /** Assets that gained thumbnails, metadata, or both. */
  derived: number;
  /** Thumbnails written across every size. */
  thumbnails: number;
  bytes: number;
  /** Parked: no backend on this machine, or a format nothing here draws. */
  blocked: number;
  /** Tried and did not survive. Retryable. */
  failed: number;
  /** Referenced originals whose file has moved or been deleted. */
  missing: number;
  elapsed: number;
  /**
   * The first few failures, for a person to read.
   *
   * Bounded: a library where every derive fails would otherwise grow this to
   * the size of the library, and nobody reads the ten-thousandth line. The
   * count above is the number that matters; `jobs.reason` keeps the rest.
   */
  readonly failures: { id: string; reason: string }[];
}

/** How many failures a report carries in full. */
const REPORTED_FAILURES = 20;

export interface RunOptions {
  /** Sizes to generate. Defaults to the eager set, which is the grid size. */
  readonly sizes?: readonly number[];
  /** Stop after this many jobs. The default is "until the queue is empty". */
  readonly limit?: number;
  readonly concurrency?: number;
  /** Called after each batch commits, with the report so far. */
  readonly onProgress?: (report: DeriveReport) => void;
  /**
   * Fired per committed batch with the assets whose derived data was replaced.
   *
   * Separate from `onProgress`, which carries counts: a window showing a cell
   * has to know **which** id to redraw, because the thumbnail behind an id can
   * change now (RL-20) and an `<img>` whose `src` did not change is one
   * Chromium never asks about again (ADR-0047).
   *
   * After the transaction, never inside it: a listener that threw would roll
   * back work that is already on disk.
   */
  readonly onDerived?: (assets: readonly Redrawn[]) => void;
  /** Stops the run at the next batch boundary. */
  readonly signal?: AbortSignal;
}

/**
 * Queues derived work for assets that were just imported.
 *
 * Called inside the importer's own transaction, so an asset and the intent to
 * derive it are committed together: a crash between the two would leave an
 * asset nothing ever looks at again until a backfill sweep runs.
 */
export function enqueueDerives(
  library: Library,
  ids: readonly AssetId[],
  priority: number = JOB_PRIORITY.import,
): void {
  const now = Math.floor(Date.now() / 1000);
  for (const id of ids) library.db.repo.enqueueJob("derive", id, priority, now);
}

/**
 * Queues every asset still missing a thumbnail, and reports how many were added.
 *
 * The sweep that makes the queue self-healing: a rebuild drops `thumbs`, an
 * import that ran without ffmpeg leaves videos bare, and this finds both. It
 * deliberately does not disturb jobs already parked as blocked, which is what
 * makes running it twice converge instead of retrying every undrawable format
 * forever.
 */
export function enqueueMissing(
  library: Library,
  sizes: readonly number[] = EAGER_SIZES,
  priority: number = JOB_PRIORITY.backfill,
  limit = Number.MAX_SAFE_INTEGER,
): number {
  const now = Math.floor(Date.now() / 1000);
  return library.db.repo.enqueueMissingDerives("derive", sizes, priority, now, limit);
}

/** What the queue is holding, for a status line or a capability prompt. */
/** One asset whose derived data was just replaced, and when. */
export interface Redrawn {
  readonly id: AssetId;
  /** Unix seconds, and the cache key a thumbnail's address carries. */
  readonly derivedAt: number;
}

export interface QueueStatus {
  readonly ready: number;
  readonly running: number;
  readonly blocked: number;
  readonly failed: number;
  /** Why work is parked, most common first. */
  readonly reasons: readonly JobReason[];
}

export function queueStatus(library: Library): QueueStatus {
  const counts = library.db.repo.jobCounts();
  const of = (state: string): number =>
    counts.find((row) => row.state === state && row.kind === "derive")?.count ?? 0;

  return {
    ready: of("ready"),
    running: of("running"),
    blocked: of("blocked"),
    failed: of("failed"),
    reasons: library.db.repo.jobReasons("blocked"),
  };
}

/** One of the files a derive could not draw. */
export interface DeriveFailureSample {
  readonly id: string;
  readonly name: string;
  readonly ext: string;
}

/** Files whose derive failed for what is recognisably the same reason. */
export interface DeriveFailureGroup {
  /** The message, with the parts that differ from file to file taken out. */
  readonly reason: string;
  readonly count: number;
  /** The most tries any file in the group has had. */
  readonly attempts: number;
  /** A few of the files, so the reason has something to point at. */
  readonly samples: readonly DeriveFailureSample[];
}

/**
 * What failed and why, for somebody who has to fix it.
 *
 * `total` counts every failed job; `read` is how many rows the grouping
 * actually looked at, and the two differ only in a library where something has
 * gone wrong at scale. `hidden` is what fell outside the groups returned —
 * failures whose messages were too varied to be worth a row each.
 */
export interface DeriveFailures {
  readonly total: number;
  readonly read: number;
  readonly hidden: number;
  readonly groups: readonly DeriveFailureGroup[];
}

export interface FailureOptions {
  /**
   * Which half of "no picture" to read.
   *
   * `failed` is work that went wrong and can be tried again; `blocked` is work
   * this machine cannot do as it stands — a format nothing here draws, or a
   * decoder that is not installed (ADR-0040). The list is the same shape for
   * both, because the question a person asks about an empty cell is.
   */
  readonly state?: "failed" | "blocked";
  /** How many rows to read. */
  readonly rows?: number;
  /** How many groups to return, largest first. */
  readonly groups?: number;
  /** How many files to name per group. */
  readonly samples?: number;
}

/**
 * The rows read before the grouping gives up.
 *
 * Two thousand is far more than anybody reads and far less than a library's
 * worth: past this, the answer is "something is wrong with the machine", and
 * one more page of the same message does not change it.
 */
const FAILURE_ROWS = 2_000;

/** Groups returned. Distinct reasons are few; this is the guard, not the norm. */
const FAILURE_GROUPS = 20;

/** Files named per group. Enough to recognise a pattern, short enough to read. */
const FAILURE_SAMPLES = 8;

/**
 * Groups failed derives by what went wrong, with a few of the files in each.
 *
 * Grouped here rather than in SQL because the messages are **not** identical
 * even when the fault is: ffmpeg puts the file's own path in its complaint, so
 * `GROUP BY reason` over thirty broken videos returns thirty groups of one.
 * {@link normaliseReason} is what turns those into one row.
 */
export function deriveFailures(library: Library, options: FailureOptions = {}): DeriveFailures {
  const state = options.state ?? "failed";
  const rows = library.db.repo.jobsIn("derive", state, options.rows ?? FAILURE_ROWS);
  const wanted = options.samples ?? FAILURE_SAMPLES;

  const groups = new Map<
    string,
    { count: number; attempts: number; samples: DeriveFailureSample[] }
  >();
  for (const row of rows) {
    const reason = normaliseReason(row.reason);
    const group = groups.get(reason) ?? { count: 0, attempts: 0, samples: [] };
    group.count += 1;
    group.attempts = Math.max(group.attempts, row.attempts);
    if (group.samples.length < wanted) {
      group.samples.push({ id: row.assetId, name: row.name, ext: row.ext });
    }
    groups.set(reason, group);
  }

  const ordered = [...groups]
    .map(([reason, group]) => ({ reason, ...group }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  const kept = ordered.slice(0, options.groups ?? FAILURE_GROUPS);

  return {
    total:
      library.db.repo.jobCounts().find((c) => c.kind === "derive" && c.state === state)?.count ?? 0,
    read: rows.length,
    hidden: ordered.slice(kept.length).reduce((sum, group) => sum + group.count, 0),
    groups: kept,
  };
}

/**
 * The part of a failure message that is about the *kind* of failure.
 *
 * Two things are taken out, and only two. **Paths**, because every backend that
 * shells out names the file it was given — `ffmpeg: /photos/a.mov: Invalid data
 * found when processing input` is the same fault as the next thirty, and a
 * grouping that kept the path would report each of them separately. And **long
 * hex runs**, which are content hashes by another name.
 *
 * Numbers are deliberately kept: an exit code and a pixel limit are what the
 * message is *about*, and folding `exited with 137` into `exited with 1` would
 * hide the difference between a crash and a refusal.
 */
export function normaliseReason(raw: string): string {
  const line = raw.split("\n").find((candidate) => candidate.trim() !== "") ?? "";

  const words: string[] = [];
  for (const word of line.trim().split(/\s+/)) {
    const opaque = looksLikePath(word) || /^[0-9a-f]{32,}$/i.test(word.replace(/[^0-9a-f]/gi, ""));
    // Consecutive elisions collapse: a message naming an input and an output
    // should read "… to …", not turn into two adjacent holes.
    if (opaque && words.at(-1) === ELISION) continue;
    words.push(opaque ? ELISION : word);
  }

  const text = words.join(" ").trim();
  if (text === "") return "The backend said nothing";
  return text.length > REASON_LIMIT ? `${text.slice(0, REASON_LIMIT).trimEnd()}…` : text;
}

/** What a path is replaced by. A hole, not a lie about what was there. */
const ELISION = "…";

/** Long enough for a sentence, short enough for one line of a dialog. */
const REASON_LIMIT = 160;

function looksLikePath(word: string): boolean {
  const bare = word.replace(/^[("'[]+/, "").replace(/[)"'\],:;.]+$/, "");
  if (bare.length < 2) return false;
  return bare.startsWith("/") || bare.startsWith("./") || /^[A-Za-z]:[\\/]/.test(bare);
}

/**
 * Releases work parked on a capability, now that it may exist.
 *
 * The UI's "try again" after someone installs ffmpeg. Matching on the reason
 * keeps it from also retrying formats this build genuinely cannot draw, which
 * would burn a full sweep to reach the same answer.
 */
export function retryBlocked(library: Library, reason?: string): number {
  return reason === undefined
    ? library.db.repo.requeueBlocked("derive")
    : library.db.repo.requeueBlocked("derive", reason);
}

/**
 * Releases work parked on a format this build has since learned to draw.
 *
 * `unsupported:heic` is not a fact about the file — it is a fact about the
 * build that wrote it, and builds change. When HEIC gained a backend
 * (ADR-0040) every HEIC already in a library stayed parked behind a reason that
 * had stopped being true, and nothing in the window could release it: the
 * capability retry matches `missing:` reasons, and an unsupported format has
 * nothing to install.
 *
 * So this is checked when a library opens. It costs one grouped read of the
 * parked reasons — a handful of rows, whatever the size of the library — and it
 * requeues only what this build can now do, which keeps the sweep convergent
 * exactly as `enqueueMissing` does.
 */
export function releaseNowSupported(library: Library): number {
  let released = 0;
  for (const parked of library.db.repo.jobReasons("blocked")) {
    const format = parked.reason.startsWith("unsupported:")
      ? parked.reason.slice("unsupported:".length)
      : undefined;
    if (format === undefined || !isFormat(format)) continue;
    if (capabilityFor(format) === undefined) continue;
    released += library.db.repo.requeueBlocked("derive", parked.reason);
  }
  if (released > 0) log.info("released work this build has learned to draw", { jobs: released });
  return released;
}

/** Retries work that failed, while it is still worth retrying. */
export function retryFailed(library: Library, maxAttempts = 3): number {
  return library.db.repo.requeueFailed("derive", maxAttempts);
}

/**
 * Works the queue until it is empty, the limit is reached, or the signal fires.
 *
 * Claims are batched and committed batch by batch, so an interrupted run keeps
 * everything it finished and the next run picks up where it stopped. Jobs left
 * `running` by a crash are returned to the queue first — `running` describes a
 * process, and after a crash it describes one that no longer exists.
 */
export async function runDerives(
  library: Library,
  options: RunOptions = {},
): Promise<DeriveReport> {
  const started = performance.now();
  const sizes = options.sizes ?? EAGER_SIZES;
  const concurrency = options.concurrency ?? deriveConcurrency();
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;

  const report: DeriveReport = {
    derived: 0,
    thumbnails: 0,
    bytes: 0,
    blocked: 0,
    failed: 0,
    missing: 0,
    elapsed: 0,
    failures: [],
  };

  const reclaimed = library.db.repo.resetRunningJobs();
  if (reclaimed > 0) log.info("returned claimed jobs to the queue", { jobs: reclaimed });

  let handled = 0;
  while (handled < limit && options.signal?.aborted !== true) {
    const claims = library.db.repo.claimJobs(
      "derive",
      Math.min(batchSize(concurrency), limit - handled),
    );
    if (claims.length === 0) break;

    const outcomes = await mapWithConcurrency(claims, concurrency, (claim) =>
      deriveOne(library, claim, sizes),
    );

    // One transaction per batch: a long run commits as it goes, and an
    // interruption costs at most a batch of work rather than the run.
    const now = Math.floor(Date.now() / 1000);
    const redrawn: Redrawn[] = [];
    library.db.transaction(() => {
      for (const outcome of outcomes) {
        const id = parseAssetId(outcome.claim.assetId);
        if (outcome.kind === "ok") {
          for (const thumbnail of outcome.thumbnails) {
            library.db.repo.putThumbnail(
              id,
              thumbnail.size,
              thumbnail.width,
              thumbnail.height,
              thumbnail.data,
            );
            report.thumbnails += 1;
            report.bytes += thumbnail.data.length;
          }
          library.db.repo.putDerived(id, outcome.metadata, now);
          library.db.repo.completeJob(outcome.claim.id);
          redrawn.push({ id, derivedAt: now });
          report.derived += 1;
        } else if (outcome.kind === "blocked") {
          // What was measured survives the block: a format this build cannot
          // draw still has a size and a hash, and a library that knew neither
          // would report every one of those assets as never read.
          if (outcome.measured !== undefined) {
            library.db.repo.putDerived(id, outcome.measured, now);
            // A blocked asset draws a placeholder rather than a picture, and
            // its *size* is on screen in the details view either way.
            redrawn.push({ id, derivedAt: now });
          }
          library.db.repo.blockJob(outcome.claim.id, outcome.reason);
          if (outcome.reason === MISSING_FILE) report.missing += 1;
          else report.blocked += 1;
        } else {
          library.db.repo.failJob(outcome.claim.id, outcome.reason);
          report.failed += 1;
          if (report.failures.length < REPORTED_FAILURES) {
            report.failures.push({ id: outcome.claim.assetId, reason: outcome.reason });
          }
        }
      }
    });

    handled += claims.length;
    if (redrawn.length > 0) options.onDerived?.(redrawn);
    options.onProgress?.(report);
  }

  report.elapsed = performance.now() - started;
  log.info("derive pass complete", {
    derived: report.derived,
    thumbnails: report.thumbnails,
    blocked: report.blocked,
    failed: report.failed,
    missing: report.missing,
    ms: Math.round(report.elapsed),
  });
  return report;
}

/** An asset with no file under `files/` at all (RL-25). */
const MISSING_FILE = "missing:file";

/**
 * One id, two files (RL-12).
 *
 * Parked rather than failed, and never guessed at: the rule is that an
 * implementation finding two reports it and does not choose. `roost doctor` is
 * where it is seen and where a person decides.
 */
const AMBIGUOUS_FILE = "ambiguous:file";

/** What one derive produced, before it is committed with the rest of a batch. */
type DeriveOutcomeRow =
  | {
      kind: "ok";
      claim: JobClaim;
      thumbnails: readonly Thumbnail[];
      metadata: DerivedMetadata;
    }
  | {
      kind: "blocked";
      claim: JobClaim;
      reason: string;
      /** Absent when the file could not be read at all. */
      measured?: DerivedMetadata;
    }
  | { kind: "failed"; claim: JobClaim; reason: string };

async function deriveOne(
  library: Library,
  claim: JobClaim,
  sizes: readonly number[],
): Promise<DeriveOutcomeRow> {
  const id = claim.assetId;

  // Not `storage.locate` directly: another implementation may have renamed the
  // file under RL-9b, in which case it is here under a different extension and
  // treating that as missing would park the asset for ever (ADR-0047 §3).
  const resolved = await resolveFile(library, id);
  if (resolved.kind === "missing") {
    // RL-25. Parked rather than failed: it comes back when the file does, and
    // retrying now would only re-read the same absence.
    return { kind: "blocked", claim, reason: MISSING_FILE };
  }
  if (resolved.kind === "ambiguous") {
    // RL-12 forbids choosing between two files for one id, so this stops here
    // and says which two. `doctor` is where it gets fixed.
    return { kind: "blocked", claim, reason: AMBIGUOUS_FILE };
  }

  try {
    // RL-9b, and it happens before the derive rather than after: a thumbnail
    // stored against a name that is about to change is a thumbnail keyed on a
    // stale fact.
    const aligned = await alignExtension(library, id, resolved.ext, resolved.path);
    const path = aligned.path;

    // The moment somebody pinned the thumbnail to, if they did. A rebuild
    // replays `poster_set` into this column and the frame is re-extracted here,
    // which is what makes a poster survive one (ADR-0024 stage 4).
    const outcome = await derive(path, sizes, claim.posterMs ?? undefined);

    // The size, the modification time and the hash, read here because this is
    // where the file is already being opened. They are what the next pass
    // compares to decide whether anything changed under the id (RL-20), so
    // they are taken even for a format no backend can draw — a blocked
    // thumbnail is not a reason to know nothing about the bytes.
    const measured = await measure(path);

    return outcome.ok
      ? {
          kind: "ok",
          claim,
          thumbnails: outcome.thumbnails,
          metadata: { ...outcome.metadata, ...measured },
        }
      : { kind: "blocked", claim, reason: outcome.reason, measured };
  } catch (error) {
    return {
      kind: "failed",
      claim,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * What the file measures right now.
 *
 * Its own step rather than part of `derive`, because it is true of every file
 * whatever its format: a `.psd` nothing here can draw still has a size, a date
 * and a hash, and a build that only learned those for files it could thumbnail
 * would report half a library as unread.
 */
async function measure(path: string): Promise<DerivedMetadata> {
  const hashed = await hashFile(path);
  return { size: hashed.size, mtime: hashed.mtime, contentHash: hashed.hash };
}
