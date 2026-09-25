import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  type AddRecord,
  type AssetId,
  type ContentHash,
  type DerivedMetadata,
  IndexSink,
  type JournalRecord,
  logger,
  mintAssetId,
  type Storage,
  type Take,
  toNfc,
} from "@roost/core";
import { hashFile, probe } from "@roost/media";
import { mapWithConcurrency } from "./concurrency.js";
import { discover } from "./discover.js";
import { UnknownFolderError } from "./error.js";
import { enqueueDerives } from "./jobs.js";
import type { Library } from "./library.js";
import { nowUnix } from "./library.js";
import { attachSiblings, isSubtitlePath } from "./subtitles.js";

/**
 * The import pipeline.
 *
 * ```text
 * discover → hash → duplicate check → mint → place → probe → journal → index
 * ```
 *
 * The ordering of the last two is not negotiable: the journal is appended and
 * flushed **before** the index is touched. A row in `index.db` with no journal
 * line is silent data loss on the next rebuild (invariant 9).
 *
 * **What version 2 moved.** An asset's identity is now an id minted here
 * (RL-13), not the hash of its bytes, so placing a file can no longer be
 * idempotent by construction and deduplication is a *decision* rather than a
 * consequence. The hash is still taken — it is what the duplicate check reads —
 * but as derived data (RL-18), written into the index beside the size and the
 * modification time rather than into the journal (RL-23).
 */

const log = logger("import");

/**
 * How many assets are journalled and indexed per batch.
 *
 * One flush and one transaction each. Small enough that a crash loses little,
 * large enough that neither dominates an import of 100k files.
 */
const BATCH_SIZE = 500;

/**
 * How many duplicate names a report carries for the window to draw.
 *
 * The count is unbounded and the list is not: re-importing a directory of a
 * hundred thousand files is the ordinary way to produce a hundred thousand
 * duplicates, and no dialog reads them out. The full set of *ids* is kept
 * (ADR-0037 §3.1) — it is what the folder is filled from — but the names are
 * only ever a preview.
 */
const DUPLICATE_PREVIEW = 200;

/**
 * How many files are hashed, placed, and probed at once.
 *
 * Everything before the commit is filesystem work, and Node overlaps it across
 * libuv's threadpool. Sequentially the placement path measured 6,277 files/sec
 * on this machine; at eight in flight, 23,339, and it plateaus there — beyond
 * it the queue is longer without being fuller.
 *
 * **Raising `UV_THREADPOOL_SIZE` does not help this**, which is worth writing
 * down because `ARCHITECTURE.md` §3.3 tells the engine to raise it. That advice
 * is for `sharp`, which does real CPU work on those threads. A `stat` or a
 * `rename` is a short kernel call, and at 32 workers with the pool widened the
 * same benchmark got *slower*.
 *
 * The commit stays serial and in walk order: the journal is an ordered log.
 */
const CONCURRENCY = 8;

export interface ImportOptions {
  /**
   * What happens to the source file: moved into the library, or copied and
   * left where it was (RL-26).
   *
   * `copy` by default, because an import somebody typed is not a request to
   * rearrange their disk. A watched root decides this once when it is
   * registered and defaults the other way, for the opposite reason: an inbox is
   * not a place to leave things.
   *
   * Whichever happens, the report says so — RL-26 requires the person be told,
   * and a move is not undoable by looking at the library afterwards.
   */
  readonly take?: Take;
  /** Applied to everything imported in this run. */
  readonly tags?: readonly string[];
  /** Whether to descend into dot-directories and import dotfiles. */
  readonly includeHidden?: boolean;
  /**
   * A folder every **newly imported** asset joins (ADR-0037).
   *
   * The window sets it to the folder on screen, so an import lands where the
   * person who started it was looking. It is read once, when the run starts:
   * an import of forty thousand files takes minutes, and navigating elsewhere
   * in the middle of one must not scatter its last batch.
   *
   * **A duplicate does not join it.** A file the library already holds is not
   * this run's asset to file, and what to do about it is a question the window
   * asks afterwards, with the run's report in front of it (ADR-0037 §3).
   *
   * The Eagle importer never sets this: it maps Eagle's own folders
   * (ADR-0032 §3), and a second destination on top of them would file every
   * item twice.
   */
  readonly folder?: number;
  /**
   * Called with the id of the asset each file resolved to, new or already
   * present.
   *
   * The Eagle importer is what needs it (ADR-0032 §3): an item's tags have to
   * land on the asset its bytes became, and **a file the library already holds
   * is still that item's asset** — so a hook that fired only for new imports
   * would silently drop the metadata of every duplicate.
   *
   * It fires *before* the batch is committed, so the row does not exist yet.
   * Collect here; act after {@link importInto} returns.
   */
  readonly onAsset?: (path: string, id: AssetId) => void;
}

/**
 * Where an import spent its time.
 *
 * Throughput is a stated requirement, so the pipeline reports a breakdown
 * rather than one number. Knowing *which* stage is slow is the difference
 * between fixing a bottleneck and guessing at one.
 *
 * **These do not sum to the elapsed time**, and they are not meant to. Up to
 * {@link CONCURRENCY} files are in flight, so the stages overlap and their
 * total exceeds the wall clock. Read them against each other, never as a
 * percentage of the run.
 */
export interface ImportTimings {
  walking: number;
  hashing: number;
  dedupe: number;
  placing: number;
  probing: number;
  journaling: number;
  indexing: number;
}

export interface ImportFailure {
  readonly path: string;
  readonly reason: string;
}

export interface ImportReport {
  /** Milliseconds of wall clock for the whole run. */
  elapsed: number;
  timings: ImportTimings;
  scanned: number;
  imported: number;
  /**
   * How many source files were moved, and how many were copied.
   *
   * Both counted rather than one implied from the other, because a run can
   * legitimately do both: a move across filesystems falls back to a copy and an
   * unlink, and a file that could not be unlinked afterwards is still a copy
   * from the person's point of view. RL-26 asks that they be told which
   * happened, and a number is how.
   */
  moved: number;
  copied: number;
  /**
   * Files whose bytes the library already holds.
   *
   * **A decision rather than a consequence, in version 2.** Identity is an id
   * now, so nothing stops two assets holding identical bytes; what this build
   * does at import is skip the file and report it, because re-importing a
   * directory is the ordinary way to produce these and nobody means to double
   * their library by doing it. The format takes no view — a hash is derived
   * data and deduplication is an application's business (RL-18).
   */
  duplicates: number;
  bytes: number;
  /**
   * Subtitles attached to the file they were found beside (ADR-0025 §3).
   *
   * Counted rather than implied: attaching is a journal write this run made on
   * the user's behalf, and a number is how they find out it happened.
   */
  subtitles: number;
  /**
   * Subtitles that found nothing beside them to attach to.
   *
   * The counterpart to `subtitles`, and the more useful of the two: an `.srt`
   * that attached and one that did not look identical afterwards, and only the
   * one that did not needs the user to do anything.
   */
  subtitlesUnattached: number;
  readonly failed: ImportFailure[];
  /**
   * The asset each duplicate resolved to, in walk order (ADR-0037 §3.1).
   *
   * Ids rather than paths, because what they are *for* is a `folder_add`. The
   * list is the run's, and lives as long as the report does.
   */
  readonly duplicateIds: AssetId[];
  /**
   * The assets this run added, in walk order.
   *
   * What a paused derive queue still works (ADR-0049): an import is somebody
   * asking for these files now, and the rest of the queue waits.
   */
  readonly importedIds: AssetId[];
  /**
   * The first {@link DUPLICATE_PREVIEW} of them by name, for a dialog to draw.
   *
   * Names and not paths: the question a person answers is "which of my files
   * were already here", and the directory they just chose is not news.
   */
  readonly duplicateNames: string[];
}

function emptyReport(): ImportReport {
  return {
    elapsed: 0,
    timings: {
      walking: 0,
      hashing: 0,
      dedupe: 0,
      placing: 0,
      probing: 0,
      journaling: 0,
      indexing: 0,
    },
    scanned: 0,
    imported: 0,
    moved: 0,
    copied: 0,
    duplicates: 0,
    bytes: 0,
    subtitles: 0,
    subtitlesUnattached: 0,
    failed: [],
    duplicateIds: [],
    importedIds: [],
    duplicateNames: [],
  };
}

/** Files handled per second, counting duplicates — they were still hashed. */
export function filesPerSecond(report: ImportReport): number {
  return report.elapsed <= 0 ? 0 : (report.scanned / report.elapsed) * 1000;
}

/** The stages, largest first. */
export function rankedStages(timings: ImportTimings): [string, number][] {
  return Object.entries(timings).sort(([, a], [, b]) => b - a);
}

/** Imports every file under `sources` into `library`. */
export async function importInto(
  library: Library,
  sources: readonly string[],
  options: ImportOptions = {},
  onProgress?: (path: string, report: ImportReport) => void,
): Promise<ImportReport> {
  const started = performance.now();
  const report = emptyReport();
  const storage = library.storage;
  const run: Run = {
    take: options.take ?? "copy",
    tags: options.tags ?? [],
    folder: options.folder,
    onAsset: options.onAsset,
  };

  // Checked before the first file is hashed, not when its record is written.
  // A folder deleted between the click and the request would otherwise fail
  // the run halfway, after some of it had already been journalled.
  if (run.folder !== undefined && library.db.repo.folder(run.folder) === undefined) {
    throw new UnknownFolderError(run.folder);
  }

  let batch: Ingested[] = [];
  /**
   * The subtitles this run brought in, paired with their source paths.
   *
   * Only subtitles: the media file beside one is found by looking it up
   * afterwards rather than by remembering every video the walk passed
   * (`subtitles.ts`), so this list is as long as the number of `.srt` files and
   * not as long as the library.
   */
  const tracks: { path: string; id: AssetId }[] = [];

  /**
   * Files hashed in this batch but not yet visible to a reader.
   *
   * Without this, two identical files in one batch both look new and the
   * library gains two assets from one gesture. The id travels with the hash so
   * that the second copy reports the same duplicate the first one became.
   */
  const pending = new Map<ContentHash, AssetId>();

  /**
   * Ids minted in this batch, for RL-15.
   *
   * An id is checked against the library before it is written, and rows for
   * this batch do not exist yet — so the check has to see what has been minted
   * since the last commit as well.
   */
  const minted = new Set<AssetId>();

  const walker = discover(sources, library.root, options.includeHidden ?? false);
  for (;;) {
    // One window of paths, drained from the walk before any of it is processed.
    // Bounded by the batch size, so a million-file import still never holds
    // more than five hundred paths at once.
    const walkStarted = performance.now();
    const window: string[] = [];
    while (window.length < BATCH_SIZE) {
      const next = await walker.next();
      if (next.done === true) break;
      window.push(next.value);
    }
    report.timings.walking += performance.now() - walkStarted;
    if (window.length === 0) break;

    report.scanned += window.length;

    const ingested = await mapWithConcurrency(window, CONCURRENCY, async (path) => {
      try {
        return await ingest(library, storage, path, run, pending, minted, report);
      } catch (error) {
        // One file that cannot be read must not end an import of ten thousand.
        report.failed.push({
          path,
          reason: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      } finally {
        onProgress?.(path, report);
      }
    });

    // Flattened in walk order, not completion order: the journal is an ordered
    // log, and two runs over one directory should produce the same file.
    for (const result of ingested) {
      if (result === undefined) continue;
      batch.push(result);
      if (isSubtitlePath(result.path)) tracks.push({ path: result.path, id: result.id });
    }

    await commit(library, batch, report.timings);
    batch = [];
    pending.clear();
    minted.clear();
  }

  // After every batch is committed, because attaching is itself a journal
  // write and the asset it points at has to be in the index first (ADR-0025).
  if (tracks.length > 0) {
    const siblings = await attachSiblings(library, tracks);
    report.subtitles = siblings.attached;
    report.subtitlesUnattached = siblings.unattached;
  }

  report.elapsed = performance.now() - started;
  log.info("import complete", {
    scanned: report.scanned,
    imported: report.imported,
    moved: report.moved,
    copied: report.copied,
    duplicates: report.duplicates,
    failed: report.failed.length,
    bytes: report.bytes,
    ms: Math.round(report.elapsed),
  });
  for (const failure of report.failed) {
    // One line per failure: "3 failed" in a summary is not enough to act on,
    // and a terminal only shows the last few.
    log.warn("file could not be imported", { path: failure.path, reason: failure.reason });
  }

  return report;
}

/**
 * What every file in one run is treated with.
 *
 * Gathered once rather than threaded through as five parameters: the options
 * are resolved when the run starts, and `ingest` is called once per file.
 */
interface Run {
  readonly take: Take;
  readonly tags: readonly string[];
  readonly folder: number | undefined;
  readonly onAsset: ((path: string, id: AssetId) => void) | undefined;
}

/**
 * One file's worth of work, waiting to be committed.
 *
 * The records and the derived data travel together because they are written in
 * one transaction: the journal line says an asset exists, and what the file
 * measured is a fact about the bytes that nothing journals (RL-23).
 */
interface Ingested {
  readonly id: AssetId;
  readonly path: string;
  readonly records: readonly JournalRecord[];
  readonly derived: DerivedMetadata;
}

/**
 * Hashes, checks for a duplicate, mints an id, places the file, and probes it,
 * returning the work the commit owes. `undefined` when the library already
 * holds these bytes.
 */
async function ingest(
  library: Library,
  storage: Storage,
  path: string,
  run: Run,
  pending: Map<ContentHash, AssetId>,
  minted: Set<AssetId>,
  report: ImportReport,
): Promise<Ingested | undefined> {
  const { tags, onAsset } = run;
  const hashStarted = performance.now();
  const hashed = await hashFile(path);
  report.timings.hashing += performance.now() - hashStarted;

  const dedupeStarted = performance.now();
  const existing = pending.get(hashed.hash) ?? library.db.repo.assetsWithHash(hashed.hash)[0];
  report.timings.dedupe += performance.now() - dedupeStarted;

  if (existing !== undefined) {
    report.duplicates += 1;
    report.duplicateIds.push(existing);
    if (report.duplicateNames.length < DUPLICATE_PREVIEW) {
      report.duplicateNames.push(basename(path));
    }
    onAsset?.(path, existing);

    // Importing a file the library has already trashed brings it back.
    // Otherwise the import would report a duplicate and the asset would stay
    // invisible, which reads as the import having silently done nothing — and
    // deliberately adding a file is the clearest statement there is that the
    // user wants it. `add` is not journalled again: nothing about the asset
    // changed, and re-adding would rewrite `imported_at` and move it to the
    // top of a grid it has been in for months (ADR-0022).
    //
    // A number, not merely "not null": `trashedAt` answers `undefined` for an
    // id with no row, which is what an in-batch duplicate looks like — the
    // first copy is journalled but not yet indexed. Restoring that would write
    // a journal line for an asset nothing has added.
    if (typeof library.db.repo.trashedAt(existing) === "number") {
      const ts = nowUnix();
      return {
        id: existing,
        path,
        records: [{ ts, op: "restore", asset: existing }],
        derived: {},
      };
    }
    return undefined;
  }

  // RL-15: minted against the library *and* against this batch, because the
  // rows for it do not exist yet. Claimed synchronously, in the same turn as
  // the check — JavaScript cannot interleave without an `await`, which is what
  // makes this the atomic compare-and-set a concurrent walk needs.
  const id = mintAssetId(
    (candidate) => minted.has(candidate) || library.db.repo.hasAsset(candidate),
  );
  minted.add(id);
  pending.set(hashed.hash, id);

  // `extname` gives the **last** component with its dot; the format stores it
  // lowercased and without one (RL-9). So `b.tar.gz` is `<id>.gz`, and a file
  // with no extension is a bare `<id>` with **no trailing dot** (RL-9a).
  const ext = extname(path).replace(/^\./, "").toLowerCase();

  const placeStarted = performance.now();
  const placed = await storage.put(path, id, ext, run.take);
  report.timings.placing += performance.now() - placeStarted;
  if (placed.take === "move") report.moved += 1;
  else report.copied += 1;

  // Dimensions come from the header, not from decoding pixels, so this is cheap
  // enough to run on every file — and it is what lets the grid lay a cell out
  // before any thumbnail exists. They are **derived** (RL-22): they go into the
  // index beside the hash, never into the journal, because the next save of
  // this file may change them.
  const probeStarted = performance.now();
  const probed = await probe(placed.path).catch(() => undefined);
  report.timings.probing += performance.now() - probeStarted;

  // The stored file's own modification time, not the source's: it is half of
  // what a later sweep compares to decide whether the bytes have changed since,
  // and a copy does not carry the original's date over.
  const stored = await stat(placed.path).catch(() => undefined);

  const derived: DerivedMetadata = {
    size: hashed.size,
    contentHash: hashed.hash,
    ...(stored === undefined ? {} : { mtime: Math.floor(stored.mtimeMs / 1000) }),
    ...(probed?.width === undefined ? {} : { width: probed.width }),
    ...(probed?.height === undefined ? {} : { height: probed.height }),
  };

  // The source file's own date, which nothing can recover once it is here: the
  // stored file's date becomes the date of the last edit the moment anybody
  // saves it. This is the one fact about a file that the journal carries.
  const created = await stat(path)
    .then((info) => Math.floor(info.mtimeMs / 1000))
    .catch(() => undefined);

  const add: Record<string, unknown> = {
    id,
    ext,
    // The display name: the filename **without** its extension (RL-33), in NFC
    // because the filesystem hands out whichever encoding it stored and macOS
    // stores a different one (RL-49). The journal is the durable copy, so it is
    // the one that has to be stable.
    name: toNfc(nameOf(path, ext)),
  };
  // Built field by field rather than by spreading: an object carrying
  // `undefined` serialises differently from one missing the key, and the
  // journal's format turns on exactly that difference (`op.ts`).
  if (created !== undefined) add["created"] = created;

  const ts = nowUnix();
  const records: JournalRecord[] = [{ ts, op: "add", ...(add as unknown as AddRecord) }];
  if (tags.length > 0) records.push({ ts, op: "tag_add", asset: id, tags: [...tags] });
  // In the same batch as the `add`, so a crash between them is not a file in
  // the library that nobody put anywhere (invariant 9).
  if (run.folder !== undefined) {
    records.push({ ts, op: "folder_add", asset: id, folder: run.folder });
  }

  report.imported += 1;
  report.importedIds.push(id);
  report.bytes += hashed.size;
  onAsset?.(path, id);
  return { id, path, records, derived };
}

/**
 * The display name for a file: its basename with the extension taken off.
 *
 * The extension is taken off by **length**, from the extension already derived
 * for the filename, rather than by running `extname` a second time: the two
 * would disagree on a name like `archive.tar.gz`, where the stored extension is
 * `gz`, and a display name that kept half an extension is worse than one that
 * kept none.
 *
 * A dotfile keeps its whole name. `.bashrc` has no extension as far as RL-9 is
 * concerned — `extname` answers `""` for it — so there is nothing to take off.
 */
function nameOf(path: string, ext: string): string {
  const base = basename(path);
  if (ext === "") return base;
  const suffix = `.${ext}`;
  return base.toLowerCase().endsWith(suffix) ? base.slice(0, base.length - suffix.length) : base;
}

/** Journal first, then index. Never the other way around. */
async function commit(
  library: Library,
  batch: readonly Ingested[],
  timings: ImportTimings,
): Promise<void> {
  if (batch.length === 0) return;

  const records = batch.flatMap((item) => [...item.records]);

  const journalStarted = performance.now();
  await library.journal.appendAll(records);
  timings.journaling += performance.now() - journalStarted;

  const now = nowUnix();
  const indexStarted = performance.now();
  library.db.transaction(() => {
    const sink = new IndexSink(library.db);
    for (const record of records) sink.apply(record);

    // What the file measured, written in the same transaction as the row it is
    // about. It is derived data (RL-22) and nothing journals it, so a crash
    // between the two would leave an asset whose size and hash nobody knows
    // until the derive pass reaches it — correct, but slower and, for the
    // duplicate check, blind in the meantime.
    for (const item of batch) {
      if (Object.keys(item.derived).length > 0) {
        library.db.repo.putDerived(item.id, item.derived, now);
      }
    }

    // Queued in the same transaction as the rows they are about (§5 step 8).
    // Committing an asset without the intent to derive it would leave it with
    // no thumbnail until something ran a whole-library sweep, and a crash
    // between two transactions is exactly when that happens.
    enqueueDerives(
      library,
      records.filter((record) => record.op === "add").map((record) => record.id),
    );
  });
  timings.indexing += performance.now() - indexStarted;

  // After the fold, never before: the mark says how far the index has been
  // brought, and a crash between the two would otherwise leave it claiming
  // records that never arrived.
  await library.noteJournalAppended();
}
