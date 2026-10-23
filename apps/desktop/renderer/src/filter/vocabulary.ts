import type { WireFacets, WireFacetVocabulary } from "@roost/contract";
import { useEffect, useState } from "react";
import { invoke } from "../bridge.js";

/**
 * What the Tags and Types menus offer over one place (ADR-0035 §8, §9).
 *
 * `null` is the library's lists from the sidebar, for both menus; a list that
 * is `null` inside an answer is the library's for that menu alone.
 * `"counting"` is a folder whose answer has not arrived: the menu says so
 * rather than showing the whole library's list for a frame and then shrinking
 * it under the pointer.
 */
export type FacetScope = WireFacetVocabulary | null | "counting";

/**
 * Whether the ticked filters narrow the Tags menu (ADR-0035 §9).
 *
 * Only under *All*: there one more tag narrows the grid, so its count is worth
 * taking among what is already on screen. Under *Any* one more tag widens it,
 * and the place's own count is the true one. Read from the facets as data; no
 * query is assembled here.
 */
export function narrows(facets: WireFacets): boolean {
  return (
    facets.tagRule === "all" &&
    (facets.tags.length > 0 || facets.stars.length > 0 || facets.unrated || facets.exts.length > 0)
  );
}

/**
 * The menus' lists over `place`, read from the engine while `active` holds.
 *
 * **Asked only while a menu is open**, because the cost is the size of what is
 * counted — about 50 ms for a folder of ten thousand, and from a millisecond to
 * half a second for a ticked tag depending on how many assets carry it
 * (`BENCHMARKS.md`, 2026-10-23) — and walking from folder to folder should pay
 * nothing for a list nobody opened.
 *
 * Read again when `revision` moves, since a tag added in the inspector belongs
 * in the menu, and when a tick changes what narrows. The last answer for the
 * place stays on screen until the new one arrives: ticking a second tag, or an
 * import announcing revisions, must not blank the menu under the hand using it.
 */
export function useFacetScope(
  place: string,
  facets: WireFacets,
  revision: number,
  active: boolean,
): FacetScope {
  const [read, setRead] = useState<
    { place: string; key: string; value: WireFacetVocabulary | null } | undefined
  >();

  // The empty place is the engine's word for the whole library, which is no
  // folder: nothing to ask unless the ticks narrow it.
  const whole = place.trim() === "";
  const narrowing = narrows(facets);
  const key = `${revision}\u0000${narrowing ? JSON.stringify(facets) : ""}`;
  const skip = whole && !narrowing;
  const fresh = read !== undefined && read.place === place && read.key === key;

  useEffect(() => {
    if (!active || fresh || skip) return;
    let current = true;
    void (async () => {
      const outcome = await invoke({ type: "facets:vocabulary", place, facets });
      // A failure keeps the library's lists, which are a true answer to a
      // broader question; an error in a filter menu would be one nobody can act on.
      if (current) setRead({ place, key, value: outcome.ok ? outcome.value : null });
    })();
    return () => {
      current = false;
    };
  }, [active, fresh, skip, place, facets, key]);

  if (skip) return null;
  if (read !== undefined && read.place === place) return read.value;
  // Over the whole library the sidebar's lists are a fair first answer, and
  // the narrowed counts replace them in place; a folder has no such stand-in.
  return whole ? null : "counting";
}
