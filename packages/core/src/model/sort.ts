import { ID_LENGTH } from "./asset-id.js";

/**
 * The orders a listing can be asked for (ADR-0039).
 *
 * A vocabulary rather than a free expression: each key names a column or an
 * expression the schema has an index for, and one that does not is a query that
 * sorts the whole match set to produce one screen.
 *
 * `added` is the order the application had before there was a menu, and it is
 * still the default. `random` is the one key with no index and no column — a
 * seeded rotation of the asset id, described in {@link rotationFor}.
 */
export const SORT_KEYS = ["added", "created", "name", "size", "rating", "random"] as const;

export type SortKey = (typeof SORT_KEYS)[number];

export function isSortKey(value: string): value is SortKey {
  return (SORT_KEYS as readonly string[]).includes(value);
}

/**
 * An order: which key, which way, and — for `random` — which shuffle.
 *
 * `descending` reads as the key's own words rather than as a direction: newest
 * first, largest first, five stars first. The frontends name it; the engine
 * only turns it into `DESC`.
 */
export interface Sort {
  readonly key: SortKey;
  readonly descending: boolean;
  /**
   * Which shuffle `random` means. Ignored by every other key.
   *
   * Kept by the caller — `settings.json` in the library — rather than by the
   * engine, because a shuffle that changed while somebody was scrolling would
   * show them one asset twice and another not at all.
   */
  readonly seed: number;
}

/** Newest first: the order the grid had before the menu could ask for another. */
export const DEFAULT_SORT: Sort = { key: "added", descending: true, seed: 0 };

/** How many characters of the id a seed rotates the order by. */
export const SHUFFLES = ID_LENGTH - 1;

/**
 * The rotation a seed names, in `1..SHUFFLES`.
 *
 * An id is twelve uniformly random characters (RL-14), so ordering by the id
 * *starting at character k* is an order that has nothing to do with the order
 * starting at character 0: two assets adjacent in one share a prefix, and in
 * the other are compared on characters that were never looked at. That is what
 * makes a rotation a shuffle rather than a rearrangement of one, and no two of
 * them are correlated.
 *
 * There are eleven rather than version 1's sixty-three, because an id is twelve
 * characters and a hash was sixty-four. That is the shuffle count falling, not
 * the shuffle getting worse: each one is still a uniformly random order of the
 * whole library, and nobody has ever asked for a twelfth.
 *
 * Zero is excluded because it is the identity: id order is a real order that
 * something else may one day want, and a shuffle that leaves the list alone
 * would read as a shuffle that failed.
 */
export function rotationFor(seed: number): number {
  return 1 + (Math.abs(Math.trunc(seed)) % SHUFFLES);
}
