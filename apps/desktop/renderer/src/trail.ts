/**
 * Where this window has been (ADR-0044).
 *
 * A stack of **places**, not of queries. ADR-0035 split a query into the place
 * it looks in and the facets the filter bar owns, and the user chose on
 * 2026-09-13 that only the first of those is somewhere you have been: ticking a
 * rating is not a location, and Back does not untick it. Travelling therefore
 * keeps the filters standing, because it is the same gesture as clicking a
 * folder and there is one rule about what a place does to a query.
 *
 * It is the **window's**, and it is never written down (ADR-0019 is about
 * preferences; this is not one). Two windows onto one library have two of these
 * — they are two places to be looking from.
 */

/** Where an apply came from, which is the one thing a place cannot say itself. */
export type Source = "control" | "field";

export interface Trail {
  /** Places, oldest first. Always holds at least the one being stood on. */
  readonly entries: readonly string[];
  readonly at: number;
  /**
   * Whether the entry being stood on was typed into the search field.
   *
   * The field applies on a 250ms idle (`UI_SPEC.md` §5), so one query typed at
   * a normal speed arrives three or four times. A burst of typing is one trip:
   * an apply from the field replaces a previous entry that also came from it,
   * and pushes otherwise.
   */
  readonly typed: boolean;
}

export const NO_TRAIL: Trail = { entries: [""], at: 0, typed: false };

/**
 * The trail after landing on `place`, or the same one when nothing moved.
 *
 * **Returns the identity it was given** when there is nothing to record, which
 * is what lets this be called from the effect that reads every split — a facet
 * ticked, a query still being counted, or a journey that has already moved the
 * index all arrive here and none of them may cause a render.
 */
export function record(held: Trail, place: string, from: Source): Trail {
  if (place === held.entries[held.at]) return held;

  // Anything ahead is a future that is not being had any more, exactly as a
  // browser and a file manager both drop it.
  const kept = held.entries.slice(0, held.at + 1);

  if (from === "field" && held.typed) {
    return { entries: [...kept.slice(0, -1), place], at: held.at, typed: true };
  }
  return { entries: [...kept, place], at: kept.length, typed: from === "field" };
}

/**
 * The trail `delta` steps away, or `undefined` where there is nothing there.
 *
 * The caller applies `entries[at]` itself: this file knows where the window has
 * been and nothing about how a place becomes a query.
 */
export function travel(held: Trail, delta: number): Trail | undefined {
  const to = held.at + delta;
  if (held.entries[to] === undefined) return undefined;
  // No longer being typed: arriving somewhere by walking is a visit, and the
  // next thing typed into the field should push rather than overwrite it.
  return { entries: held.entries, at: to, typed: false };
}

export function canTravel(held: Trail, delta: number): boolean {
  return held.entries[held.at + delta] !== undefined;
}
