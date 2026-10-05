import { stat } from "node:fs/promises";
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
  extensionsNaming,
  FORMATS,
  hashFile,
  isFormat,
  kindOf,
  type Thumbnail,
} from "@roost/media";
import type { Library } from "./library.js";
import { alignExtension, resolveFile } from "./locate.js";
import type { Wanted } from "./wanted.js";

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

/**
 * Finished derives committed together. Two per worker, as the claims used to
 * be — the batch is now only about the transaction, not about the claiming.
 */
function batchSize(concurrency: number): number {
  return Math.max(8, concurrency * 2);
}

/**
 * The longest finished work waits before it is committed and shown.
 *
 * A batch of videos is two seconds of work, and a thumbnail somebody scrolled
 * to should not sit finished in memory for that long waiting for fifteen
 * others to join it.
 */
const COMMIT_MS = 250;

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
  /**
   * Of {@link derived}, the assets whose pictures were kept rather than drawn,
   * because the file is the one they were drawn from (ADR-0051 §5). After a
   * rebuild that is nearly all of them.
   */
  kept: number;
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
  /**
   * What is on screen waiting, worked ahead of the queue's own order.
   *
   * Consulted at every claim, so an id added while the run is going is the
   * next thing started once a worker is free. Interactive work — a file saved
   * or a poster moved — still goes first: that is a picture somebody changed on
   * purpose, and this is a picture nobody has seen yet.
   */
  readonly wanted?: Wanted;
  /**
   * The assets to work, **instead of** the queue (ADR-0049).
   *
   * A paused queue still derives what is asked for by name — an opened file,
   * a new import — and nothing else. Consulted at every claim like
   * {@link RunOptions.wanted}, so an id added mid-run is picked up; the run ends
   * when it has nothing left to hand out. `wanted` is ignored alongside it,
   * because the grid's screenful is exactly what a pause is holding back.
   */
  readonly only?: { take(): AssetId | undefined };
  /** Stops the run: nothing new is started, and what is in flight is kept. */
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

/** One asset a derive just finished with, one way or the other. */
export interface Redrawn {
  readonly id: AssetId;
  /**
   * Unix seconds, and the cache key a thumbnail's address carries. `null` when
   * nothing about the file was written, which a failure writes nothing of.
   */
  readonly derivedAt: number | null;
  /**
   * Why it still has no picture, in the queue's own words, or `null` for one
   * that was drawn. A cell that knew only the time could not say *"needs
   * libheif"* until the grid re-paged.
   */
  readonly undrawn: string | null;
  /** Whether the pictures are ones somebody chose (ADR-0060). */
  readonly chosen: boolean;
}

/** What the queue is holding, for a status line or a capability prompt. */
export interface QueueStatus {
  readonly ready: number;
  readonly running: number;
  readonly blocked: number;
  readonly failed: number;
  /** Why work is parked, most common first. */
  readonly reasons: readonly JobReason[];
}

/**
 * The reasons a file of kind `other` has no picture: a `.zip`, an `.xcf`, a
 * file nothing recognises.
 *
 * **That is the expected outcome, not news**, so it is counted nowhere a
 * person is told about missing pictures — not in the status bar, not in the
 * list behind it. Asked for on 2026-09-24, beside an `.xcf` the list was
 * still reporting after it had been made `other`: *"file other langsung
 * tampil saja tidak ada notifikasi"*. The jobs stay parked, which is what
 * keeps the backfill sweep from enqueueing them again on every open; they are
 * only not reported.
 *
 * An image nothing here draws — a BMP, a RAW with no embedded preview — is not
 * in this list: a picture that cannot be shown is still worth a word.
 */
export const EXPECTED_ABSENCES: readonly string[] = FORMATS.filter(
  (format) => kindOf(format) === "other",
).map((format) => `unsupported:${format}`);

export function queueStatus(library: Library): QueueStatus {
  const counts = library.db.repo.jobCounts();
  const of = (state: string): number =>
    counts.find((row) => row.state === state && row.kind === "derive")?.count ?? 0;

  const parked = library.db.repo.jobReasons("blocked");
  const reported = parked.filter((row) => !EXPECTED_ABSENCES.includes(row.reason));
  const expected = parked
    .filter((row) => EXPECTED_ABSENCES.includes(row.reason))
    .reduce((sum, row) => sum + row.count, 0);

  return {
    ready: of("ready"),
    running: of("running"),
    blocked: of("blocked") - expected,
    failed: of("failed"),
    reasons: reported,
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
  const rows = library.db.repo.jobsIn(
    "derive",
    state,
    options.rows ?? FAILURE_ROWS,
    EXPECTED_ABSENCES,
  );
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
    // The same count the status bar shows, so the list's heading and the line
    // that opened it are one number.
    total: state === "blocked" ? queueStatus(library).blocked : queueStatus(library).failed,
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
  released += releaseNowNamed(library);
  if (released > 0) log.info("released work this build has learned to draw", { jobs: released });
  return released;
}

/**
 * Formats this build can name and cannot draw, which is what `unsupported:`
 * followed by something other than `unknown` means.
 */
const NAMED_ONLY: readonly string[] = FORMATS.filter(
  (format) => format !== "unknown" && capabilityFor(format) === undefined,
).flatMap(extensionsNaming);

/**
 * Releases work parked as `unknown` whose format this build can now name.
 *
 * A GIMP file parked as *"a kind of file Roost does not recognise"* before
 * `xcf` was in the table (2026-09-24) says so for ever otherwise: the reason is
 * the old build's, and nothing retries an `unsupported:` reason. Released, it
 * parks again as `unsupported:xcf` — the same absence of a picture, now with
 * its right name.
 *
 * **Only for formats that are named and not drawn.** Releasing every
 * `unknown` whose extension is known would release a damaged `.jpg` — which
 * sniffs as unknown, and will again — at every open, for ever. Scoped to these,
 * the same can happen only to a damaged `.xcf` or `.zip`, which costs one
 * 64-byte read each time a library opens.
 */
function releaseNowNamed(library: Library): number {
  return library.db.repo.requeueBlockedWithExt("derive", "unsupported:unknown", NAMED_ONLY);
}

/** Retries work that failed, while it is still worth retrying. */
export function retryFailed(library: Library, maxAttempts = 3): number {
  return library.db.repo.requeueFailed("derive", maxAttempts);
}

/**
 * Works the queue until it is empty, the limit is reached, or the signal fires.
 *
 * Each worker claims one job, derives it, and claims the next, so the queue's
 * order — and {@link RunOptions.wanted} — is read afresh every time a worker
 * comes free. It used to claim a batch and wait for the whole batch, which
 * started sixteen ffmpeg processes in the same instant once per batch: a spawn
 * is ~5 ms of the event loop, and the grid's page request waited behind all of
 * them (`BENCHMARKS.md`). Workers that finish at different moments spread the
 * spawns out, and nobody idles at the end of a batch waiting for its slowest
 * file.
 *
 * Finished work is still committed in batches, and an interrupted run keeps
 * everything it committed; the next run picks up where it stopped. Jobs left
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
  const batch = batchSize(concurrency);

  const report: DeriveReport = {
    derived: 0,
    thumbnails: 0,
    kept: 0,
    bytes: 0,
    blocked: 0,
    failed: 0,
    missing: 0,
    elapsed: 0,
    failures: [],
  };

  const reclaimed = library.db.repo.resetRunningJobs();
  if (reclaimed > 0) log.info("returned claimed jobs to the queue", { jobs: reclaimed });

  let claimed = 0;
  const claim = (): JobClaim | undefined => {
    if (claimed >= limit || options.signal?.aborted === true) return undefined;
    const next =
      options.only === undefined
        ? claimNext(library, options.wanted)
        : claimOnly(library, options.only);
    if (next !== undefined) claimed += 1;
    return next;
  };

  let finished: DeriveOutcomeRow[] = [];
  let committedAt = performance.now();
  const commit = (): void => {
    if (finished.length === 0) return;
    const outcomes = finished;
    finished = [];
    committedAt = performance.now();

    // One transaction per batch: a long run commits as it goes, and an
    // interruption costs at most a batch of work rather than the run.
    const now = Math.floor(Date.now() / 1000);
    const redrawn: Redrawn[] = [];
    library.db.transaction(() => {
      for (const outcome of outcomes) {
        const id = parseAssetId(outcome.claim.assetId);
        // Read inside the transaction, not trusted from before the derive:
        // somebody may have chosen this asset's pictures while it was being
        // drawn, and a drawing committed now would replace them (ADR-0060).
        const chosen = library.db.repo.pictureSource(id)?.chosen === true;
        if (outcome.kind === "kept") {
          library.db.repo.putDerived(id, outcome.metadata, now);
          library.db.repo.completeJob(outcome.claim.id);
          redrawn.push({ id, derivedAt: now, undrawn: null, chosen });
          report.derived += 1;
          report.kept += 1;
        } else if (chosen && (outcome.kind === "ok" || outcome.kind === "measured")) {
          // The file was measured and its pictures kept: what it is now is the
          // file's, and what it looks like is somebody's.
          const { size, mtime } = outcome.metadata;
          if (size !== undefined && mtime !== undefined) {
            library.db.repo.putPictureSource(id, {
              size,
              mtime,
              posterMs: outcome.claim.posterMs,
              metadata: outcome.metadata,
            });
          }
          library.db.repo.putDerived(id, outcome.metadata, now);
          library.db.repo.completeJob(outcome.claim.id);
          redrawn.push({ id, derivedAt: now, undrawn: null, chosen });
          report.derived += 1;
          report.kept += 1;
        } else if (outcome.kind === "measured") {
          // Measured for pictures somebody chose, which are gone by the
          // commit. Queued again, to be drawn from the file this time.
          library.db.repo.putDerived(id, outcome.metadata, now);
          library.db.repo.enqueueJob("derive", id, JOB_PRIORITY.interactive, now);
          redrawn.push({ id, derivedAt: null, undrawn: null, chosen });
        } else if (outcome.kind === "ok") {
          // Whatever this asset had is a picture of the file as it was, and a
          // preview size this pass does not draw would outlive the bytes it
          // shows. Dropped with its source, and the new ones written after.
          library.db.repo.dropThumbnails(id);
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
          const { size, mtime } = outcome.metadata;
          if (size !== undefined && mtime !== undefined) {
            library.db.repo.putPictureSource(id, {
              size,
              mtime,
              posterMs: outcome.claim.posterMs,
              metadata: outcome.metadata,
            });
          }
          library.db.repo.putDerived(id, outcome.metadata, now);
          library.db.repo.completeJob(outcome.claim.id);
          redrawn.push({ id, derivedAt: now, undrawn: null, chosen });
          report.derived += 1;
        } else if (outcome.kind === "blocked") {
          // What was measured survives the block: a format this build cannot
          // draw still has a size and a hash, and a library that knew neither
          // would report every one of those assets as never read.
          if (outcome.measured !== undefined) {
            library.db.repo.putDerived(id, outcome.measured, now);
          }
          // A blocked asset draws a placeholder rather than a picture, and
          // the placeholder says why; its *size* is on screen in the details
          // view either way.
          redrawn.push({
            id,
            derivedAt: outcome.measured === undefined ? null : now,
            undrawn: outcome.reason,
            chosen,
          });
          library.db.repo.blockJob(outcome.claim.id, outcome.reason);
          if (outcome.reason === MISSING_FILE) report.missing += 1;
          else report.blocked += 1;
        } else {
          library.db.repo.failJob(outcome.claim.id, outcome.reason);
          redrawn.push({ id, derivedAt: null, undrawn: outcome.reason, chosen });
          report.failed += 1;
          if (report.failures.length < REPORTED_FAILURES) {
            report.failures.push({ id: outcome.claim.assetId, reason: outcome.reason });
          }
        }
      }
    });

    if (redrawn.length > 0) options.onDerived?.(redrawn);
    options.onProgress?.(report);
  };

  const worker = async (): Promise<void> => {
    for (let job = claim(); job !== undefined; job = claim()) {
      // Awaited into a local first: `finished.push(await ...)` reads
      // `finished` before the await, and a commit by another worker replaces
      // it in the meantime.
      const outcome = await deriveOne(library, job, sizes);
      finished.push(outcome);
      if (finished.length >= batch || performance.now() - committedAt >= COMMIT_MS) commit();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  commit();

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

/**
 * The next job to start: interactive work, then what is on screen, then the
 * rest of the queue in its own order.
 */
function claimNext(library: Library, wanted: Wanted | undefined): JobClaim | undefined {
  const { repo } = library.db;
  const urgent = repo.claimJob("derive", JOB_PRIORITY.interactive);
  if (urgent !== undefined) return urgent;

  // An id with nothing waiting — drawn already, parked, or being drawn — is
  // simply dropped: it was asked for because its cell had no picture, and the
  // cell will learn why from the same place it always does.
  for (let id = wanted?.take(); id !== undefined; id = wanted?.take()) {
    const onScreen = repo.claimJobFor("derive", id);
    if (onScreen !== undefined) return onScreen;
  }
  return repo.claimJob("derive");
}

/**
 * The next job among the assets asked for by name, skipping any with nothing
 * waiting — drawn already, parked, or never queued.
 */
function claimOnly(library: Library, only: { take(): AssetId | undefined }): JobClaim | undefined {
  for (let id = only.take(); id !== undefined; id = only.take()) {
    const claim = library.db.repo.claimJobFor("derive", id);
    if (claim !== undefined) return claim;
  }
  return undefined;
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
      /** The pictures already there still show this file (ADR-0051 §5). */
      kind: "kept";
      claim: JobClaim;
      metadata: DerivedMetadata;
    }
  | {
      kind: "ok";
      claim: JobClaim;
      thumbnails: readonly Thumbnail[];
      metadata: DerivedMetadata;
    }
  | {
      /**
       * Measured and not drawn, because the pictures are somebody's
       * (ADR-0060). A format nothing here can draw ends here too, rather
       * than parked: the picture it lacked has been supplied.
       */
      kind: "measured";
      claim: JobClaim;
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

    const source = library.db.repo.pictureSource(claim.assetId);
    const kept = await keptPictures(library, claim, path, sizes);
    if (kept !== undefined) return { kind: "kept", claim, metadata: kept };

    if (source?.chosen === true) {
      // The file changed under pictures somebody chose. Its dimensions and
      // duration are still the file's to say (RL-22), and a backend is what
      // reads them, so it runs and what it drew is thrown away.
      const probed = await derive(path, sizes, claim.posterMs ?? undefined);
      const measured = await measure(path);
      const read = probed.metadata;
      return {
        kind: "measured",
        claim,
        metadata: read === undefined ? measured : { ...read, ...measured },
      };
    }

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
      : {
          kind: "blocked",
          claim,
          reason: outcome.reason,
          measured:
            outcome.metadata === undefined ? measured : { ...outcome.metadata, ...measured },
        };
  } catch (error) {
    return {
      kind: "failed",
      claim,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The metadata recorded with this asset's pictures, if they can be kept as
 * they are (ADR-0051 §5).
 *
 * All three must hold for pictures drawn from the file, and the last for ones
 * somebody chose: every size asked for is there, the frame they show is
 * the one the asset is pinned to now, and the file's size and modification
 * time are the ones they were drawn from. That last test is the one ADR-0047
 * already trusts to decide that a file changed, so trusting it the other way
 * adds no new assumption, and it costs one `stat` rather than a decode and a
 * hash. It is what turns the derive pass after a rebuild from hours into
 * seconds.
 */
async function keptPictures(
  library: Library,
  claim: JobClaim,
  path: string,
  sizes: readonly number[],
): Promise<DerivedMetadata | undefined> {
  const { repo } = library.db;
  const source = repo.pictureSource(claim.assetId);
  if (source === undefined) return undefined;
  // Pictures somebody chose show no frame, and are every size there is of
  // them: neither test describes them (ADR-0060).
  if (!source.chosen) {
    if (source.posterMs !== claim.posterMs) return undefined;
    if (!repo.hasThumbnails(claim.assetId, sizes)) return undefined;
  }

  const stats = await stat(path);
  // Floored as `hashFile` floors it, or every comparison would miss.
  const mtime = Math.floor(stats.mtimeMs / 1000);
  if (stats.size !== source.size || mtime !== source.mtime) return undefined;
  return source.metadata;
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
