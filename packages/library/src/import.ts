import { open, realpath, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import {
  type AddRecord,
  type ContentHash,
  IndexSink,
  type JournalRecord,
  logger,
  type Storage,
  type StorageMode,
} from "@roost/core";
import { hashFile, probe } from "@roost/media";
import { mapWithConcurrency } from "./concurrency.js";
import { discover } from "./discover.js";
import { PartialHashCollisionError } from "./error.js";
import { enqueueDerives } from "./jobs.js";
import type { Library } from "./library.js";
import { nowUnix } from "./library.js";

/**
 * The import pipeline.
 *
 * ```text
 * discover → hash → dedupe → place → probe → journal → index
 * ```
 *
 * The ordering of the last two is not negotiable: the journal is appended and
 * flushed **before** the index is touched. A row in `index.db` with no journal
 * line is silent data loss on the next rebuild (invariant 9).
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

/**
 * Read size when comparing two files that share a partial hash.
 *
 * Matches the hasher's own buffer, since both are sequential reads of a file
 * large enough to have been partially hashed in the first place.
 */
const COMPARE_BUFFER_BYTES = 256 * 1024;

export interface ImportOptions {
  readonly mode?: StorageMode;
  /** Applied to everything imported in this run. */
  readonly tags?: readonly string[];
  /** Whether to descend into dot-directories and import dotfiles. */
  readonly includeHidden?: boolean;
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
   * Files already in the library. Deduplication is structural — identical bytes
   * have one address — so this is the ordinary outcome of re-importing.
   */
  duplicates: number;
  /**
   * Duplicates decided by a partial hash whose bytes could not be reached to
   * confirm: a referenced original that has moved, or an import running in
   * referenced mode, where there is no object store to compare against. These
   * are *probable* rather than certain, and counted separately so the number is
   * visible instead of implied.
   */
  partialDuplicates: number;
  /**
   * Files refused because their partial hash matched an existing asset but
   * their bytes did not.
   */
  partialCollisions: number;
  bytes: number;
  readonly failed: ImportFailure[];
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
    duplicates: 0,
    partialDuplicates: 0,
    partialCollisions: 0,
    bytes: 0,
    failed: [],
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
  const mode: StorageMode = options.mode ?? "managed";
  const tags = options.tags ?? [];
  const storage = library.storageFor(mode);

  let batch: JournalRecord[] = [];

  /**
   * Hashes journalled in the current batch but not yet visible to a reader.
   *
   * Without this, two identical files in one batch both look new and the second
   * silently overwrites the first's row instead of deduplicating. The source
   * path travels with the hash so that a partial-hash duplicate against a file
   * from this same batch can still be compared in full — the original is never
   * moved, so its path stays readable.
   */
  const pending = new Map<string, string>();

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
        return await ingest(library, storage, path, mode, tags, pending, report);
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
      if (result !== undefined) batch.push(...result.records);
    }

    await commit(library, batch, report.timings);
    batch = [];
    pending.clear();
  }

  report.elapsed = performance.now() - started;
  log.info("import complete", {
    scanned: report.scanned,
    imported: report.imported,
    duplicates: report.duplicates,
    partialDuplicates: report.partialDuplicates,
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

/** Who, if anyone, already holds an incoming file's hash. */
type Claim =
  /** Nothing in the library has this hash. */
  | { readonly kind: "free" }
  /** Something has it, and its bytes are readable at this path. */
  | { readonly kind: "held"; readonly path: string }
  /**
   * Something has it, but its bytes cannot be reached from here — a referenced
   * original, which lives outside the object store.
   */
  | { readonly kind: "out-of-reach" };

/**
 * Hashes, deduplicates, places, and probes one file, returning the records it
 * owes the journal. `undefined` when the asset is already present.
 */
async function ingest(
  library: Library,
  storage: Storage,
  path: string,
  mode: StorageMode,
  tags: readonly string[],
  pending: Map<string, string>,
  report: ImportReport,
): Promise<{ hash: ContentHash; records: JournalRecord[] } | undefined> {
  const hashStarted = performance.now();
  const hashed = await hashFile(path);
  report.timings.hashing += performance.now() - hashStarted;

  const dedupeStarted = performance.now();
  const claim = resolveClaim(library, hashed.hash, pending);
  // Claimed **synchronously**, in the same turn as the lookup that found it
  // free. JavaScript cannot interleave without an `await`, so this is the
  // atomic compare-and-set the concurrent walk needs: two identical files in
  // flight at once would otherwise both look new, and the second would silently
  // overwrite the first's row instead of deduplicating.
  if (claim.kind === "free") pending.set(hashed.hash, path);
  report.timings.dedupe += performance.now() - dedupeStarted;

  if (claim.kind !== "free") {
    await recordDuplicate(claim, path, hashed.isPartial, report);
    // Importing a file the library has already trashed brings it back.
    // Otherwise the import would report a duplicate and the asset would stay
    // invisible, which reads as the import having silently done nothing — and
    // deliberately adding a file is the clearest statement there is that the
    // user wants it. `add` is not journalled again: nothing about the asset
    // changed, and re-adding would rewrite `imported_at` and move it to the
    // top of a grid it has been in for months (ADR-0022).
    // A number, not merely "not null": `trashedAt` answers `undefined` for a
    // hash with no row, which is what an in-batch duplicate looks like — the
    // first copy is journalled but not yet indexed. Restoring that would write
    // a journal line for an asset nothing has added.
    if (typeof library.db.repo.trashedAt(hashed.hash) === "number") {
      const ts = nowUnix();
      return { hash: hashed.hash, records: [{ ts, op: "restore", hash: hashed.hash }] };
    }
    return undefined;
  }

  // `extname` gives the **last** component with its dot; the spec stores it
  // lowercased and without one. So `b.tar.gz` is `<hash>.gz`, and a file with
  // no extension is a bare `<hash>` with no trailing dot. Getting this wrong
  // puts one asset at two addresses across the two implementations, and the
  // object store cannot catch it — storage is handed the extension, it does not
  // choose it.
  const ext = extname(path).replace(/^\./, "").toLowerCase();

  const placeStarted = performance.now();
  const placed = await storage.put(path, hashed.hash, ext);
  report.timings.placing += performance.now() - placeStarted;

  // Dimensions come from the header, not from decoding pixels, so this is cheap
  // enough to run on every file. They go in the journal rather than being
  // re-derived: a referenced asset's file may be gone by rebuild time.
  const probeStarted = performance.now();
  const probed = await probe(path).catch(() => undefined);
  report.timings.probing += performance.now() - probeStarted;

  const created = await stat(path)
    .then((info) => Math.floor(info.mtimeMs / 1000))
    .catch(() => undefined);

  const add: Record<string, unknown> = {
    hash: hashed.hash,
    ext,
    size: hashed.size,
    name: basename(path),
    mode,
  };
  // Built field by field rather than by spreading: an object carrying
  // `undefined` serialises differently from one missing the key, and the
  // journal's format turns on exactly that difference (`op.ts`).
  if (placed.linkMethod !== undefined) add["link"] = placed.linkMethod;
  if (probed?.width !== undefined) add["w"] = probed.width;
  if (probed?.height !== undefined) add["h"] = probed.height;
  if (created !== undefined) add["created"] = created;
  if (mode === "referenced") {
    add["ref"] = await realpath(path).catch(() => resolve(path));
  }
  if (hashed.isPartial) add["partial"] = true;

  const ts = nowUnix();
  const records: JournalRecord[] = [{ ts, op: "add", ...(add as unknown as AddRecord) }];
  if (tags.length > 0) records.push({ ts, op: "tag_add", hash: hashed.hash, tags: [...tags] });

  report.imported += 1;
  report.bytes += hashed.size;
  return { hash: hashed.hash, records };
}

/**
 * Where the bytes already under `hash` are, if anything holds it.
 *
 * **Resolved from the existing asset's storage mode, not from this import's.**
 * The Rust build located through the incoming mode's store, which made every
 * cross-mode case unreachable: importing in referenced mode against a managed
 * asset would ask `ReferencedStorage` for a path, be refused, and merge on
 * probability even though the bytes were sitting in the object store. It was
 * pessimistic in both directions, and `TODO.md` carried the referenced half as
 * deferred because reaching `ref_path` at this point was the missing piece.
 *
 * It is not missing: `findOriginal` returns it in the same row as the mode. The
 * effect is narrow but it is the safe direction — a partial-hash collision in
 * referenced mode is now refused rather than silently merged, which is the
 * protection managed mode already had.
 */
function resolveClaim(
  library: Library,
  hash: ContentHash,
  pending: ReadonlyMap<string, string>,
): Claim {
  const inBatch = pending.get(hash);
  if (inBatch !== undefined) return { kind: "held", path: inBatch };

  const original = library.db.repo.findOriginal(hash);
  if (original === undefined) return { kind: "free" };

  if (original.storageMode === "referenced") {
    // A referenced original is not in the store at all; its location is
    // user-chosen and recorded in the index. It may also have moved since,
    // which the byte comparison discovers rather than this function.
    return original.refPath === null
      ? { kind: "out-of-reach" }
      : { kind: "held", path: original.refPath };
  }

  // A managed original sits at the one path the store derives from its hash —
  // the only place in the workspace allowed to do that (invariant 2).
  return { kind: "held", path: library.storageFor("managed").locate(hash, original.ext) };
}

async function recordDuplicate(
  claim: Claim,
  path: string,
  isPartial: boolean,
  report: ImportReport,
): Promise<void> {
  // A full hash is the whole file, so a match is already proof.
  if (!isPartial) {
    report.duplicates += 1;
    return;
  }

  if (claim.kind === "out-of-reach") {
    report.duplicates += 1;
    report.partialDuplicates += 1;
    return;
  }
  if (claim.kind === "free") return;

  // Only files over 50 MiB reach here, so the full read is paid on the rare
  // duplicate rather than on every import.
  switch (await compare(path, claim.path)) {
    case "same":
      report.duplicates += 1;
      return;
    case "unreadable":
      report.duplicates += 1;
      report.partialDuplicates += 1;
      return;
    case "different":
      report.partialCollisions += 1;
      throw new PartialHashCollisionError(path, claim.path);
  }
}

/** What comparing an incoming file against the bytes under its hash proved. */
type Comparison = "same" | "different" | "unreadable";

/**
 * Compares two files byte for byte, stopping at the first difference.
 *
 * A comparison rather than a second hash: it short-circuits, and the question
 * here is "are these the same file", not "what is this file called".
 *
 * **Sizes are not a shortcut.** The size is hashed as the partial hash's
 * prefix, so two files with equal partial hashes necessarily have equal sizes —
 * comparing them proves nothing. A mismatch would instead mean the stored file
 * is not what the index says it is, which proves nothing about the incoming
 * file either, so it reads as `unreadable`.
 */
async function compare(incoming: string, existing: string): Promise<Comparison> {
  let left: Awaited<ReturnType<typeof open>>;
  let right: Awaited<ReturnType<typeof open>>;
  try {
    left = await open(incoming, "r");
  } catch {
    return "unreadable";
  }
  try {
    right = await open(existing, "r");
  } catch {
    await left.close();
    return "unreadable";
  }

  try {
    const [leftInfo, rightInfo] = await Promise.all([left.stat(), right.stat()]);
    if (leftInfo.size !== rightInfo.size) return "unreadable";

    const a = Buffer.allocUnsafe(COMPARE_BUFFER_BYTES);
    const b = Buffer.allocUnsafe(COMPARE_BUFFER_BYTES);
    for (;;) {
      const read = await left.read(a, 0, COMPARE_BUFFER_BYTES, null);
      if (read.bytesRead === 0) return "same";
      const other = await right.read(b, 0, read.bytesRead, null);
      if (other.bytesRead !== read.bytesRead) return "unreadable";
      if (!a.subarray(0, read.bytesRead).equals(b.subarray(0, read.bytesRead))) return "different";
    }
  } catch {
    return "unreadable";
  } finally {
    await left.close();
    await right.close();
  }
}

/** Journal first, then index. Never the other way around. */
async function commit(
  library: Library,
  batch: readonly JournalRecord[],
  timings: ImportTimings,
): Promise<void> {
  const journalStarted = performance.now();
  await library.journal.appendAll(batch);
  timings.journaling += performance.now() - journalStarted;

  const indexStarted = performance.now();
  library.db.transaction(() => {
    const sink = new IndexSink(library.db);
    for (const record of batch) sink.apply(record);

    // Queued in the same transaction as the rows they are about (§5 step 8).
    // Committing an asset without the intent to derive it would leave it with
    // no thumbnail until something ran a whole-library sweep, and a crash
    // between two transactions is exactly when that happens.
    enqueueDerives(
      library,
      batch.filter((record) => record.op === "add").map((record) => record.hash),
    );
  });
  timings.indexing += performance.now() - indexStarted;
}
