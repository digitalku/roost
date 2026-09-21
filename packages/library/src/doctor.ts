import { stat } from "node:fs/promises";
import { type AssetId, MATCH_ALL, strayFilesIn } from "@roost/core";
import { hashFile } from "@roost/media";
import { UnsoundReclaimError } from "./error.js";
import type { Library } from "./library.js";
import { pages } from "./search.js";

/**
 * Checking a library against itself.
 *
 * Roost keeps three copies of the truth: the journal, the index, and the bytes
 * under `files/`. `roost rebuild` already proves the first two agree — delete
 * the index, replay, compare. Nothing checks the third, so a file with no row
 * or a row with no file could sit there indefinitely, one wasting space and the
 * other losing an asset.
 *
 * **What version 2 took away, and it is worth stating rather than discovering.**
 * Version 1 named every file by the hash of its contents, so a file that no
 * longer hashed to its name was provably damaged. Here the bytes are allowed to
 * change under an unchanged id (RL-20) and an edit is journalled nowhere
 * (RL-23) — so bit rot, a bad sync and a person editing their own file are
 * indistinguishable, and **no implementation can promise to detect corruption**
 * (`SPEC.md` §5). A deep run still reads every file; what it reports is that
 * the bytes *changed*, which is a reason to derive them again rather than an
 * accusation.
 *
 * Every check streams. A million-asset library must not need a million paths
 * resident to be verified, so files are looked up one at a time by primary key
 * and index rows are walked by keyset page.
 */

/** How many index rows are examined per page. */
export const DOCTOR_PAGE = 512;

/** A file under `files/` named for an asset that no row claims. */
export interface Orphan {
  readonly id: AssetId;
  readonly ext: string;
  readonly path: string;
  readonly bytes: number;
}

/**
 * A file under `files/` whose name is not an id (RL-11).
 *
 * Word leaves `~$laporan.docx` beside the document it opened, and an editor
 * that crashed leaves a temporary file behind. Neither is adopted as an asset
 * and neither is deleted automatically — RL-11 forbids both, because deleting
 * them would put Roost in the business of guessing which of somebody's files
 * are rubbish. Reporting them is the whole of what it asks.
 */
export interface Unrecognised {
  readonly path: string;
  readonly bytes: number;
}

/** An asset row whose file is not where the id says it should be (RL-25). */
export interface Missing {
  readonly id: AssetId;
  readonly name: string;
  readonly expected: string;
}

/**
 * One id with more than one file (RL-12).
 *
 * The rule is that an id has exactly one, and an implementation finding two
 * MUST report it and MUST NOT choose between them. It happens when an
 * application saves a document under a second extension and something renamed
 * the wrong one, or when two builds disagreed about RL-9b.
 */
export interface Ambiguous {
  readonly id: AssetId;
  readonly paths: readonly string[];
}

/** A file whose bytes are no longer the bytes the index last derived from. */
export interface Changed {
  readonly id: AssetId;
  readonly path: string;
  /** What the last derive recorded, or `null` if nothing has read it. */
  readonly derivedHash: string | null;
  readonly actualHash: string;
}

export interface DoctorReport {
  readonly assets: number;
  readonly files: number;
  /** Files present with no asset row. Reclaimable. */
  readonly orphans: Orphan[];
  /** Files whose names are not ids. Reported, never deleted (RL-11). */
  readonly unrecognised: Unrecognised[];
  /** Assets whose file is gone. **This is data loss.** */
  readonly missingFiles: Missing[];
  /** Ids with more than one file (RL-12). */
  readonly ambiguous: Ambiguous[];
  /**
   * Files whose bytes differ from what the index derived. Only ever populated
   * by a deep run, and **not** an accusation of damage — see the note at the
   * top of this module.
   */
  readonly changed: Changed[];
  /**
   * Full-text rows for assets that no longer exist. `assets_fts` is a virtual
   * table with no foreign keys, so nothing cascades for it.
   */
  readonly orphanSearchRows: number;
  /** Files in `journal/` that replay will not read. */
  readonly strayJournalFiles: string[];
  /** True when the run re-hashed every file. */
  readonly deep: boolean;
  readonly elapsedMs: number;
}

/** Total size of the files nothing references. */
export function reclaimableBytes(report: DoctorReport): number {
  return report.orphans.reduce((total, orphan) => total + orphan.bytes, 0);
}

/**
 * Whether anything found would lose data if left alone.
 *
 * Orphans are not damage, only waste: they cost space and nothing else. A
 * missing file is an asset the library can no longer show. A changed file is
 * neither — it is the ordinary result of somebody editing their own work, and a
 * build that called it damage would be crying wolf at the product's main
 * feature.
 */
export function hasDamage(report: DoctorReport): boolean {
  return (
    report.missingFiles.length > 0 ||
    report.ambiguous.length > 0 ||
    report.orphanSearchRows > 0 ||
    report.strayJournalFiles.length > 0
  );
}

export function isClean(report: DoctorReport): boolean {
  return !hasDamage(report) && report.orphans.length === 0 && report.unrecognised.length === 0;
}

/**
 * Why this report is not a safe basis for deleting anything, if it is not.
 *
 * An orphan is only an orphan relative to the index, so reclaiming acts on the
 * index's word. Each finding listed here says the index and the disk disagree
 * about what exists — and once they disagree, "nothing references these bytes"
 * may simply be the index being wrong.
 */
export function unsoundForReclaim(report: DoctorReport): string | undefined {
  const reasons: string[] = [];
  if (report.missingFiles.length > 0) {
    reasons.push(`${report.missingFiles.length} asset(s) point at bytes that are not there`);
  }
  if (report.ambiguous.length > 0) {
    reasons.push(`${report.ambiguous.length} id(s) have more than one file`);
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
export type DoctorStage = "files" | "rows";

export interface DoctorOptions {
  /**
   * Re-hash every file and compare the result to what the index derived.
   *
   * It costs a full read of the library, so it is opt-in — and what it finds is
   * *different bytes*, never *damaged bytes*: the two are indistinguishable in
   * version 2, and this module says so rather than letting a reader assume
   * otherwise.
   */
  readonly deep?: boolean;
  readonly onProgress?: (stage: DoctorStage, count: number) => void;
}

/** Runs every check. */
export async function check(library: Library, options: DoctorOptions = {}): Promise<DoctorReport> {
  const started = performance.now();
  const deep = options.deep === true;
  const onProgress = options.onProgress ?? (() => {});

  const storage = library.storage;
  const orphans: Orphan[] = [];
  const unrecognised: Unrecognised[] = [];
  const changed: Changed[] = [];
  const missingFiles: Missing[] = [];
  const ambiguous: Ambiguous[] = [];
  let files = 0;

  /** Every path seen per id, for RL-12. */
  const seen = new Map<AssetId, string[]>();

  // Pass one: every file on disk, checked against the index.
  for await (const file of storage.iterAll()) {
    files += 1;
    seen.set(file.id, [...(seen.get(file.id) ?? []), file.path]);

    const detail = library.db.repo.assetDetail(file.id);
    if (detail === undefined) {
      orphans.push({
        id: file.id,
        ext: file.ext,
        path: file.path,
        bytes: await sizeOf(file.path),
      });
    } else if (deep) {
      const actual = await hashFile(file.path).catch(() => undefined);
      if (actual !== undefined && actual.hash !== detail.contentHash) {
        changed.push({
          id: file.id,
          path: file.path,
          derivedHash: detail.contentHash,
          actualHash: actual.hash,
        });
      }
    }

    if (files % 500 === 0) onProgress("files", files);
  }

  for (const [id, paths] of seen) {
    if (paths.length > 1) ambiguous.push({ id, paths: [...paths].sort() });
  }

  // Pass two: every file in the store whose name is not an id (RL-11).
  for await (const path of storage.iterUnrecognised()) {
    unrecognised.push({ path, bytes: await sizeOf(path) });
  }

  // Pass three: every index row, checked against the disk.
  let rows = 0;
  for (const page of pages(library, "", DOCTOR_PAGE)) {
    for (const hit of page) {
      const found = await checkRow(library, hit.id);
      if (found !== undefined) missingFiles.push(found);
    }
    rows += page.length;
    onProgress("rows", rows);
  }

  return {
    assets: library.db.repo.count(MATCH_ALL),
    files,
    orphans,
    unrecognised,
    missingFiles,
    ambiguous,
    changed,
    orphanSearchRows: library.db.repo.orphanSearchRows(),
    strayJournalFiles: await strayFilesIn(library.journal.dir),
    deep,
    elapsedMs: performance.now() - started,
  };
}

/** Checks that one asset's file is where the id says it is. */
async function checkRow(library: Library, id: AssetId): Promise<Missing | undefined> {
  const summary = library.db.repo.findAsset(id);
  if (summary === undefined) return undefined;

  const expected = library.storage.locate(id, summary.ext);
  if (await isFile(expected)) return undefined;
  return { id, name: summary.name, expected };
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
    // The file was there a moment ago when the walk yielded it. Reporting it as
    // zero bytes keeps it visible, which is what matters.
    return 0;
  }
}

/** Whether {@link reclaim} may act on a report that found damage. */
export const RECLAIM_MODES = ["only-if-sound", "even-if-damaged"] as const;
export type ReclaimMode = (typeof RECLAIM_MODES)[number];

/**
 * Deletes the files nothing references, returning how many bytes came back.
 *
 * Separate from {@link check} and never automatic. Under `only-if-sound` — the
 * default, and the only mode to reach for without thinking — this refuses when
 * {@link unsoundForReclaim} says the index cannot be trusted, and the answer is
 * `roost rebuild`.
 *
 * **Only orphans**, never a file whose name is not an id: RL-11 forbids
 * deleting those automatically, and a maintenance command a person ran is still
 * automatic as far as that file is concerned — nobody chose *it*.
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

  const storage = library.storage;
  let freed = 0;
  for (const orphan of report.orphans) {
    await storage.remove(orphan.id, orphan.ext);
    freed += orphan.bytes;
  }
  return freed;
}
