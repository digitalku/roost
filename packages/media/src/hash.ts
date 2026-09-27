import { open } from "node:fs/promises";
import { Blake3Hasher } from "@napi-rs/blake-hash";
import { type ContentHash, parseContentHash } from "@roost/core";

/**
 * Read buffer for hashing. Large enough that syscall overhead is irrelevant,
 * small enough to stay out of the way on a thumbnailing pool.
 */
const READ_BUFFER_BYTES = 256 * 1024;

/**
 * The result of hashing a file, with what the file measured at the time.
 *
 * All three are **derived** (RL-22): the bytes may change at any moment, by any
 * application (RL-20), so this is what was true when the file was read and not
 * a fact about the asset. `size` and `mtime` travel with the hash because they
 * are what a later pass compares to decide whether the file needs reading
 * again — cheaper than hashing a gigabyte to learn that nothing moved.
 *
 * **Version 1's partial scheme is gone.** It hashed the size and 64 KB from
 * each end of a large file so that a 4 GB video could be *identified* without
 * reading 4 GB; identity is an id now (RL-13), so a hash has one job — telling
 * whether two files hold the same bytes — and a partial answer to that question
 * is a wrong one.
 */
export interface Hashed {
  readonly hash: ContentHash;
  readonly size: number;
  /** The file's modification time when it was read, unix seconds. */
  readonly mtime: number;
}

/**
 * What a caller watching a long read can ask of {@link hashFile}.
 *
 * Both exist for a file of several gigabytes on a spinning disk, which takes
 * minutes to read: a transfer between libraries says how far it has got, and
 * stops when asked (ADR-0054 §3.9).
 */
export interface HashOptions {
  /** Called with each chunk's length as it is read. */
  readonly onBytes?: (count: number) => void;
  /** Checked between chunks; an abort ends the read with the signal's reason. */
  readonly signal?: AbortSignal;
}

/**
 * BLAKE3 over the whole file, streamed, lowercase hex (RL-18).
 *
 * Streamed because assets are routinely gigabytes and must never be read into
 * memory at once. Whole-file because RL-18 recommends exactly that, so two
 * implementations comparing notes compare the same number.
 *
 * The handle is opened for reading and closed immediately afterwards, which is
 * what RL-21 asks of everything that touches a file under `files/`: another
 * application must be able to write to it, rename it or delete it while Roost
 * is looking.
 */
export async function hashFile(path: string, options: HashOptions = {}): Promise<Hashed> {
  const { onBytes, signal } = options;
  signal?.throwIfAborted();
  const handle = await open(path, "r");
  try {
    const stats = await handle.stat();
    const hasher = new Blake3Hasher();

    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let position = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hasher.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      onBytes?.(bytesRead);
    }

    return {
      hash: parseContentHash(hasher.digest("hex")),
      size: stats.size,
      mtime: Math.floor(stats.mtimeMs / 1000),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Hashes bytes already in memory, by the same rule as {@link hashFile}.
 *
 * For content the application produced rather than read. The two must agree:
 * the same bytes hashed either way have to give the same number, or duplicate
 * detection would answer differently depending on which door the file came
 * through.
 *
 * `mtime` is the caller's clock, because bytes in memory have none.
 */
export function hashBytes(
  bytes: Uint8Array,
  mtime: number = Math.floor(Date.now() / 1000),
): Hashed {
  const hasher = new Blake3Hasher();
  hasher.update(bytes);
  return { hash: parseContentHash(hasher.digest("hex")), size: bytes.length, mtime };
}
