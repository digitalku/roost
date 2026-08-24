import { InvalidContentHashError } from "./error.js";

declare const contentHashBrand: unique symbol;

/**
 * A BLAKE3 content hash: exactly 64 lowercase hexadecimal characters.
 *
 * This is the identity of an asset — not its path, not its filename
 * (`STORAGE_SPEC.md` invariant 1). It is branded rather than a bare `string`
 * because the whole system keys on it, and a "lowercase hex, 64 characters"
 * rule that lives only in a comment is a rule that is already broken.
 */
export type ContentHash = string & { readonly [contentHashBrand]: true };

/**
 * Uppercase hex is rejected rather than folded. The spec stores the hash
 * lowercased and uses it as the on-disk filename, so accepting `A3F2…` here
 * would let two spellings of one asset exist — and on a case-insensitive
 * filesystem they would collide as files while remaining distinct as keys.
 */
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function isContentHash(value: string): value is ContentHash {
  return CONTENT_HASH_PATTERN.test(value);
}

export function parseContentHash(value: string): ContentHash {
  if (!isContentHash(value)) {
    throw new InvalidContentHashError(value);
  }
  return value;
}

/**
 * The shard a hash belongs to: its first two hex characters, giving 256
 * buckets (`STORAGE_SPEC.md` invariant 2).
 *
 * This returns a directory *name*, never a path. Turning a hash into a path is
 * reserved to a `Storage` implementation — `ARCHITECTURE.md` invariant 2 —
 * and this function exists so that the "first two characters" rule itself is
 * written down once.
 */
export function shardOf(hash: ContentHash): string {
  return hash.slice(0, 2);
}
