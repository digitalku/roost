import {
  measureScroll,
  type ScrollOptions,
  type ScrollRefusal,
  type ScrollResult,
} from "./scroll.js";

/**
 * What a benchmark script can reach from outside the page.
 *
 * Two numbers and one function, on the app's own origin, in a sandboxed
 * renderer that has no other authority. It is always present rather than behind
 * a flag: a benchmark you have to remember to enable is one that gets run
 * against a build that did not have it, and the whole surface is a timestamp
 * and a scroll loop.
 */

export interface RoostBench {
  /** When the grid first had rows on screen, as `Date.now()`. */
  firstPaintAt?: number;
  /** Drives the grid and reports frame percentiles. */
  scroll(options?: ScrollOptions): Promise<ScrollResult | ScrollRefusal>;
}

declare global {
  interface Window {
    roostBench?: RoostBench;
  }
}

/**
 * Records when the grid first had something to show.
 *
 * The end of cold start (`ROADMAP.md` M3): not when the window opened, not when
 * the engine replied, but when there is a grid with rows in it. Set once —
 * a later re-page is not a cold start.
 */
export function markFirstPaint(): void {
  const bench = ensure();
  bench.firstPaintAt ??= Date.now();
}

/** Points the scroll benchmark at the element that actually scrolls. */
export function benchTarget(element: HTMLElement | null): void {
  target = element;
}

let target: HTMLElement | null = null;

function ensure(): RoostBench {
  window.roostBench ??= {
    scroll: (options) =>
      target === null
        ? Promise.resolve({ refused: "no grid is on screen" })
        : measureScroll(target, options),
  };
  return window.roostBench;
}

// Installed on load so a script can find it before anything has been opened.
ensure();
