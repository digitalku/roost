import { type AssetId, type ContentHash, mintAssetId } from "@roost/core";

/**
 * Hashes claimed in one batch by the file that will place them.
 *
 * Without this, two identical files in one batch both look new and a library
 * gains two assets from one gesture. The claim is a promise rather than an id
 * because the file that made it may never arrive — placing it can fail, or be
 * stopped (ADR-0055 §3.3) — and an identical file that had taken the claim on
 * trust would then name an asset no batch adds (ADR-0055 §3.5). So it waits.
 */
export type Claims = Map<ContentHash, Promise<AssetId | undefined>>;

/** What {@link claim} found: an asset already holding the bytes, or a new id. */
export type Claimed =
  | { readonly held: AssetId }
  | {
      readonly id: AssetId;
      /**
       * Settles the claim. `true` once the file is placed, so that an identical
       * file waiting on it is a duplicate of this id. `false` if it will not be,
       * so that one of them claims the bytes in its place.
       */
      readonly settle: (placed: boolean) => void;
    };

/**
 * Finds what already holds `hash` in this batch or in `held`, or claims it.
 *
 * The claim is made in the same turn as the last check, with no `await`
 * between them, which is what makes it the compare-and-set a concurrent batch
 * needs. RL-15: the id is minted against the library and against `minted`,
 * because this batch's rows do not exist yet.
 */
export async function claim(
  hash: ContentHash,
  claims: Claims,
  minted: Set<AssetId>,
  held: (hash: ContentHash) => AssetId | undefined,
  exists: (id: AssetId) => boolean,
): Promise<Claimed> {
  for (;;) {
    const claimed = claims.get(hash);
    if (claimed === undefined) break;
    const id = await claimed;
    if (id !== undefined) return { held: id };
    // Released: the file that claimed it never arrived. Looked at again, since
    // another file waiting on the same claim may have claimed it since.
  }

  const existing = held(hash);
  if (existing !== undefined) return { held: existing };

  const id = mintAssetId((candidate) => minted.has(candidate) || exists(candidate));
  minted.add(id);
  let resolve: (id: AssetId | undefined) => void = () => {};
  claims.set(
    hash,
    new Promise((settle) => {
      resolve = settle;
    }),
  );
  return {
    id,
    settle: (placed) => {
      if (!placed) claims.delete(hash);
      resolve(placed ? id : undefined);
    },
  };
}
