import type { ContentHash } from "@roost/core";
import { type Library, resolveAsset } from "@roost/library";

/**
 * Resolves every argument before anything is mutated.
 *
 * Deliberately all-or-nothing: a typo in the fifth of six hashes must not leave
 * the first four edited and the command reporting failure.
 */
export function resolveAll(library: Library, needles: readonly string[]): ContentHash[] {
  return needles.map((needle) => resolveAsset(library, needle));
}

/** Enough of a hash to recognise, in a line a person reads. */
export function short(hash: ContentHash): string {
  return hash.slice(0, 12);
}

/** "1 asset" rather than "1 assets", which reads as a bug in the counting. */
export function assets(count: number): string {
  return count === 1 ? "1 asset" : `${count} assets`;
}
