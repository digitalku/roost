import type { AssetCard, WireCursor, WireProblem } from "@roost/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../bridge.js";

/**
 * The grid's pages, fetched one cursor at a time.
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
}

export function useAssetPages(query: string, generation: number): Paging {
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

  /*
   * The dependencies here are the *trigger*, not values the body reads: a new
   * query or a new library is what makes the rows already held wrong rather
   * than merely incomplete.
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
  }, [query, generation]);

  const more = useCallback(() => {
    if (inFlight.current || finished.current) return;
    inFlight.current = true;
    const mine = listing.current;
    setLoading(true);

    void (async () => {
      const outcome = await invoke({
        type: "assets:page",
        query,
        limit: PAGE_SIZE,
        after: cursor.current,
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
  }, [query]);

  // The first page is not the caller's job: a grid with no rows has nothing to
  // scroll, so nothing would ever ask for one.
  useEffect(() => {
    if (assets.length === 0 && !finished.current && !inFlight.current) more();
  }, [assets.length, more]);

  return { assets, done, loading, problem, more };
}
