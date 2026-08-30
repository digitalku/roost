import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { type ContentHash, logger } from "@roost/core";
import type { Library } from "./library.js";

/**
 * How many suffixed names to try before giving up on one asset.
 *
 * A destination already holding `photo (1..64).jpg` is a person exporting the
 * same selection over and over, not a collision to keep resolving. Failing is
 * more useful than writing a sixty-fifth copy nobody asked for.
 */
const MAX_COLLISIONS = 64;

const log = logger("export");

export interface ExportReport {
  readonly exported: number;
  readonly renamed: number;
  readonly missing: number;
  readonly failed: number;
}

/**
 * Copies assets' originals into a directory outside the library.
 *
 * The only place this project writes into a user's own directory, and it does
 * so under two conditions that make it the opposite of the pattern
 * `STORAGE_SPEC.md` forbids: the user chose the directory, and nothing inside
 * the library is read for anything but its bytes. No original is moved,
 * modified, or removed, and a `referenced` asset is copied from where it lives
 * rather than being touched.
 *
 * Assets are exported under the name the library shows for them, not under the
 * content-addressed filename — the store's naming is an implementation detail
 * (invariant 3), and a folder of hashes is not an export anyone wanted. Where
 * two assets carry the same name, the second gets a numbered suffix and the
 * report says how many that happened to.
 */
export async function exportAssets(
  library: Library,
  assets: readonly ContentHash[],
  destination: string,
): Promise<ExportReport> {
  await mkdir(destination, { recursive: true });

  let exported = 0;
  let renamed = 0;
  let missing = 0;
  let failed = 0;

  for (const hash of assets) {
    const record = library.db.repo.findOriginal(hash);
    const summary = library.db.repo.findAsset(hash);
    if (record === undefined || summary === undefined) {
      missing += 1;
      continue;
    }

    const source =
      record.storageMode === "referenced"
        ? record.refPath
        : library.storageFor("managed").locate(hash, record.ext);
    if (source === null) {
      missing += 1;
      continue;
    }

    try {
      const outcome = await copyOut(source, destination, exportName(summary.origName, record.ext));
      exported += 1;
      if (outcome === "renamed") renamed += 1;
    } catch (error) {
      // A missing source is the expected failure — a `referenced` original the
      // user moved — and it is not the same thing as a full disk, so the two
      // are counted apart even though neither stops the run.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") missing += 1;
      else {
        failed += 1;
        log.warn("an asset could not be exported", {
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }
  }

  return { exported, renamed, missing, failed };
}

/**
 * The filename to write.
 *
 * `basename` is not cosmetic: the name is user-authored, and a name of
 * `../../.bashrc` would otherwise make an export a way to write outside the
 * directory the user picked.
 */
function exportName(name: string, ext: string): string {
  const clean = basename(name).trim();
  if (clean === "" || clean === "." || clean === "..") return ext === "" ? "asset" : `asset.${ext}`;
  // A rename in the library does not have to keep the extension, and an
  // exported file that the desktop cannot open is not an export.
  if (ext !== "" && extname(clean).toLowerCase() !== `.${ext}`) return `${clean}.${ext}`;
  return clean;
}

/**
 * Copies to the first free name, and says whether that was the one asked for.
 *
 * `COPYFILE_EXCL` rather than "check then write": between the check and the
 * write is where a second export of the same selection overwrites the first.
 */
async function copyOut(
  source: string,
  destination: string,
  name: string,
): Promise<"exported" | "renamed"> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);

  for (let attempt = 1; attempt <= MAX_COLLISIONS; attempt += 1) {
    const candidate = attempt === 1 ? name : `${stem} (${attempt})${ext}`;
    try {
      await copyFile(source, join(destination, candidate), constants.COPYFILE_EXCL);
      return attempt === 1 ? "exported" : "renamed";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  throw new Error(`${name}: the destination already holds ${MAX_COLLISIONS} copies`);
}
