import { constants } from "node:fs";
import { copyFile, link, mkdir, opendir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pid } from "node:process";
import {
  type ContentHash,
  IoError,
  isContentHash,
  type LinkMethod,
  type StorageMode,
  shardOf,
} from "../model/index.js";
import {
  normalizeExt,
  ORIGINALS_DIR,
  type Placed,
  type Storage,
  type StoredFile,
} from "./types.js";

let tempCounter = 0;

/**
 * A temp name in the destination's own directory, so the final step is a rename
 * within one filesystem and therefore atomic.
 *
 * The leading dot keeps a partially written file out of `iterAll`: a torn file
 * at a real content address would look like valid content addressed by a hash
 * it does not actually have.
 */
function tempPathFor(dest: string): string {
  return join(dirname(dest), `.${basename(dest)}.tmp-${pid}-${tempCounter++}`);
}

/**
 * Places bytes at `dest` by the best method the filesystem allows: reflink,
 * then hardlink, then copy (`STORAGE_SPEC.md` §Import Modes).
 *
 * A reflink is copy-on-write, so the library's copy costs nothing *and* stays
 * independent of later edits to the user's file. A hardlink is also free but
 * shares an inode, so it is not independent. A copy is the fallback.
 *
 * `COPYFILE_FICLONE_FORCE` is what makes the first rung honest. Its sibling
 * `COPYFILE_FICLONE` is only a hint: it falls back to a full copy silently and
 * reports success either way, so it could never say which `link_method` to
 * record — and that value goes in the journal, where a wrong one survives a
 * rebuild. `FORCE` refuses instead: `ENOTSUP` on a filesystem without
 * copy-on-write, `EXDEV` across filesystems. Both are ordinary answers, not
 * failures, and both simply move to the next rung. See ADR-0012.
 */
async function place(src: string, dest: string): Promise<LinkMethod> {
  try {
    await copyFile(src, dest, constants.COPYFILE_FICLONE_FORCE);
    return "reflink";
  } catch {
    // Ordinary on ext4 and across mounts.
  }

  try {
    await link(src, dest);
    return "hardlink";
  } catch {
    // Ordinary across filesystems.
  }

  // The last rung throws for real. If the source is missing or unreadable, all
  // three fail and this is the one that says why.
  try {
    await copyFile(src, dest);
  } catch (cause) {
    throw new IoError("copy", src, cause);
  }
  return "copy";
}

/** Parses `<64-hex>[.<ext>]` back into a `StoredFile`, or `null` if it is not one. */
function parseStoredFile(path: string): StoredFile | null {
  const name = basename(path);
  // Temp files from an interrupted `put`.
  if (name.startsWith(".")) return null;

  const dot = name.indexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot + 1);
  if (!isContentHash(stem)) return null;

  return { hash: stem, ext, path };
}

/** Stores asset bytes at `originals/<shard>/<hash>.<ext>`. */
export class ManagedStorage implements Storage {
  readonly mode: StorageMode = "managed";

  readonly #root: string;

  /** `libraryRoot` is the library directory, not the `originals/` directory. */
  constructor(libraryRoot: string) {
    this.#root = libraryRoot;
  }

  originalsDir(): string {
    return join(this.#root, ORIGINALS_DIR);
  }

  /**
   * **The one place a hash becomes a path.** Everything else in the workspace
   * goes through this method (`ARCHITECTURE.md` invariant 2).
   *
   * An asset with no extension is stored under the bare hash, with no trailing
   * dot — which is also how `parseStoredFile` reads it back.
   */
  locate(hash: ContentHash, ext: string): string {
    const normalized = normalizeExt(ext);
    const fileName = normalized === "" ? hash : `${hash}.${normalized}`;
    return join(this.originalsDir(), shardOf(hash), fileName);
  }

  async put(src: string, hash: ContentHash, ext: string): Promise<Placed> {
    const dest = this.locate(hash, ext);

    if (
      await stat(dest).then(
        () => true,
        () => false,
      )
    ) {
      return { path: dest, linkMethod: null, alreadyPresent: true };
    }

    // Shard directories are created lazily, as files arrive
    // (`STORAGE_SPEC.md` invariant 4).
    const shard = dirname(dest);
    try {
      await mkdir(shard, { recursive: true });
    } catch (cause) {
      throw new IoError("mkdir", shard, cause);
    }

    const temp = tempPathFor(dest);
    let linkMethod: LinkMethod;
    try {
      linkMethod = await place(src, temp);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }

    // Note what is deliberately absent: no chmod on the placed file. Under a
    // hardlink it is the *user's* file too, and tightening permissions here
    // would reach into their directory.
    //
    // Two concurrent puts of the same hash both rename onto `dest`. That is
    // safe rather than merely tolerated: rename is atomic, and the bytes are
    // identical by definition — the hash is what named the destination.
    try {
      await rename(temp, dest);
    } catch (cause) {
      await rm(temp, { force: true });
      throw new IoError("rename", dest, cause);
    }

    return { path: dest, linkMethod, alreadyPresent: false };
  }

  async putBytes(bytes: Uint8Array, hash: ContentHash, ext: string): Promise<Placed> {
    const dest = this.locate(hash, ext);

    if (
      await stat(dest).then(
        () => true,
        () => false,
      )
    ) {
      return { path: dest, linkMethod: null, alreadyPresent: true };
    }

    const shard = dirname(dest);
    try {
      await mkdir(shard, { recursive: true });
    } catch (cause) {
      throw new IoError("mkdir", shard, cause);
    }

    // Written to a temp name in the destination's own directory and renamed, as
    // `put` does and for the same reason: the rename is atomic within one
    // filesystem, so nothing ever observes a half-written file at a real
    // content address.
    const temp = tempPathFor(dest);
    try {
      await writeFile(temp, bytes);
    } catch (cause) {
      await rm(temp, { force: true });
      throw new IoError("write", temp, cause);
    }

    try {
      await rename(temp, dest);
    } catch (cause) {
      await rm(temp, { force: true });
      throw new IoError("rename", dest, cause);
    }

    return { path: dest, linkMethod: "copy", alreadyPresent: false };
  }

  /** Removing something that is not there is success, not an error. */
  async remove(hash: ContentHash, ext: string): Promise<void> {
    const path = this.locate(hash, ext);
    try {
      await rm(path, { force: true });
    } catch (cause) {
      throw new IoError("remove", path, cause);
    }
  }

  /**
   * Lazily walks `originals/<shard>/<file>`.
   *
   * Entries it cannot make sense of are skipped rather than fatal: a stray file
   * must not stop a rebuild that would otherwise recover everything.
   */
  async *iterAll(): AsyncIterable<StoredFile> {
    const originals = this.originalsDir();
    // A library with nothing imported yet has no originals/ directory.
    await mkdir(originals, { recursive: true }).catch(() => {});

    let shards: Awaited<ReturnType<typeof opendir>>;
    try {
      shards = await opendir(originals);
    } catch (cause) {
      throw new IoError("opendir", originals, cause);
    }

    for await (const shard of shards) {
      if (!shard.isDirectory()) continue;
      const dir = join(originals, shard.name);

      let files: Awaited<ReturnType<typeof opendir>>;
      try {
        files = await opendir(dir);
      } catch {
        continue;
      }

      for await (const entry of files) {
        const stored = parseStoredFile(join(dir, entry.name));
        if (stored) yield stored;
      }
    }
  }
}
