import { constants } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { logger } from "../log/index.js";

const log = logger("handoff");

/**
 * Files with readable names, for handing an asset to another application
 * (ADR-0034).
 *
 * **The problem this exists for is the filename.** An asset is stored as
 * `files/K7/K7QM4X2AJH9F.jpg` — the id *is* the filename (RL-9), which is what
 * lets a name be renamed without touching the disk and is useless the moment a
 * file leaves for somewhere else. Dropping `K7QM4X2AJH9F.jpg` into a chat
 * window or a design tool hands somebody a name they cannot read and cannot
 * search for.
 *
 * So a copy is made under the name the library shows, in a staging directory
 * **inside the library** — which is not an arbitrary choice: a reflink only
 * works within one filesystem, and `/tmp` is routinely a different one.
 *
 * **Reflink, then copy. Never a hardlink** (RL-26): a hardlink shares an inode,
 * so an application that writes to the file it was given would be writing into
 * the library's own file. That an asset's bytes may be edited is ordinary in
 * version 2 (RL-20) — what must not happen is that they are edited by somebody
 * who thinks they were handed a copy.
 */

/**
 * Where the named copies go, inside the library.
 *
 * Named in the format's published layout and explicitly **not part of it**
 * (RL-2): it is transient, and another implementation may spell it differently
 * or not have one at all. What binds is RL-3 — the library root is a reserved
 * namespace, and this is one of the names reserved in it.
 */
export const STAGING_DIR = "staging";

/** How many suffixed names to try before giving up on one asset. */
const MAX_SUFFIX = 999;

/**
 * A filename for an asset, from the name the library shows.
 *
 * `basename` is not cosmetic: the name is user-authored, and one reading
 * `../../.bashrc` would otherwise make a handoff a way to write outside the
 * directory that was chosen. The extension is restored when a rename has lost
 * it, because a file the desktop cannot open is not a file anybody can use.
 *
 * Shared with `exportAssets`, which asks the same question about the same
 * names: two implementations of this rule is one of them being subtly wrong.
 */
export function fileNameFor(name: string, ext: string): string {
  const clean = basename(name).trim();
  if (clean === "" || clean === "." || clean === "..") return ext === "" ? "asset" : `asset.${ext}`;
  if (ext !== "" && extname(clean).toLowerCase() !== `.${ext}`) return `${clean}.${ext}`;
  return clean;
}

/**
 * Puts a named copy of `source` in the library's staging directory.
 *
 * Returns the path handed over, and whether the bytes were actually copied —
 * which is the number worth reporting: on a copy-on-write filesystem this costs
 * nothing at all, and on ext4 or NTFS it is the whole file.
 */
export async function stageFile(
  root: string,
  source: string,
  name: string,
): Promise<{ path: string; copied: boolean }> {
  const directory = join(root, STAGING_DIR);
  await mkdir(directory, { recursive: true });

  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);

  for (let attempt = 0; attempt <= MAX_SUFFIX; attempt += 1) {
    const path = join(directory, attempt === 0 ? name : `${stem} (${attempt})${ext}`);
    try {
      // `EXCL` rather than "check then write": between the check and the write
      // is where a second handoff of the same selection overwrites the first,
      // and the first may still be being read by whoever it was given to.
      await copyFile(source, path, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL);
      return { path, copied: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      // `ENOTSUP` on a filesystem without copy-on-write, `EXDEV` across two.
      // Both are ordinary answers rather than failures (ADR-0012).
      try {
        await copyFile(source, path, constants.COPYFILE_EXCL);
        return { path, copied: true };
      } catch (fallback) {
        if ((fallback as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw fallback;
      }
    }
  }
  throw new Error(`no free name for ${name} after ${MAX_SUFFIX} tries`);
}

/**
 * Empties the staging directory.
 *
 * Called when a library opens rather than when it closes, and never while one
 * is in use: a file handed to another application may still be being read long
 * after the gesture that produced it, and a clipboard reference outlives the
 * session that wrote it. Sweeping at open is the moment nothing can still be
 * waiting for these — whoever wanted them has had them.
 *
 * Failure is logged and swallowed. A staging directory that could not be
 * emptied is wasted space, and refusing to open a library over wasted space
 * would be the worse bargain.
 */
export async function sweepStaging(root: string): Promise<number> {
  const directory = join(root, STAGING_DIR);
  let swept = 0;
  try {
    for (const entry of await readdir(directory)) {
      await rm(join(directory, entry), { recursive: true, force: true });
      swept += 1;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    log.warn("the staging directory could not be emptied", {
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
  return swept;
}
