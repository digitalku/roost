import { ID_ALPHABET, ID_LENGTH } from "./asset-id.js";

/**
 * The orders a listing can be asked for (ADR-0039).
 *
 * A vocabulary rather than a free expression: each key names a column or an
 * expression the schema has an index for, and one that does not is a query that
 * sorts the whole match set to produce one screen.
 *
 * `added` is the order the application had before there was a menu, and it is
 * still the default. `random` is the one key with no index and no column — a
 * seeded reading of the asset id, described in {@link shuffleFor}.
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
   * Kept by the caller — the window rolls one each time it opens a library
   * (ADR-0039 §11) — rather than by the engine, and held still between pages,
   * because a shuffle that changed while somebody was scrolling would show
   * them one asset twice and another not at all.
   */
  readonly seed: number;
}

/** Newest first: the order the grid had before the menu could ask for another. */
export const DEFAULT_SORT: Sort = { key: "added", descending: true, seed: 0 };

/**
 * Which shuffle a seed names: one character of the id, and an order for the
 * alphabet that character is read in.
 *
 * An id is twelve uniformly random characters (RL-14), so the assets are
 * ordered by where the character at `at` falls in `alphabet`, and the id
 * breaks the ties. Twelve places and every ordering of thirty-two characters
 * make the shuffles too many to come round again, where the rotation this
 * replaced had eleven (ADR-0039 §11).
 *
 * The key is a small integer rather than a string on purpose. Building a
 * string per row doubled the cost of the first page, and an integer that ties
 * is what lets a resume be the cheap seek every other order has: the rest of
 * the run of one character, in id order, from the primary key.
 *
 * Every seed is a shuffle, zero included, and nearby seeds are unrelated
 * ones: the seed only starts a generator.
 */
export interface Shuffle {
  /** Which character of the id is read, counted from 1 as `substr` counts. */
  readonly at: number;
  /** `ID_ALPHABET` reordered: a character's place in it is the sort key. */
  readonly alphabet: string;
}

export function shuffleFor(seed: number): Shuffle {
  const next = mulberry32(Math.abs(Math.trunc(seed)) % 2 ** 32);
  const letters = [...ID_ALPHABET];
  for (let i = letters.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    // Both indexes are below `letters.length`, so neither read is undefined.
    [letters[i], letters[j]] = [letters[j] as string, letters[i] as string];
  }
  return { at: 1 + Math.floor(next() * ID_LENGTH), alphabet: letters.join("") };
}

/**
 * A small seeded generator. Not for anything secret: its only job is that two
 * seeds give two unrelated shuffles, and that one seed gives the same one in
 * every build.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
