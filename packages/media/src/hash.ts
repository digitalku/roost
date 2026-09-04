import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { Blake3Hasher } from "@napi-rs/blake-hash";
import { type ContentHash, parseContentHash } from "@roost/core";

/**
 * Files at or below this size are hashed in full. The comparison is `size >`,
 * so exactly 50 MiB is a full hash and one byte more is not — both boundaries
 * are covered by the conformance fixtures, because an off-by-one here splits
 * one asset into two.
 */
export const FULL_HASH_MAX_BYTES = 50 * 1024 * 1024;

/** How much is read from each end of a file too large to hash in full. */
export const PARTIAL_WINDOW_BYTES = 64 * 1024;

/**
 * Read buffer for full hashing. Large enough that syscall overhead is
 * irrelevant, small enough to stay out of the way on a thumbnailing pool.
 */
const READ_BUFFER_BYTES = 256 * 1024;

/**
 * The result of hashing a file, carrying the size it was measured at.
 *
 * Size travels with the hash because a partial hash is only meaningful
 * alongside it: the size is hashed as the prefix, so two files sharing a
 * partial hash necessarily share a size, and the importer needs the number to
 * decide what to verify (`STORAGE_SPEC.md` §Partial-hash collisions).
 */
export interface Hashed {
  readonly hash: ContentHash;
  readonly size: number;
  /**
   * Mirrors `assets.is_partial_hash`. A partial hash can be upgraded to a full
   * one later without a schema change.
   */
  readonly isPartial: boolean;
}

/**
 * `filehandle.read` may return fewer bytes than asked for, and a short read
 * that goes unnoticed produces a hash over a buffer with stale tail bytes —
 * wrong, stable, and impossible to spot by eye.
 */
async function readExact(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      buffer.length - filled,
      position + filled,
    );
    if (bytesRead === 0) {
      throw new Error(`Short read: wanted ${buffer.length} bytes at ${position}, got ${filled}`);
    }
    filled += bytesRead;
  }
}

/**
 * Hashes a file according to `docs/STORAGE_SPEC.md` §Hashing.
 *
 * Below the size limit this is BLAKE3 over the whole file, streamed — assets
 * are routinely gigabytes and must never be read into memory. Above it, the
 * hash covers the little-endian file size followed by the first and last 64 KB,
 * which identifies a 4 GB video without reading 4 GB.
 *
 * The size prefix is written with `writeBigUInt64LE`: eight bytes, unsigned,
 * little-endian. Not a double, not a decimal string. A library whose large
 * assets hash differently from the Rust implementation's is not compatible with
 * it, and nothing that round-trips through one implementation would say so —
 * which is why `hash.conformance.test.ts` asserts digests taken from the other
 * one rather than from this code.
 */
export async function hashFile(path: string): Promise<Hashed> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const hasher = new Blake3Hasher();
    const isPartial = size > FULL_HASH_MAX_BYTES;

    if (isPartial) {
      const prefix = Buffer.allocUnsafe(8);
      prefix.writeBigUInt64LE(BigInt(size));
      hasher.update(prefix);

      const window = Buffer.allocUnsafe(PARTIAL_WINDOW_BYTES);
      await readExact(handle, window, 0);
      hasher.update(window);

      // Safe to subtract: size is above 50 MiB, far beyond the window.
      await readExact(handle, window, size - PARTIAL_WINDOW_BYTES);
      hasher.update(window);
    } else {
      const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
      let position = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        hasher.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    }

    return { hash: parseContentHash(hasher.digest("hex")), size, isPartial };
  } finally {
    await handle.close();
  }
}

/**
 * Hashes bytes already in memory, by the same rules as {@link hashFile}.
 *
 * For content the application produced rather than read — an edited text asset
 * on its way to becoming a new version (ADR-0026). The two must agree: the same
 * content hashed either way is one asset, and a divergence would put it at two
 * addresses with nothing to notice.
 *
 * The partial branch is here for that agreement and not because anything is
 * expected to reach it: what this path carries is text a person typed, and the
 * caller caps that far below the limit.
 */
export function hashBytes(bytes: Uint8Array): Hashed {
  const size = bytes.length;
  const hasher = new Blake3Hasher();
  const isPartial = size > FULL_HASH_MAX_BYTES;

  if (isPartial) {
    const prefix = Buffer.allocUnsafe(8);
    prefix.writeBigUInt64LE(BigInt(size));
    hasher.update(prefix);
    hasher.update(bytes.subarray(0, PARTIAL_WINDOW_BYTES));
    hasher.update(bytes.subarray(size - PARTIAL_WINDOW_BYTES));
  } else {
    hasher.update(bytes);
  }

  return { hash: parseContentHash(hasher.digest("hex")), size, isPartial };
}
