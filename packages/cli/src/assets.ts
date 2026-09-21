import type { AssetId } from "@roost/core";
import { type Library, resolveAsset } from "@roost/library";

/**
 * Resolves every argument before anything is mutated.
 *
 * Deliberately all-or-nothing: a typo in the fifth of six ids must not leave
 * the first four edited and the command reporting failure.
 */
export function resolveAll(library: Library, needles: readonly string[]): AssetId[] {
  return needles.map((needle) => resolveAsset(library, needle));
}

/**
 * An id, as a line a person reads.
 *
 * Whole, unlike version 1's twelve characters of a sixty-four-character hash:
 * an id **is** twelve characters (RL-14), so there is nothing to shorten and
 * nothing to make ambiguous by shortening.
 */
export function short(id: AssetId): string {
  return id;
}

/** "1 asset" rather than "1 assets", which reads as a bug in the counting. */
export function assets(count: number): string {
  return count === 1 ? "1 asset" : `${count} assets`;
}
