import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, rename, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { IoError, logger } from "@roost/core";
import { LibraryNameTakenError } from "./error.js";
import { readManifest, writeManifest } from "./manifest.js";
import { libraryDirectory, libraryNameFromPath } from "./naming.js";

/**
 * Renaming a library, and noticing when somebody else did (ADR-0056).
 *
 * **The folder is the name** (RL-7b). `traveling.roost` is *traveling*, and
 * renaming the folder in a file manager is a complete rename. `name` in
 * `library.json` records what Roost last called it and nothing reads it for
 * display, so the two disagreeing is the ordinary result of that rename and
 * never something to repair.
 */

const log = logger("rename");

/**
 * Where renaming the library at `root` to `name` would put it, or `undefined`
 * when the name is the one it already has.
 *
 * Asked **before** the library is closed, so that a name the filesystem will
 * not take, or one a neighbour already has, is refused while the library is
 * still open in front of the person who asked.
 */
export async function renameTarget(root: string, name: string): Promise<string | undefined> {
  const from = resolve(root);
  const to = libraryDirectory(dirname(from), name);
  if (to === from) return undefined;

  let existing: Stats;
  try {
    existing = await lstat(to);
  } catch {
    return to;
  }
  // A change of case on a filesystem that ignores case finds the library
  // itself under the new spelling. That is the rename, not a neighbour.
  const self = await stat(from);
  if (existing.dev === self.dev && existing.ino === self.ino) return to;
  throw new LibraryNameTakenError(to);
}

/**
 * Renames the **closed** library at `root` to `name`, and returns where it is
 * now. A name it already has returns `root` and touches nothing.
 *
 * The directory first and `library.json` second. A crash between the two
 * leaves a renamed library whose `name` is stale, which RL-7b makes harmless;
 * the other order would leave a library that says it is called something its
 * folder is not, with the rename still to do.
 *
 * The library must not be open in this process, or anywhere: a rename under an
 * open descriptor succeeds on Linux and is refused on Windows, and the engine
 * closes first so that this does not depend on which one it runs on.
 */
export async function renameLibrary(root: string, name: string): Promise<string> {
  const to = await renameTarget(root, name);
  if (to === undefined) return root;

  try {
    await rename(root, to);
  } catch (cause) {
    throw new IoError("rename", root, cause);
  }

  // Informative only, and so not worth failing a rename that has happened:
  // a library whose `name` could not be written is still renamed (RL-7b).
  try {
    const manifest = await readManifest(to);
    const shown = libraryNameFromPath(to);
    if (manifest.name !== shown) await writeManifest(to, { ...manifest, name: shown });
  } catch (cause) {
    log.warn("renamed the library but could not record the name in library.json", {
      reason: String(cause),
    });
  }
  return to;
}

/** Which directory a library's root was when it was opened. */
interface Identity {
  readonly dev: number;
  readonly ino: number;
}

/** How often the root is looked at. One `stat`, so a second costs nothing. */
export const ROOT_POLL_MS = 1000;

export interface RootWatchOptions {
  /** `library.json`'s id, to confirm that a directory found by its inode is the library. */
  readonly id: string;
  /** Called once, with the new path where the old parent still holds it. */
  readonly onLost: (movedTo: string | undefined) => void;
  readonly intervalMs?: number;
}

export interface RootWatcher {
  close(): void;
}

/**
 * Watches for the library's own directory leaving its path: renamed, moved,
 * or its drive taken away (ADR-0056 §3.4).
 *
 * **A poll, not an event.** A watch on the root wakes on every write to
 * `index.db-wal`, which is every edit and every thumbnail; a watch on the
 * parent misses a rename of anything above it. A second is the most this takes
 * to notice, and `makeDirectoryInside` is what makes that second safe: nothing
 * can recreate the old path in the meantime.
 *
 * The comparison is the device and inode recorded at the start, so a new,
 * empty directory made at the old path, or the empty mount point an unplugged
 * drive leaves behind, counts as lost too.
 */
export async function watchRoot(root: string, options: RootWatchOptions): Promise<RootWatcher> {
  const recorded = await stat(root);
  const identity: Identity = { dev: recorded.dev, ino: recorded.ino };

  let closed = false;
  let checking = false;
  const timer = setInterval(() => {
    if (closed || checking) return;
    checking = true;
    void stillThere(root, identity)
      .then(async (there) => {
        if (there || closed) return;
        closed = true;
        clearInterval(timer);
        const movedTo = await findMovedLibrary(root, identity, options.id);
        log.info("the library's folder left its path", { root, movedTo: movedTo ?? null });
        options.onLost(movedTo);
      })
      .finally(() => {
        checking = false;
      });
  }, options.intervalMs ?? ROOT_POLL_MS);
  // Never the reason a process stays up.
  timer.unref();

  return {
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}

async function stillThere(root: string, identity: Identity): Promise<boolean> {
  try {
    const now = await stat(root);
    return now.dev === identity.dev && now.ino === identity.ino;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    // Only an answer that says the path is gone. A permission flicker or an
    // I/O error is not a reason to close somebody's library.
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/**
 * The directory beside the old path that is the same directory, if any.
 *
 * That finds a rename, which is the common case. A move to another parent, or
 * a drive unplugged, finds nothing, and the window offers *Open library…*
 * instead. The manifest's id is checked as well as the inode, because an inode
 * number is reused once its directory is gone.
 */
export async function findMovedLibrary(
  root: string,
  identity: Identity,
  id: string,
): Promise<string | undefined> {
  const parent = dirname(resolve(root));
  let entries: Dirent[];
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(parent, entry.name);
    try {
      const found = await stat(candidate);
      if (found.dev !== identity.dev || found.ino !== identity.ino) continue;
      if ((await readManifest(candidate)).id === id) return candidate;
    } catch {
      // Gone between the listing and the look, or not a library: keep going.
    }
  }
  return undefined;
}
