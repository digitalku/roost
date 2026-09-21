import { InvalidAssetIdError } from "./error.js";

declare const assetIdBrand: unique symbol;

/**
 * An asset's identity: twelve characters of Crockford base32, upper case.
 *
 * Minted once, never changed, never reused (RL-13, RL-16) — not the path, not
 * the name the person reads, and **not the hash of the bytes**. The bytes are
 * allowed to change under it, which is the whole of what Format 2 is for.
 *
 * Branded rather than a bare `string` because everything keys on it, and a
 * "twelve characters from this alphabet" rule that lives only in a comment is a
 * rule that is already broken.
 */
export type AssetId = string & { readonly [assetIdBrand]: true };

/**
 * Crockford base32: the digits and the upper-case letters without `I`, `L`,
 * `O` and `U` (RL-14).
 *
 * Upper case only, because Windows compares filenames without regard to case
 * and two ids differing only in case would be one file. `I`, `L` and `O` are
 * absent because they read as `1`, `1` and `0`; `U` is absent so that a random
 * id never spells something unfortunate.
 */
export const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Twelve characters, fixed, so every build derives the same path from an id. */
export const ID_LENGTH = 12;

/**
 * Built from the alphabet rather than written out, so there is one place where
 * the character set lives. Nothing in `ID_ALPHABET` is a regular expression
 * metacharacter, so it needs no escaping.
 */
const ID_PATTERN = new RegExp(`^[${ID_ALPHABET}]{${ID_LENGTH}}$`);

export function isAssetId(value: string): value is AssetId {
  return ID_PATTERN.test(value);
}

export function parseAssetId(value: string): AssetId {
  if (!isAssetId(value)) throw new InvalidAssetIdError(value);
  return value;
}

/**
 * The shard an id belongs to: its first two characters, giving at most 1 024
 * buckets (RL-8).
 *
 * This returns a directory *name*, never a path. Turning an id into a path is
 * reserved to a `Storage` implementation — `ARCHITECTURE.md` invariant 2 — and
 * this function exists so that the "first two characters" rule is written down
 * once.
 */
export function shardOf(id: AssetId): string {
  return id.slice(0, 2);
}

/**
 * A new id, from the platform's cryptographic random source.
 *
 * `isTaken` is RL-15: an implementation MUST check that a newly minted id is
 * not already in the library and mint another if it is. At a million assets the
 * chance of a collision is about one in two million, so the loop is not the
 * point — the point is that the one time it happens, nothing is overwritten.
 *
 * Deliberately **not** ULID or UUIDv7 (RL-14a): both put the time in the
 * leading characters, which are the shard, so a month's imports would land in
 * one directory — the single failure sharding exists to prevent.
 */
export function mintAssetId(isTaken?: (id: AssetId) => boolean): AssetId {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = randomId();
    if (isTaken === undefined || !isTaken(id)) return id;
  }
  // Eight collisions in a row is not a full library; it is a broken random
  // source or a predicate that says yes to everything, and quietly handing back
  // a colliding id would overwrite somebody's file.
  throw new InvalidAssetIdError("could not mint an unused id in 8 attempts");
}

function randomId(): AssetId {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) {
    // 32 divides 256 exactly, so the low five bits are uniform over the
    // alphabet and no rejection sampling is needed.
    id += ID_ALPHABET[byte & 31];
  }
  return id as AssetId;
}
