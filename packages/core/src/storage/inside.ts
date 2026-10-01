import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { IoError } from "../model/index.js";

/**
 * Making a directory inside a library, and never above it (ADR-0056 §3.4).
 *
 * `mkdir -p` builds every missing directory on the way, and that includes the
 * library's root. So a library renamed while it is open had its old path
 * recreated by the first import after the rename: the file went into a new
 * `traveling.roost/files/K7/` while its journal line went to `trip.roost`, and
 * the next open found the asset missing beside a folder that was not a
 * library. These make one level at a time, starting from a root that must
 * already be there, so a root that has gone fails with `ENOENT` and nothing
 * appears in its place.
 *
 * Creating a library is the one place a root is made, and it does not come
 * through here.
 */

/** Makes `directory`, and whatever lies between it and `root`, but never `root`. */
export async function makeDirectoryInside(root: string, directory: string): Promise<void> {
  let current = root;
  for (const segment of segmentsBelow(root, directory)) {
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (cause) {
      if (!exists(cause)) throw new IoError("mkdir", current, cause);
    }
  }
}

/** {@link makeDirectoryInside}, for the one caller that cannot await: opening the index. */
export function makeDirectoryInsideSync(root: string, directory: string): void {
  let current = root;
  for (const segment of segmentsBelow(root, directory)) {
    current = join(current, segment);
    try {
      mkdirSync(current);
    } catch (cause) {
      if (!exists(cause)) throw new IoError("mkdir", current, cause);
    }
  }
}

function segmentsBelow(root: string, directory: string): string[] {
  const path = relative(root, directory);
  if (path === "") return [];
  // A caller asking for a directory outside the library is a bug in the
  // caller, and quietly making it would be the very thing this module exists
  // to stop.
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error(`${directory} is not inside ${root}`);
  }
  return path.split(sep);
}

function exists(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException).code === "EEXIST";
}
