import { InvalidContentHashError } from "./error.js";

declare const contentHashBrand: unique symbol;

/**
 * A BLAKE3 content hash: exactly 64 lowercase hexadecimal characters.
 *
 * **Derived, never identity** (RL-18). Format 2 identifies an asset by its id
 * (RL-13); a hash is a fact about the bytes, which are allowed to change under
 * it at any time. It is kept because three things need one — duplicate
 * detection at import (ADR-0037), Eagle's fill-what-is-empty rule (ADR-0032
 * §8) and `doctor` — and RL-18 permits it provided it is never a filename,
 * never an identity, and never a reason to refuse a file.
 *
 * BLAKE3 over the whole file, hexadecimal and lower case, as RL-18 recommends,
 * so that two implementations comparing notes compare the same number. There is
 * no partial scheme: it existed under version 1 so that a 4 GB video could be
 * identified without reading it, and identity no longer comes from the bytes.
 *
 * Branded rather than a bare `string` because "lowercase hex, 64 characters" is
 * a rule that has to hold wherever a hash is compared.
 */
export type ContentHash = string & { readonly [contentHashBrand]: true };

/**
 * Uppercase hex is rejected rather than folded, so that one file has one
 * spelling of its hash and two rows cannot disagree about whether they hold the
 * same bytes.
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
