import type { AssetCard, WireCursor, WireProblem, WireRedrawn, WireSort } from "@roost/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../bridge.js";

/**
 * The grid's pages, fetched one cursor at a time.
 *
 * `sort` must be a stable object — it is a dependency of the effect that throws
 * the rows away, and a fresh one per render would re-page the grid on every
 * keystroke. **Undefined means the order is not known yet**, and nothing is
 * asked for: the order lives in the library (ADR-0039 §7) and arrives a round
 * trip after the library does, so paging before it would fetch a hundred rows
 * in order to throw them away.
 *
 * Keyset paging, never an offset: the cost of page 9,000 is the cost of page 1
 * (`DATA_MODEL.md`). The cursor is opaque here — the renderer sends back
 * whatever the engine handed it and never builds one.
 *
 * Rows accumulate rather than being replaced, because a grid is one continuous
 * list. They are dropped, and paging restarts, when the query changes or the
 * library does — the two things that make the rows already held wrong rather
 * than merely incomplete.
 */

/** One page. A screen of grid with room to scroll into (`DEFAULT_PAGE_LIMIT`). */
export const PAGE_SIZE = 100;

export interface Paging {
  readonly assets: readonly AssetCard[];
  /** No further page exists. The grid stops asking. */
  readonly done: boolean;
  readonly loading: boolean;
  readonly problem: WireProblem | undefined;
  /** Asks for the next page. Ignored while one is in flight or when done. */
  readonly more: () => void;
  /**
   * Records a pinned thumbnail moment on a card already held (ADR-0024 stage 4).
   *
   * The grid does not re-page on an edit — that is deliberate, and the comment
   * on `revision` in `App.tsx` says why — so a card here would keep the moment
   * it was fetched with, and the cell would keep asking for the thumbnail's old
   * address. The window that made the change is the one that knows, and the
   * engine has already confirmed the write by the time this is called.
   *
   * Another window onto the same library still shows the old picture until it
   * re-pages, which is what every other edit already does (ADR-0020).
   */
  readonly pinPoster: (id: string, posterMs: number | null) => void;
  /**
   * Puts a new name on a card already held.
   *
   * Same reason as {@link pinPoster}, and the same shape: a rename moves
   * neither the asset count nor the trash count, so the grid does not re-page —
   * and the cell under the inspector went on showing the old name until the
   * view was left and come back to. Reported from real use on 2026-09-07.
   *
   * Only the window that made the change calls this. Another window onto the
   * same library keeps the old name until it re-pages (ADR-0020).
   */
  readonly rename: (id: string, name: string) => void;
  /**
   * Gives cards whose files changed a new thumbnail address (ADR-0047).
   *
   * Unlike the two above, this one is **not** about the window that made the
   * change — nothing in Roost made it. An application that has never heard of
   * this program saved over a file, the engine's watcher noticed and re-derived
   * it, and the window is told which ids moved. It is the one card update that
   * arrives as an event rather than as the result of a request.
   *
   * It patches rather than re-pages because a save must not throw away the
   * scroll position, and it must patch at all because
   * `roost://thumb/<id>@<size>` is served `immutable` for a year: an `<img>`
   * whose `src` did not change is one Chromium never asks about again.
   *
   * It also carries why a card **still** has no picture, so a cell parked on a
   * missing decoder says so as soon as the queue decides it (`UI_SPEC.md`
   * §6.1), rather than at the next re-page.
   */
  readonly redraw: (redrawn: readonly WireRedrawn[]) => void;
  /**
   * Takes rows out of the grid without re-paging it.
   *
   * The targeted update `App.tsx`'s note about `revision` says is owed. The
   * grid re-pages only when the library's *counts* move, so an asset that stops
   * matching a filtered view without being added or trashed stays on screen —
   * and `Ctrl+Delete` in a folder is exactly that: the asset is still in the
   * library, still live, and no longer in the folder being looked at. Found by
   * driving a real window on 2026-09-07; the status bar said what had happened
   * while the grid went on showing it.
   *
   * Only the window that made the change calls this. Another window onto the
   * same library keeps the row until it re-pages, which is what every other
   * edit already does (ADR-0020).
   */
  readonly drop: (ids: readonly string[]) => void;
}

export function useAssetPages(
  query: string,
  generation: number,
  sort: WireSort | undefined,
): Paging {
  const [assets, setAssets] = useState<readonly AssetCard[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<WireProblem | undefined>();

  const cursor = useRef<WireCursor | null>(null);
  /**
   * Guards against two pages in flight at once.
   *
   * A ref rather than the `loading` state: a scroll handler firing twice in one
   * frame reads the same stale state both times, and the second read would ask
   * for the page the first is already fetching — with the same cursor, so the
   * grid would show every row twice.
   */
  const inFlight = useRef(false);
  /**
   * Whether the last page has already arrived.
   *
   * A ref beside the state for the same reason as `inFlight`: the grid asks
   * again whenever its height changes, and its height changes *because* a page
   * arrived — so the ask that follows the last page reads a `done` that has not
   * been committed yet, and fetches the first page a second time. Which is
   * exactly what it did: the same rows, appended again, forever.
   */
  const finished = useRef(false);
  /**
   * Which listing a reply belongs to.
   *
   * A page requested before the query changed must not be appended after it. An
   * incrementing token is enough: the reply checks whether it is still current.
   */
  const listing = useRef(0);

  const more = useCallback(() => {
    if (sort === undefined || inFlight.current || finished.current) return;
    inFlight.current = true;
    const mine = listing.current;
    setLoading(true);

    void (async () => {
      const outcome = await invoke({
        type: "assets:page",
        query,
        limit: PAGE_SIZE,
        after: cursor.current,
        sort,
      });
      // The listing changed while this was in the air. Its rows belong to a
      // query nobody is looking at.
      if (mine !== listing.current) return;

      inFlight.current = false;
      setLoading(false);
      if (!outcome.ok) {
        // A failed page stops the paging rather than retrying: the usual cause
        // is a query that does not parse, and asking again would not help.
        setProblem(outcome.problem);
        finished.current = true;
        setDone(true);
        return;
      }
      setProblem(undefined);
      cursor.current = outcome.value.next;
      if (outcome.value.next === null) {
        finished.current = true;
        setDone(true);
      }
      setAssets((held) => [...held, ...outcome.value.assets]);
    })();
  }, [query, sort]);

  /*
   * The dependencies here are the *trigger*, not values the body reads: a new
   * query, a new order, or a new library is what makes the rows already held
   * wrong rather than merely incomplete. A cursor belongs to the order it was
   * handed out under (ADR-0039 §4), so changing the order starts again — which
   * is also what somebody choosing one expects to see.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    listing.current += 1;
    inFlight.current = false;
    finished.current = false;
    cursor.current = null;
    setAssets([]);
    setDone(false);
    setProblem(undefined);

    /*
     * The first page is asked for here, in the same effect that clears the
     * rows — not from a separate one watching `assets.length`. An empty
     * listing that becomes empty again leaves that length at zero, so the
     * effect would not re-run: an empty library that has just been imported
     * into would go on saying it was empty, which is exactly what it did.
     */
    more();
  }, [query, generation, sort, more]);

  const pinPoster = useCallback((id: string, posterMs: number | null): void => {
    setAssets((held) => held.map((card) => (card.id === id ? { ...card, posterMs } : card)));
  }, []);

  const rename = useCallback((id: string, name: string): void => {
    setAssets((held) => held.map((card) => (card.id === id ? { ...card, name } : card)));
  }, []);

  /**
   * Gives the cards whose files changed a new thumbnail address (ADR-0047).
   *
   * The same shape as `pinPoster` and `rename` and for the same reason: the
   * grid is holding these cards and fetching every page again to learn one
   * number would throw away the scroll position and the pages below it.
   *
   * Ids this window is not showing are ignored rather than fetched — a page it
   * has not reached will carry the new key when it arrives.
   */
  const redraw = useCallback((redrawn: readonly WireRedrawn[]): void => {
    const moved = new Map(redrawn.map((one) => [one.id, one]));
    setAssets((held) => {
      let changed = false;
      const next = held.map((card) => {
        const one = moved.get(card.id);
        if (one === undefined) return card;
        // `null` is "nothing about the file was written", not "forget the key".
        const derivedAt = one.derivedAt ?? card.derivedAt;
        if (derivedAt === card.derivedAt && one.undrawn === card.undrawn) return card;
        changed = true;
        return { ...card, derivedAt, undrawn: one.undrawn };
      });
      // A new array for a batch that touched nothing on screen would re-render
      // the grid on every batch of a hundred-thousand-asset import.
      return changed ? next : held;
    });
  }, []);

  const drop = useCallback((ids: readonly string[]): void => {
    const gone = new Set(ids);
    setAssets((held) => held.filter((card) => !gone.has(card.id)));
  }, []);

  return { assets, done, loading, problem, more, pinPoster, rename, redraw, drop };
}
