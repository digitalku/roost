import { stat } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import {
  type AddRecord,
  type AssetId,
  type DerivedMetadata,
  IndexSink,
  type JournalRecord,
  logger,
  type PutOptions,
  type Storage,
  type Take,
  toNfc,
} from "@roost/core";
import { type HashOptions, hashFile, probe } from "@roost/media";
import { type Claims, claim } from "./claims.js";
import { mapWithConcurrency } from "./concurrency.js";
import { discover, measure } from "./discover.js";
import { addToFolder } from "./edit.js";
import { UnknownFolderError } from "./error.js";
import { FolderMaker } from "./folder-maker.js";
import { enqueueDerives } from "./jobs.js";
import type { Library } from "./library.js";
import { nowUnix } from "./library.js";
import { ByteMeter, LARGE_FILE, type MeterShare } from "./meter.js";
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
   * Brings each directory in `sources` across as a folder, with its
   * subdirectories as its subfolders (ADR-0058).
   *
   * The directory itself becomes a folder under {@link folder}, or at the top
   * level where there is none, and every file joins the folder its own
   * directory became. A folder that is already there by that name is used
   * rather than made again, so a second import of one directory fills the
   * folders the first made. A file named directly in `sources` is filed as it
   * would be without this.
   *
   * **Only a directory something was imported from becomes a folder.** They are
   * made as their first file arrives, so a directory that holds nothing, or
   * only duplicates, makes none.
   *
   * Off unless asked for: the window and the CLI ask, and the Eagle importer,
   * which maps Eagle's own folders, does not.
   */
  readonly structure?: boolean;
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
  /**
   * Stops the run (ADR-0055 §3.3). Files not yet started are left where they
   * are, one half copied is abandoned and its partial copy removed, and **every
   * file already placed is committed**, so nothing lands in `files/` without a
   * journal line. What has arrived stays arrived; running the import again
   * finds it a duplicate and brings the rest.
   */
  readonly signal?: AbortSignal;
  /**
   * Asks for progress in bytes (ADR-0055 §3.1, §3.2).
   *
   * Given this, the sources are walked once to be counted before they are
   * walked again to be imported, so that the total is known from the start.
   * The count keeps two numbers and no paths.
   */
  readonly onBytes?: (progress: ImportBytes) => void;
  /**
   * A meter already sized, in place of the count {@link onBytes} would make.
   *
   * The Eagle importer's: its survey summed the sizes before the first item,
   * and it imports in chunks that each call {@link importInto}, so one meter
   * has to run across all of them.
   */
  readonly meter?: ByteMeter;
}

/** How far an import has got in bytes (ADR-0055). */
export interface ImportBytes {
  /**
   * The first walk is still counting. `files` and `bytesTotal` are what it
   * has found so far, and nothing has been read.
   */
  readonly counting: boolean;
  /** The files counted: the total, once counting is over. */
  readonly files: number;
  readonly bytesDone: number;
  readonly bytesTotal: number;
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
   * Where each duplicate would have been filed, beside {@link duplicateIds}
   * (ADR-0058 §3.4): the names of the folders below the run's own folder, or
   * none for a file filed in that folder itself.
   *
   * Names rather than ids, because nothing is made for a duplicate unless it
   * is asked for afterwards — a directory of nothing but duplicates would
   * otherwise leave an empty folder behind.
   */
  readonly duplicatePlaces: (readonly string[])[];
  /** Folders this run made, its directories brought across (ADR-0058). */
  folders: number;
  /**
   * The first {@link DUPLICATE_PREVIEW} of them by name, for a dialog to draw.
   *
   * Names and not paths: the question a person answers is "which of my files
   * were already here", and the directory they just chose is not news.
   */
  readonly duplicateNames: string[];
  /** The run was stopped before it reached every file (ADR-0055 §3.3). */
  cancelled: boolean;
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
    duplicatePlaces: [],
    folders: 0,
    importedIds: [],
    duplicateNames: [],
    cancelled: false,
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
  const { signal, onBytes } = options;
  const includeHidden = options.includeHidden ?? false;

  // Checked before the first file is hashed, not when its record is written.
  // A folder deleted between the click and the request would otherwise fail
  // the run halfway, after some of it had already been journalled.
  if (options.folder !== undefined && library.db.repo.folder(options.folder) === undefined) {
    throw new UnknownFolderError(options.folder);
  }

  const meter =
    options.meter ??
    (onBytes === undefined
      ? undefined
      : await countFirst(library, sources, includeHidden, signal, onBytes));

  const run: Run = {
    take: options.take ?? "copy",
    tags: options.tags ?? [],
    folder: options.folder,
    places:
      options.structure === true
        ? new Places(library, await directoriesIn(sources), options.folder ?? null)
        : undefined,
    onAsset: options.onAsset,
    signal,
    meter,
  };

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

  /** Files hashed in this batch but not yet visible to a reader (`claims.ts`). */
  const pending: Claims = new Map();

  /**
   * Ids minted in this batch, for RL-15.
   *
   * An id is checked against the library before it is written, and rows for
   * this batch do not exist yet — so the check has to see what has been minted
   * since the last commit as well.
   */
  const minted = new Set<AssetId>();

  const walker = discover(sources, library.root, includeHidden);
  for (;;) {
    // Between windows as well as inside them: a stop during the count, or
    // just after a batch was committed, should not start another.
    if (signal?.aborted === true) break;

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
        // Asked for, not a failure: the file was left where it was.
        if (signal?.aborted === true) return undefined;
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

    // Whether or not the run was stopped: what was placed is committed, or it
    // would be a file in `files/` that nothing journalled (ADR-0055 §3.3).
    await commit(library, batch, report.timings);
    batch = [];
    pending.clear();
    minted.clear();
  }
  await walker.return(undefined);
  report.cancelled = signal?.aborted === true;
  report.folders = run.places?.created ?? 0;

  // After every batch is committed, because attaching is itself a journal
  // write and the asset it points at has to be in the index first (ADR-0025).
  if (tracks.length > 0) {
    const siblings = await attachSiblings(library, tracks);
    report.subtitles = siblings.attached;
    report.subtitlesUnattached = siblings.unattached;
  }

  report.elapsed = performance.now() - started;
  log.info(report.cancelled ? "import stopped" : "import complete", {
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
  /** Where each file is filed, when the run brings its directories across. */
  readonly places: Places | undefined;
  readonly onAsset: ((path: string, id: AssetId) => void) | undefined;
  readonly signal: AbortSignal | undefined;
  readonly meter: ByteMeter | undefined;
}

/**
 * The sources that are directories, as `discover` spells their paths.
 *
 * Read once, before the walk: the walk yields files and not the source each
 * came from, and a file's place is its directory's path below that source.
 */
async function directoriesIn(sources: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const source of sources) {
    const path = resolve(source);
    const entry = await stat(path).catch(() => undefined);
    if (entry?.isDirectory() === true) found.push(path);
  }
  return found;
}

/**
 * A run's directories as folders (ADR-0058).
 *
 * A file's **place** is the chain of folder names from the run's own folder
 * down to it: `Trip 2024/Bali` for `Trip 2024/Bali/a.jpg` imported from
 * `Trip 2024`. Its folder is that chain, found or made.
 */
class Places {
  readonly #roots: readonly string[];
  readonly #base: number | null;
  readonly #maker: FolderMaker;

  constructor(library: Library, roots: readonly string[], base: number | null) {
    // Longest first, so a directory imported beside its own parent is the
    // place its files are counted from.
    this.#roots = [...roots].sort((a, b) => b.length - a.length);
    this.#base = base;
    this.#maker = new FolderMaker(library);
  }

  get created(): number {
    return this.#maker.created;
  }

  /** The names below the run's folder, or none for a file named on its own. */
  of(path: string): readonly string[] {
    const root = this.#roots.find((candidate) => path.startsWith(candidate + sep));
    if (root === undefined) return [];
    const below = relative(root, dirname(path));
    return [basename(root), ...(below === "" ? [] : below.split(sep))];
  }

  /**
   * The folder a newly imported file joins.
   *
   * **Never throws**: the file is already placed by the time this is asked, so
   * it is committed whatever this answers. A directory whose name cannot be a
   * folder's — nothing but spaces, say — files it one level up instead.
   */
  async folderFor(path: string): Promise<number | undefined> {
    return this.within(this.of(path));
  }

  /** The folder at the end of `names`, below the run's folder, made as needed. */
  async within(names: readonly string[]): Promise<number | undefined> {
    let at = this.#base;
    for (const name of names) {
      try {
        at = await this.#maker.child(at, name);
      } catch (error) {
        log.warn("directory not made a folder", {
          name,
          reason: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
    return at ?? undefined;
  }
}

/**
 * Files each asset into the folder its place names, below `base`, making the
 * folders that are not there yet (ADR-0058 §3.4).
 *
 * For a run's duplicates, once somebody has said they should join the folders
 * their directories became: an add, never a move, because an asset belongs to
 * as many folders as it was put in. An asset whose place is empty joins `base`
 * itself, and none at all where `base` is `null`. Answers how many were filed.
 */
export async function fileInPlaces(
  library: Library,
  base: number | null,
  items: readonly { readonly id: AssetId; readonly place: readonly string[] }[],
): Promise<number> {
  const places = new Places(library, [], base);
  const byFolder = new Map<number, Set<AssetId>>();
  for (const { id, place } of items) {
    const folder = await places.within(place);
    if (folder === undefined) continue;
    const held = byFolder.get(folder);
    if (held === undefined) byFolder.set(folder, new Set([id]));
    else held.add(id);
  }
  let filed = 0;
  for (const [folder, ids] of byFolder) {
    await addToFolder(library, [...ids], folder);
    filed += ids.size;
  }
  return filed;
}

/**
 * The first of the two walks (ADR-0055 §3.1), and the meter it sizes.
 *
 * A stop during the count answers a meter of what was found. The walk that
 * follows sees the signal before its first window and starts nothing.
 */
async function countFirst(
  library: Library,
  sources: readonly string[],
  includeHidden: boolean,
  signal: AbortSignal | undefined,
  onBytes: (progress: ImportBytes) => void,
): Promise<ByteMeter> {
  const measured = await measure(sources, library.root, includeHidden, {
    signal,
    onProgress: (found) =>
      onBytes({ counting: true, files: found.files, bytesDone: 0, bytesTotal: found.bytes }),
  });
  const meter: ByteMeter = new ByteMeter(measured.bytes, () =>
    onBytes({
      counting: false,
      files: measured.files,
      bytesDone: meter.done,
      bytesTotal: meter.total,
    }),
  );
  onBytes({ counting: false, files: measured.files, bytesDone: 0, bytesTotal: measured.bytes });
  return meter;
}

/**
 * One file's worth of work, waiting to be committed.
 *
 * The records and the derived data travel together because they are written in
 * one transaction: the journal line says an asset exists, and what the file
 * measured is a fact about the bytes that nothing journals (RL-23).
 */
export interface Ingested {
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
  pending: Claims,
  minted: Set<AssetId>,
  report: ImportReport,
): Promise<Ingested | undefined> {
  if (run.signal?.aborted === true) return undefined;

  // Before the file is read, for two things: its size is its share of the
  // bar, and its date has to be read while the file is still here — a move
  // renames it away before the record is written.
  const source = await stat(path);
  const share = run.meter?.file(source.size);
  try {
    return await ingestMeasured(
      library,
      storage,
      path,
      source.mtimeMs,
      share,
      run,
      pending,
      minted,
      report,
    );
  } finally {
    share?.finish();
  }
}

async function ingestMeasured(
  library: Library,
  storage: Storage,
  path: string,
  sourceMtimeMs: number,
  share: MeterShare | undefined,
  run: Run,
  pending: Claims,
  minted: Set<AssetId>,
  report: ImportReport,
): Promise<Ingested | undefined> {
  const { tags, onAsset, signal } = run;
  const hashStarted = performance.now();
  const hashOptions: HashOptions = {
    ...(share !== undefined && { onBytes: share.count }),
    ...(signal !== undefined && { signal }),
  };
  const hashed = await hashFile(path, hashOptions);
  report.timings.hashing += performance.now() - hashStarted;

  // Includes waiting for an identical file in this batch to arrive, which is
  // time a duplicate spends deciding whether it is one.
  const dedupeStarted = performance.now();
  const claimed = await claim(
    hashed.hash,
    pending,
    minted,
    (hash) => library.db.repo.assetsWithHash(hash)[0],
    (candidate) => library.db.repo.hasAsset(candidate),
  );
  report.timings.dedupe += performance.now() - dedupeStarted;

  if ("held" in claimed) {
    const existing = claimed.held;
    report.duplicates += 1;
    report.duplicateIds.push(existing);
    report.duplicatePlaces.push(run.places?.of(path) ?? []);
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

  const { id } = claimed;

  // `extname` gives the **last** component with its dot; the format stores it
  // lowercased and without one (RL-9). So `b.tar.gz` is `<id>.gz`, and a file
  // with no extension is a bare `<id>` with **no trailing dot** (RL-9a).
  const ext = extname(path).replace(/^\./, "").toLowerCase();

  // Counted as it goes only when it is large (ADR-0055 §3.2): below that the
  // kernel's copy is faster, and the file is squared off whole when it ends.
  const putOptions: PutOptions = {
    ...(share !== undefined && hashed.size >= LARGE_FILE && { onBytes: share.count }),
    ...(signal !== undefined && { signal }),
  };
  const placeStarted = performance.now();
  let placed: Awaited<ReturnType<Storage["put"]>>;
  try {
    placed = await storage.put(path, id, ext, run.take, putOptions);
  } catch (error) {
    // Released, or an identical file waiting on it would be reported as a
    // duplicate of an asset no batch adds (ADR-0055 §3.5).
    claimed.settle(false);
    throw error;
  }
  // Placed, so committed: whatever follows, the batch this file is in is
  // written, even after a stop (ADR-0055 §3.3).
  claimed.settle(true);
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
  // saves it. This is the one fact about a file that the journal carries. Read
  // before the file was placed, because a move takes it away (ADR-0055 §3.5).
  const created = Math.floor(sourceMtimeMs / 1000);

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
  add["created"] = created;

  const ts = nowUnix();
  const records: JournalRecord[] = [{ ts, op: "add", ...(add as unknown as AddRecord) }];
  if (tags.length > 0) records.push({ ts, op: "tag_add", asset: id, tags: [...tags] });
  // In the same batch as the `add`, so a crash between them is not a file in
  // the library that nobody put anywhere (invariant 9). A folder its directory
  // became is already journalled by now: `createFolder` writes its own line
  // before this batch is committed.
  const folder = run.places === undefined ? run.folder : await run.places.folderFor(path);
  if (folder !== undefined) {
    records.push({ ts, op: "folder_add", asset: id, folder });
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

/**
 * Journal first, then index. Never the other way around.
 *
 * Exported for the transfer between libraries (ADR-0054), which places files
 * the way an import does and owes the target the same commit.
 */
export async function commit(
  library: Library,
  batch: readonly Ingested[],
  timings?: ImportTimings,
): Promise<void> {
  if (batch.length === 0) return;

  const records = batch.flatMap((item) => [...item.records]);

  const journalStarted = performance.now();
  await library.journal.appendAll(records);
  if (timings !== undefined) timings.journaling += performance.now() - journalStarted;

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
  if (timings !== undefined) timings.indexing += performance.now() - indexStarted;

  // After the fold, never before: the mark says how far the index has been
  // brought, and a crash between the two would otherwise leave it claiming
  // records that never arrived.
  await library.noteJournalAppended();
}
