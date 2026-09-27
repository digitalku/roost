import { constants } from "node:fs";
import { copyFile, mkdir, open, opendir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pid } from "node:process";
import {
  type AssetId,
  IoError,
  isAssetId,
  type Placement,
  shardOf,
  type Take,
} from "../model/index.js";
import {
  FILES_DIR,
  normalizeExt,
  type Placed,
  type PutOptions,
  type Storage,
  type StoredFile,
} from "./types.js";

let tempCounter = 0;

/**
 * A temp name in the destination's own directory, so the final step is a rename
 * within one filesystem and therefore atomic.
 *
 * The leading dot is not what keeps it out of `iterAll` — RL-11 does that,
 * because the stem is not an id — but it keeps it out of the way of anybody
 * listing the directory while an import is running.
 */
function tempPathFor(dest: string): string {
  return join(dirname(dest), `.${basename(dest)}.tmp-${pid}-${tempCounter++}`);
}

/**
 * Splits a filename into its id and extension, or `null` when the name is not
 * an id (RL-11).
 *
 * The split is at the **first** dot, so `K7QM4X2AJH9F.tar.gz` has the extension
 * `tar.gz` and one file, rather than an id with something after it.
 */
function parseStoredFile(path: string): StoredFile | null {
  const name = basename(path);
  const dot = name.indexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot + 1);
  if (!isAssetId(stem)) return null;
  return { id: stem, ext, path };
}

/**
 * Stores asset bytes at `files/<shard>/<id>.<ext>` (RL-8, RL-9).
 *
 * Nothing here is content-addressed: the id names the file, the bytes are the
 * user's to change, and an edit is not this class's business (RL-20, RL-23).
 */
export class FileStore implements Storage {
  readonly #root: string;

  /** `libraryRoot` is the library directory, not the `files/` directory. */
  constructor(libraryRoot: string) {
    this.#root = libraryRoot;
  }

  filesDir(): string {
    return join(this.#root, FILES_DIR);
  }

  /**
   * **The one place an id becomes a path** (`ARCHITECTURE.md` invariant 2).
   *
   * An asset with no extension is stored under the bare id, with **no trailing
   * dot** (RL-9a) — the rule a Windows implementation can break without
   * noticing, because Windows strips a trailing dot before the path reaches the
   * filesystem and the file would still be found by its own API.
   */
  locate(id: AssetId, ext: string): string {
    const normalized = normalizeExt(ext);
    const fileName = normalized === "" ? id : `${id}.${normalized}`;
    return join(this.filesDir(), shardOf(id), fileName);
  }

  async put(
    src: string,
    id: AssetId,
    ext: string,
    take: Take,
    options?: PutOptions,
  ): Promise<Placed> {
    const dest = this.locate(id, ext);
    await this.#ensureShard(dest);

    // A move within one filesystem is a rename and costs nothing. Across
    // filesystems it is EXDEV, which is an ordinary answer rather than a
    // failure: the bytes are copied and the source is unlinked afterwards, so
    // the user's file is never gone before the library's file exists.
    if (take === "move") {
      try {
        await rename(src, dest);
        return { path: dest, take, placement: "rename" };
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EXDEV") {
          throw new IoError("rename", src, cause);
        }
      }
    }

    const temp = tempPathFor(dest);
    let placement: Placement;
    try {
      placement = await copyInto(src, temp, options);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }

    try {
      await rename(temp, dest);
    } catch (cause) {
      await rm(temp, { force: true });
      throw new IoError("rename", dest, cause);
    }

    if (take === "move") {
      // The copy is committed, so the move can finish. A source that cannot be
      // unlinked leaves the person with two copies rather than none, which is
      // the right way round for this to fail.
      try {
        await rm(src, { force: true });
      } catch (cause) {
        throw new IoError("remove", src, cause);
      }
    }

    return { path: dest, take, placement };
  }

  async writeBytes(bytes: Uint8Array, id: AssetId, ext: string): Promise<string> {
    const dest = this.locate(id, ext);
    await this.#ensureShard(dest);

    // Written to a temp name in the destination's own directory and renamed:
    // the rename is atomic within one filesystem, so a reader either sees the
    // bytes that were there before or the bytes that are there now, never half
    // of either.
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

    return dest;
  }

  async rename(id: AssetId, fromExt: string, toExt: string): Promise<string> {
    const from = this.locate(id, fromExt);
    const dest = this.locate(id, toExt);
    if (from === dest) return dest;

    await this.#ensureShard(dest);
    try {
      await rename(from, dest);
    } catch (cause) {
      throw new IoError("rename", from, cause);
    }
    return dest;
  }

  /** Removing something that is not there is success, not an error. */
  async remove(id: AssetId, ext: string): Promise<void> {
    const path = this.locate(id, ext);
    try {
      await rm(path, { force: true });
    } catch (cause) {
      throw new IoError("remove", path, cause);
    }
  }

  /**
   * Reads the shard directory rather than asking whether a path exists.
   *
   * That is RL-9a's other half: `existsSync` on Windows answers for a name the
   * filesystem never saw, so a trailing dot this build wrote by mistake would
   * pass its own test and produce a library nothing else can read. A directory
   * entry is what was actually written.
   */
  async findFiles(id: AssetId): Promise<readonly StoredFile[]> {
    const dir = join(this.filesDir(), shardOf(id));
    const found: StoredFile[] = [];
    try {
      for await (const entry of await opendir(dir)) {
        if (!entry.isFile()) continue;
        const stored = parseStoredFile(join(dir, entry.name));
        if (stored && stored.id === id) found.push(stored);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new IoError("opendir", dir, cause);
    }
    return found;
  }

  /**
   * Lazily walks `files/<shard>/<file>`.
   *
   * A name that is not an id is skipped rather than fatal, and skipped rather
   * than deleted (RL-11): applications leave lock files beside the document
   * they opened, and deleting them would put Roost in the business of guessing
   * which of somebody's files are rubbish.
   */
  async *iterAll(): AsyncIterable<StoredFile> {
    for await (const path of this.#walk()) {
      const stored = parseStoredFile(path);
      if (stored) yield stored;
    }
  }

  async *iterUnrecognised(): AsyncIterable<string> {
    for await (const path of this.#walk()) {
      if (parseStoredFile(path) === null) yield path;
    }
  }

  async *#walk(): AsyncIterable<string> {
    const files = this.filesDir();
    // A library with nothing imported yet has no files/ directory.
    await mkdir(files, { recursive: true }).catch(() => {});

    let shards: Awaited<ReturnType<typeof opendir>>;
    try {
      shards = await opendir(files);
    } catch (cause) {
      throw new IoError("opendir", files, cause);
    }

    for await (const shard of shards) {
      if (!shard.isDirectory()) continue;
      const dir = join(files, shard.name);

      let entries: Awaited<ReturnType<typeof opendir>>;
      try {
        entries = await opendir(dir);
      } catch {
        continue;
      }

      for await (const entry of entries) {
        if (entry.isDirectory()) continue;
        yield join(dir, entry.name);
      }
    }
  }

  /** Shard directories are created as files arrive, never all 1 024 (RL-10). */
  async #ensureShard(dest: string): Promise<void> {
    const shard = dirname(dest);
    try {
      await mkdir(shard, { recursive: true });
    } catch (cause) {
      throw new IoError("mkdir", shard, cause);
    }
  }
}

/**
 * Copies `src` to `dest` by the cheapest method that produces an **independent**
 * file: a copy-on-write clone where the filesystem offers one, a full copy
 * otherwise.
 *
 * `COPYFILE_FICLONE_FORCE` is what makes the first rung honest. Its sibling
 * `COPYFILE_FICLONE` is only a hint: it falls back to a full copy silently and
 * reports success either way. `FORCE` refuses instead — `ENOTSUP` on a
 * filesystem without copy-on-write, `EXDEV` across filesystems — and both are
 * ordinary answers rather than failures (ADR-0012).
 *
 * **There is no hardlink rung any more**, and that is RL-26 rather than a
 * preference: a shared inode would mean editing the file inside the library
 * edits the user's file outside it, which is precisely what a workspace must
 * not do.
 */
async function copyInto(src: string, dest: string, options?: PutOptions): Promise<Placement> {
  options?.signal?.throwIfAborted();
  try {
    await copyFile(src, dest, constants.COPYFILE_FICLONE_FORCE);
    return "reflink";
  } catch {
    // Ordinary on ext4, on NTFS, and across mounts.
  }

  // Counted only when somebody is counting. A signal alone is checked above and
  // keeps the kernel's copy: a small file is done before a stop could matter.
  if (options?.onBytes !== undefined) {
    await copyCounted(src, dest, options);
    return "copy";
  }
  try {
    await copyFile(src, dest);
  } catch (cause) {
    throw new IoError("copy", src, cause);
  }
  return "copy";
}

/** One chunk of a counted copy: large enough that a hard disk streams rather than seeks. */
const COPY_CHUNK = 4 * 1024 * 1024;

/**
 * A full copy a chunk at a time, reporting each and stopping when asked.
 *
 * `copyFile` cannot do either: it is one call into the kernel, and it returns
 * when the last byte is written. The mode is carried over as `copyFile` would,
 * so the two rungs make the same file. An abort is rethrown as itself rather
 * than wrapped, because the caller asked for it and must be able to tell it
 * from a disk that failed.
 */
async function copyCounted(src: string, dest: string, options: PutOptions): Promise<void> {
  const { onBytes, signal } = options;
  try {
    const input = await open(src, "r");
    try {
      const output = await open(dest, "w");
      try {
        await output.chmod((await input.stat()).mode);
        const buffer = Buffer.allocUnsafe(COPY_CHUNK);
        for (;;) {
          signal?.throwIfAborted();
          const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          let written = 0;
          while (written < bytesRead) {
            written += (await output.write(buffer, written, bytesRead - written)).bytesWritten;
          }
          onBytes?.(bytesRead);
        }
      } finally {
        await output.close();
      }
    } finally {
      await input.close();
    }
  } catch (cause) {
    if (signal?.aborted === true) throw signal.reason;
    throw new IoError("copy", src, cause);
  }
}
