import { stat } from "node:fs/promises";
import { type ContentHash, MATCH_ALL, strayFilesIn } from "@roost/core";
import { hashFile } from "@roost/media";
import { UnsoundReclaimError } from "./error.js";
import type { Library } from "./library.js";
import { pages } from "./search.js";

/**
 * Checking a library against itself.
 *
 * Roost keeps three copies of the truth: the journal, the index, and the bytes
 * under `originals/`. `roost rebuild` already proves the first two agree —
 * delete the index, replay, compare. Nothing checked the third, so an object
 * with no row or a row with no object could sit there indefinitely, one wasting
 * space and the other losing an asset.
 *
 * Every check streams. A million-asset library must not need a million paths
 * resident to be verified, so objects are looked up one at a time by primary
 * key and index rows are walked by keyset page.
 */

/** How many index rows are examined per page. */
export const DOCTOR_PAGE = 512;

/** An object under `originals/` that no asset row claims. */
export interface Orphan {
  readonly hash: ContentHash;
  readonly ext: string;
  readonly path: string;
  readonly bytes: number;
}

/** An asset row whose bytes are not where they should be. */
export interface Missing {
  readonly hash: ContentHash;
  readonly origName: string;
  /** Under `originals/`, or the user's own path in referenced mode. */
  readonly expected: string;
  readonly referenced: boolean;
}

/** An object whose contents no longer hash to its filename. */
export interface Corrupt {
  readonly expectedHash: string;
  readonly actualHash: string;
  readonly path: string;
}

export interface DoctorReport {
  readonly assets: number;
  readonly objects: number;
  /** Bytes present with no asset row. Reclaimable. */
  readonly orphans: Orphan[];
  /** Managed assets whose object is gone. **This is data loss.** */
  readonly missingObjects: Missing[];
  /** Referenced assets whose original moved or was deleted. */
  readonly missingReferences: Missing[];
  /** Only ever populated by a deep run. */
  readonly corrupt: Corrupt[];
  /**
   * Full-text rows for assets that no longer exist. `assets_fts` is a virtual
   * table with no foreign keys, so nothing cascades for it.
   */
  readonly orphanSearchRows: number;
  /** Files in `journal/` that replay will not read. */
  readonly strayJournalFiles: string[];
  /** True when the run re-hashed every object. */
  readonly deep: boolean;
  readonly elapsedMs: number;
}

/** Total size of the objects nothing references. */
export function reclaimableBytes(report: DoctorReport): number {
  return report.orphans.reduce((total, orphan) => total + orphan.bytes, 0);
}

/**
 * Whether anything found would lose data if left alone.
 *
 * Orphans are not damage, only waste: they cost space and nothing else. A
 * missing object is an asset the library can no longer show.
 */
export function hasDamage(report: DoctorReport): boolean {
  return (
    report.missingObjects.length > 0 ||
    report.missingReferences.length > 0 ||
    report.corrupt.length > 0 ||
    report.orphanSearchRows > 0 ||
    report.strayJournalFiles.length > 0
  );
}

export function isClean(report: DoctorReport): boolean {
  return !hasDamage(report) && report.orphans.length === 0;
}

/**
 * Why this report is not a safe basis for deleting anything, if it is not.
 *
 * An orphan is only an orphan relative to the index, so reclaiming acts on the
 * index's word. Each finding listed here says the index and the object store
 * disagree about what exists — and once they disagree, "nothing references
 * these bytes" may simply be the index being wrong.
 *
 * A missing *referenced* original is deliberately not one of them. It says the
 * user moved or deleted their own file, which is about their filesystem and not
 * about whether the index can be trusted. Counting it would also make the block
 * permanent: no rebuild brings back a file someone meant to delete.
 */
export function unsoundForReclaim(report: DoctorReport): string | undefined {
  const reasons: string[] = [];
  if (report.missingObjects.length > 0) {
    reasons.push(`${report.missingObjects.length} asset(s) point at bytes that are not there`);
  }
  if (report.corrupt.length > 0) {
    reasons.push(`${report.corrupt.length} object(s) no longer match their hash`);
  }
  if (report.orphanSearchRows > 0) {
    reasons.push(`${report.orphanSearchRows} search row(s) belong to assets that are gone`);
  }
  if (report.strayJournalFiles.length > 0) {
    // A month replay cannot see is a month the index does not contain, which
    // makes every asset in it look like an orphan.
    reasons.push(`${report.strayJournalFiles.length} file(s) in journal/ that replay will skip`);
  }
  return reasons.length === 0 ? undefined : reasons.join("; ");
}

/** Which pass a run is in, for progress reporting. */
export type DoctorStage = "objects" | "rows";

export interface DoctorOptions {
  /**
   * Re-hash every object and compare the result to its filename.
   *
   * The only check that detects silent corruption — a bit flip, a bad cable, a
   * filesystem without checksums — and it costs a full read of the library, so
   * it is opt-in.
   */
  readonly deep?: boolean;
  readonly onProgress?: (stage: DoctorStage, count: number) => void;
}

/** Runs every check. */
export async function check(library: Library, options: DoctorOptions = {}): Promise<DoctorReport> {
  const started = performance.now();
  const deep = options.deep === true;
  const onProgress = options.onProgress ?? (() => {});

  const storage = library.storageFor("managed");
  const orphans: Orphan[] = [];
  const corrupt: Corrupt[] = [];
  const missingObjects: Missing[] = [];
  const missingReferences: Missing[] = [];
  let objects = 0;

  // Pass one: every object on disk, checked against the index.
  for await (const file of storage.iterAll()) {
    objects += 1;

    if (library.db.repo.findAsset(file.hash) === undefined) {
      orphans.push({
        hash: file.hash,
        ext: file.ext,
        path: file.path,
        bytes: await sizeOf(file.path),
      });
    } else if (deep) {
      const actual = await hashFile(file.path);
      if (actual.hash !== file.hash) {
        corrupt.push({ expectedHash: file.hash, actualHash: actual.hash, path: file.path });
      }
    }

    if (objects % 500 === 0) onProgress("objects", objects);
  }

  // Pass two: every index row, checked against the disk.
  let rows = 0;
  for (const page of pages(library, "", DOCTOR_PAGE)) {
    for (const hit of page) {
      const found = await checkRow(library, hit.hash);
      if (found === undefined) continue;
      if (found.referenced) missingReferences.push(found);
      else missingObjects.push(found);
    }
    rows += page.length;
    onProgress("rows", rows);
  }

  return {
    assets: library.db.repo.count(MATCH_ALL),
    objects,
    orphans,
    missingObjects,
    missingReferences,
    corrupt,
    orphanSearchRows: library.db.repo.orphanSearchRows(),
    strayJournalFiles: await strayFilesIn(library.journal.dir),
    deep,
    elapsedMs: performance.now() - started,
  };
}

/** Checks that one asset's bytes are where the index says they are. */
async function checkRow(library: Library, hash: ContentHash): Promise<Missing | undefined> {
  const detail = library.db.repo.assetDetail(hash);
  if (detail === undefined) return undefined;

  const referenced = detail.storageMode === "referenced";
  // A referenced asset's path is the user's own and cannot be derived; a row
  // without one is nothing this check can look for.
  if (referenced && detail.refPath === null) return undefined;

  const expected = referenced
    ? (detail.refPath ?? "")
    : library.storageFor("managed").locate(hash, detail.ext);

  if (await isFile(expected)) return undefined;
  return { hash, origName: detail.origName, expected, referenced };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    // The object was there a moment ago when the walk yielded it. Reporting it
    // as zero bytes keeps the orphan visible, which is what matters.
    return 0;
  }
}

/** Whether {@link reclaim} may act on a report that found damage. */
export const RECLAIM_MODES = ["only-if-sound", "even-if-damaged"] as const;
export type ReclaimMode = (typeof RECLAIM_MODES)[number];

/**
 * Deletes the objects nothing references, returning how many bytes came back.
 *
 * Separate from {@link check} and never automatic. Under `only-if-sound` — the
 * default, and the only mode to reach for without thinking — this refuses when
 * {@link unsoundForReclaim} says the index cannot be trusted, and the answer is
 * `roost rebuild`.
 *
 * The deletion is permanent: an orphan is by definition not in the journal, so
 * no rebuild brings it back.
 */
export async function reclaim(
  library: Library,
  report: DoctorReport,
  mode: ReclaimMode = "only-if-sound",
): Promise<number> {
  if (mode === "only-if-sound") {
    const reason = unsoundForReclaim(report);
    if (reason !== undefined) throw new UnsoundReclaimError(reason);
  }

  const storage = library.storageFor("managed");
  let freed = 0;
  for (const orphan of report.orphans) {
    await storage.remove(orphan.hash, orphan.ext);
    freed += orphan.bytes;
  }
  return freed;
}
