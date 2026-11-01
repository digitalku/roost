import { stat } from "node:fs/promises";
import { type AssetId, type DerivedMetadata, JOB_PRIORITY, logger } from "@roost/core";
import { EAGER_SIZES, probe } from "@roost/media";
import { enqueueDerives, keptPictures, measure } from "./jobs.js";
import type { Library } from "./library.js";
import { resolveFile } from "./locate.js";

/**
 * Noticing that a file changed underneath the library (ADR-0047).
 *
 * Version 2 is a workspace: the bytes under `files/` may change at any time, by
 * any application, without the library being told (RL-20). Everything the index
 * holds about them is derived (RL-22) and none of it is journalled (RL-23), so
 * the only way to stay honest is to look — and this module is the looking.
 *
 * Two triggers, one comparison. `watch.ts` calls {@link refreshAsset} when the
 * filesystem says something happened; {@link catchUp} calls it for a whole
 * library, for the edits made while Roost was closed. **Neither trusts its
 * trigger**: a file is re-derived because its size or its modification time
 * differs from what the index recorded, never because an event arrived. That is
 * what makes a spurious event cost one `stat`, and what lets an editor's four
 * events for one save produce one derive.
 */

const log = logger("refresh");

/** What {@link refreshAsset} did, for a log line and for the tests. */
export type RefreshOutcome =
  /** The index already matched the file. */
  | { readonly kind: "unchanged" }
  /** Size or mtime moved: the derived columns were cleared and a job queued. */
  | { readonly kind: "changed"; readonly ext: string; readonly adopted: boolean }
  /** Nothing has read this file yet, so there is nothing to compare against. */
  | { readonly kind: "pending" }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" }
  /** No such asset — a file another build added, which the journal fold brings in. */
  | { readonly kind: "unknown" };

/**
 * Compares one asset's file against what the index last recorded, and queues a
 * re-derive if they disagree.
 *
 * Idempotent and cheap: one `stat` when nothing has happened.
 *
 * **An asset with nothing derived yet is left alone.** Its job is already in
 * the queue; clearing columns that are already null and re-queuing would only
 * push it back down the order it is waiting in. That is also what stops this
 * chasing Roost's own writes — `saveEdit` clears and re-enqueues before the
 * filesystem event arrives, so the watcher finds nothing to do and stops.
 */
export async function refreshAsset(library: Library, id: AssetId): Promise<RefreshOutcome> {
  const known = library.db.repo.fileState(id);
  if (known === undefined) return { kind: "unknown" };

  const resolved = await resolveFile(library, id);
  if (resolved.kind === "missing") return { kind: "missing" };
  if (resolved.kind === "ambiguous") {
    log.warn("one id, two files", {
      asset: id,
      files: resolved.files.map((file) => file.ext).join(", "),
    });
    return { kind: "ambiguous" };
  }

  // Adopting the extension is worth doing even when the bytes did not move: it
  // is what stops every later resolution listing the directory again.
  if (resolved.renamed) library.db.repo.noteExt(id, resolved.ext);

  if (known.size === null || known.mtime === null) {
    return resolved.renamed
      ? { kind: "changed", ext: resolved.ext, adopted: true }
      : { kind: "pending" };
  }

  const now = await measureFile(resolved.path);
  if (now === undefined) return { kind: "missing" };
  if (now.size === known.size && now.mtime === known.mtime && !resolved.renamed) {
    return { kind: "unchanged" };
  }

  library.db.transaction(() => {
    library.db.repo.clearDerived(id);
    library.db.repo.dropThumbnails(id);
  });
  enqueueDerives(library, [id], JOB_PRIORITY.interactive);

  log.info("file changed under an asset", {
    asset: id,
    ext: resolved.ext,
    adopted: resolved.renamed,
  });
  return { kind: "changed", ext: resolved.ext, adopted: resolved.renamed };
}

export interface CatchUpReport {
  /** Files walked. */
  readonly seen: number;
  /** Assets whose bytes had moved on, and were queued again. */
  readonly changed: number;
  /** Files naming an id this library does not hold. */
  readonly unknown: number;
  readonly elapsed: number;
}

export interface CatchUpOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (report: CatchUpReport) => void;
}

/**
 * Walks `files/` and queues every asset whose bytes have moved on.
 *
 * For the edits made while Roost was closed, which no watcher can see, and for
 * the first open of a library another implementation has been writing to. It is
 * also the backstop for the watcher itself, which drops events under load on
 * every platform.
 *
 * **It must never be awaited before a window is drawn.** A million `stat` calls
 * is seconds and `CONCEPT.md` §7 puts the whole open at 1.5 s, so this runs
 * after the library is open and `signal` is what closing it aborts.
 *
 * It walks the **store** rather than the index, because the store is where the
 * news is: an id whose file was renamed is found under its new name, and a file
 * naming an id this library has never heard of is counted rather than adopted.
 */
export async function catchUp(
  library: Library,
  options: CatchUpOptions = {},
): Promise<CatchUpReport> {
  const started = Date.now();
  let seen = 0;
  let changed = 0;
  let unknown = 0;

  const report = (): CatchUpReport => ({ seen, changed, unknown, elapsed: Date.now() - started });

  for await (const file of library.storage.iterAll()) {
    if (options.signal?.aborted === true) break;
    seen += 1;

    const outcome = await refreshAsset(library, file.id);
    if (outcome.kind === "changed") changed += 1;
    else if (outcome.kind === "unknown") unknown += 1;

    // A whole library of stats would otherwise hold the engine's event loop
    // against everything the window asks for while it runs.
    if (seen % 256 === 0) {
      options.onProgress?.(report());
      await new Promise((resume) => setImmediate(resume));
    }
  }

  const final = report();
  log.info("catch-up finished", { ...final });
  options.onProgress?.(final);
  return final;
}

/** Assets read together, and committed together. */
const MEASURE_BATCH = 64;

export interface MeasureOptions {
  readonly signal?: AbortSignal;
  /** How many are left, after each batch. */
  readonly onProgress?: (left: number) => void;
}

/**
 * Reads what the index does not know about files nobody has drawn (ADR-0065).
 *
 * A rebuild and another build's journal lines bring assets in with nothing
 * derived (RL-23), and with the queue drawing only what is asked for, an asset
 * nobody looks at would have no size or hash for ever: wrong under every sort
 * by size, and invisible to an import looking for a duplicate. So this is the
 * one thing that still walks a library in the background, and **it draws
 * nothing**. It only ever has work after one of those two events.
 *
 * Pictures still true of their file are kept, for one `stat`, and their job is
 * done with (ADR-0051). A picture of a file that has since changed is queued as
 * work somebody changed. Everything else is hashed, and read for its dimensions
 * where a header has them, and stays queued to be drawn when it is seen.
 */
export async function measureUnread(library: Library, options: MeasureOptions = {}): Promise<void> {
  const { repo } = library.db;
  let left = repo.underivedCount();
  if (left === 0) return;
  options.onProgress?.(left);

  let after = "";
  for (;;) {
    if (options.signal?.aborted === true) return;
    const ids = repo.underivedAfter(after, MEASURE_BATCH);
    const last = ids.at(-1);
    if (last === undefined) break;
    after = last;

    const read = await Promise.all(ids.map((id) => readOne(library, id)));
    library.db.transaction(() => {
      const now = Math.floor(Date.now() / 1000);
      for (const one of read) {
        if (one.kind === "kept" || one.kind === "measured") {
          repo.putDerived(one.id, one.metadata, now);
        }
        if (one.kind === "kept") repo.finishJobFor("derive", one.id);
      }
    });
    enqueueDerives(
      library,
      read.filter((one) => one.kind === "changed").map((one) => one.id),
      JOB_PRIORITY.interactive,
    );

    left = Math.max(0, left - ids.length);
    options.onProgress?.(left);
    // A whole library of these would otherwise hold the engine's event loop
    // against everything the window asks for while it runs.
    await new Promise((resume) => setImmediate(resume));
  }
  options.onProgress?.(0);
}

type ReadOne =
  | { readonly kind: "kept" | "measured"; readonly id: AssetId; readonly metadata: DerivedMetadata }
  | { readonly kind: "changed" | "absent"; readonly id: AssetId };

async function readOne(library: Library, id: AssetId): Promise<ReadOne> {
  const { repo } = library.db;
  const resolved = await resolveFile(library, id);
  // Counted again at the next open, which costs a directory listing: what is
  // missing today may be back when the drive is.
  if (resolved.kind !== "found") return { kind: "absent", id };
  if (resolved.renamed) repo.noteExt(id, resolved.ext);

  try {
    const kept = await keptPictures(library, id, repo.posterOf(id), resolved.path, EAGER_SIZES);
    if (kept !== undefined) return { kind: "kept", id, metadata: kept };
    if (repo.pictureSource(id) !== undefined) return { kind: "changed", id };

    const [measured, read] = await Promise.all([
      measure(resolved.path),
      probe(resolved.path).catch(() => undefined),
    ]);
    return {
      kind: "measured",
      id,
      metadata: {
        ...measured,
        ...(read?.width === undefined ? {} : { width: read.width }),
        ...(read?.height === undefined ? {} : { height: read.height }),
      },
    };
  } catch (error) {
    log.warn("could not read a file", { asset: id, error: String(error) });
    return { kind: "absent", id };
  }
}

/**
 * Size and modification time, in the units the index stores.
 *
 * `mtimeMs` is floored to whole seconds to match what the derive pass writes
 * through `hashFile`; comparing a float against an integer would make every
 * asset look changed for ever.
 */
async function measureFile(path: string): Promise<{ size: number; mtime: number } | undefined> {
  try {
    const stats = await stat(path);
    return { size: stats.size, mtime: Math.floor(stats.mtimeMs / 1000) };
  } catch {
    return undefined;
  }
}
