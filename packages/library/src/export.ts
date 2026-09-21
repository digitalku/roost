import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { type AssetId, fileNameFor, logger } from "@roost/core";
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
 * the user chose the directory, and nothing inside the library is read for
 * anything but its bytes. No file under `files/` is moved, modified or removed.
 *
 * Assets are exported under the name the library shows for them, joined to the
 * extension on disk — the store's naming is an implementation detail
 * (invariant 3), and a folder of ids is not an export anyone wanted. Where
 * two assets carry the same name, the second gets a numbered suffix and the
 * report says how many that happened to.
 */
export async function exportAssets(
  library: Library,
  assets: readonly AssetId[],
  destination: string,
): Promise<ExportReport> {
  await mkdir(destination, { recursive: true });

  let exported = 0;
  let renamed = 0;
  let missing = 0;
  let failed = 0;

  for (const id of assets) {
    const summary = library.db.repo.findAsset(id);
    if (summary === undefined) {
      missing += 1;
      continue;
    }

    const source = library.storage.locate(id, summary.ext);

    try {
      const outcome = await copyOut(source, destination, fileNameFor(summary.name, summary.ext));
      exported += 1;
      if (outcome === "renamed") renamed += 1;
    } catch (error) {
      // A missing source is the expected failure — an asset whose file is gone
      // (RL-25) — and it is not the same thing as a full disk, so the two are
      // counted apart even though neither stops the run.
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
