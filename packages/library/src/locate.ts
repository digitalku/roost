import { stat } from "node:fs/promises";
import { type AssetId, logger, parseAssetId, type StoredFile } from "@roost/core";
import { extensionOf, formatFromExtension, namesTheFile, sniffFile } from "@roost/media";
import type { Library } from "./library.js";

/**
 * Finding an asset's file when its name is no longer the one we journalled
 * (ADR-0047 §3).
 *
 * RL-9b makes the extension a fact about the **file** rather than about the
 * asset: an application saving a `.docx` as a `.pdf` leaves the same asset
 * under a different name, and the implementation that notices renames the file
 * and journals nothing. `ops/REGISTRY.md` states the consequence for readers —
 * `add`'s `ext` is journalled only so that the file can be found without
 * listing a directory, and *"an implementation that cannot find `<id>.<ext>`
 * looks for `<id>.*` and takes the one file RL-12 allows"*.
 *
 * Its own module, and not part of `jobs.ts` or `refresh.ts`, because both of
 * those need it and importing each other would be a cycle.
 */

const log = logger("locate");

/**
 * Where an asset's file is, and what extension it actually has.
 *
 * `ext` is deliberately not the caller's: it is the answer after looking rather
 * than the question that was asked.
 */
export interface Located {
  readonly kind: "found";
  readonly path: string;
  readonly ext: string;
  /** The file was found under a different extension than the index held. */
  readonly renamed: boolean;
}

/** RL-25: the row keeps everything the person wrote, and says so. */
export interface FileMissing {
  readonly kind: "missing";
}

/** RL-12: two files for one id. Reported, never chosen between. */
export interface FileAmbiguous {
  readonly kind: "ambiguous";
  readonly files: readonly StoredFile[];
}

export type Resolution = Located | FileMissing | FileAmbiguous;

/**
 * Finds an asset's file, falling back to `<id>.*` when the journalled
 * extension no longer names it.
 *
 * Without the fallback, an asset any implementation renamed under RL-9b is
 * reported missing for ever, with its file sitting in the same directory.
 *
 * The ordinary path is one `stat` and no directory listing, which is what keeps
 * this affordable everywhere a path is needed.
 */
export async function resolveFile(library: Library, id: AssetId): Promise<Resolution> {
  const record = library.db.repo.findFile(id);
  if (record === undefined) return { kind: "missing" };

  const expected = library.storage.locate(id, record.ext);
  if (await isFile(expected)) {
    return { kind: "found", path: expected, ext: record.ext, renamed: false };
  }

  const found = await library.storage.findFiles(id);
  if (found.length === 0) return { kind: "missing" };
  if (found.length > 1) return { kind: "ambiguous", files: found };

  // The length is exactly one; `noUncheckedIndexedAccess` cannot see that.
  const only = found[0] as StoredFile;
  return { kind: "found", path: only.path, ext: only.ext, renamed: true };
}

/**
 * Renames an asset's file when its bytes are no longer the type its extension
 * claims, and records the new extension (RL-9b).
 *
 * Returns where the file is afterwards, which is unchanged in every case but
 * the rename. Journals nothing, by requirement.
 *
 * **The rule is deliberately conservative**, because the obvious one destroys
 * data. `.docx`, `.xlsx` and `.epub` are ZIP files and `.nef`, `.arw` and `.dng`
 * are TIFF files, so a rule of *"rename when the sniffed format is not what the
 * extension says"* renames every Word document in a library to `.zip` and every
 * Nikon photograph to `.tiff`, on their first derive. So a rename needs all
 * four:
 *
 * 1. the sniffed format is evidence at all — not `unknown`, and not one of the
 *    two containers other formats wear, `zip` and `tiff` ({@link namesTheFile});
 * 2. this build has a conventional extension for it;
 * 3. it disagrees with what the current extension names — which is `unknown`
 *    for `docx`, so a Word document saved as a PDF *is* renamed while one still
 *    a Word document is not;
 * 4. the name would actually change.
 *
 * Everything else keeps the extension the user or the importer chose, which is
 * the right failure: a wrong extension is a cosmetic problem and a renamed
 * document is somebody's afternoon.
 */
export async function alignExtension(
  library: Library,
  id: AssetId,
  ext: string,
  path: string,
): Promise<{ path: string; ext: string; renamed: boolean }> {
  const sniffed = await sniffFile(path);
  if (!namesTheFile(sniffed)) return { path, ext, renamed: false };

  const wanted = extensionOf(sniffed);
  if (wanted === undefined || wanted === ext) return { path, ext, renamed: false };
  if (formatFromExtension(ext) === sniffed) return { path, ext, renamed: false };

  const moved = await library.storage.rename(id, ext, wanted);
  library.db.repo.noteExt(id, wanted);
  log.info("the file is no longer the type its name claimed", {
    asset: id,
    was: ext,
    now: wanted,
  });
  return { path: moved, ext: wanted, renamed: true };
}

/** Parses `files/<shard>/<id>.<ext>` back to an id, or nothing. */
export function idFromPath(path: string): AssetId | undefined {
  const name = path.split(/[\\/]/).pop();
  if (name === undefined) return undefined;
  const stem = name.split(".")[0];
  if (stem === undefined) return undefined;
  try {
    return parseAssetId(stem);
  } catch {
    // A lock file an application left beside the document it opened (RL-11).
    return undefined;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
