/**
 * The scroll benchmark (`UI_SPEC.md` §6, `ROADMAP.md` M3).
 *
 * The frame budget is an acceptance criterion, not a later optimisation, so it
 * is measured rather than eyeballed: this drives the grid at a fixed speed and
 * reports frame-interval percentiles.
 *
 * **It refuses to report when the window is not being composited.** Chromium
 * throttles `requestAnimationFrame` to a crawl for a hidden or occluded window,
 * and the numbers that come out of one are not slow — they are meaningless. A
 * benchmark that reports them anyway is worse than one that does not run:
 * `roost-old` measured 0.25% dropped frames while flinging through 79,800
 * assets, and a run that quietly returned 200ms frames would look like a
 * catastrophic regression against it.
 */

/**
 * The 60fps budget `CONCEPT.md` §7 names, in milliseconds.
 *
 * A target, not the display's period. A 120Hz screen misses a frame at 8.3ms
 * and is still comfortably inside this — which is why the result reports both.
 */
export const FRAME_BUDGET_MS = 1000 / 60;

/**
 * A frame is counted as *missed* at this multiple of the run's own rhythm.
 *
 * 1.5 rather than 2, so a single skipped vsync counts: at 120Hz the interval
 * after one skip is 16.7ms, which is under twice 8.3 by rounding alone.
 */
const MISSED_VSYNC_RATIO = 1.5;

export interface ScrollResult {
  readonly frames: number;
  readonly elapsedMs: number;
  /** Frames a second, over the whole run. */
  readonly fps: number;
  /**
   * The rate the run actually held, from the median interval.
   *
   * Not the panel's rate — `screen.refreshRate` does not exist, and there is no
   * way to ask. It is what the two miss counts are read against: a run whose
   * rhythm is steady at 120 and a run steady at 60 are both "no misses", and
   * the difference between them is here rather than there.
   */
  readonly steadyHz: number;
  /**
   * Intervals at or past {@link MISSED_VSYNC_RATIO} of that steady rhythm — a
   * hitch, relative to what the run was otherwise managing.
   *
   * A rate that is *uniformly* halved shows up in `steadyHz` and not here,
   * which is the honest place for it: nothing hitched, the whole run was slower.
   */
  readonly missed: number;
  readonly missedPercent: number;
  /** Intervals past the 60fps budget, which is the figure `CONCEPT.md` §7 names. */
  readonly over60: number;
  readonly over60Percent: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly worstMs: number;
  /** How far the grid was scrolled, so a run over a short list is visible. */
  readonly scrolledPx: number;
}

/** Why a run produced no numbers. Never a `ScrollResult` with bad numbers in it. */
export interface ScrollRefusal {
  readonly refused: string;
}

export interface ScrollOptions {
  /** Pixels per frame. 40 at 60Hz is a brisk flick, not a crawl. */
  readonly speed?: number;
  /** How long to drive for, in milliseconds. */
  readonly durationMs?: number;
}

/**
 * The interval between consecutive frames, as percentiles.
 *
 * Intervals rather than callback durations: what a user sees is when the next
 * frame arrives, and a callback that returns in 2ms after waiting 200ms for a
 * frame is a 200ms stall however fast the callback was.
 */
export async function measureScroll(
  element: HTMLElement,
  options: ScrollOptions = {},
): Promise<ScrollResult | ScrollRefusal> {
  const speed = options.speed ?? 40;
  const durationMs = options.durationMs ?? 4000;

  if (document.visibilityState !== "visible") {
    return { refused: `the window is ${document.visibilityState}, so frames are throttled` };
  }
  if (element.scrollHeight <= element.clientHeight) {
    return { refused: "there is nothing to scroll" };
  }

  const stamps = await drive(element, speed, durationMs);
  const scrolledPx = element.scrollTop;

  // Fewer frames than a tenth of the expected rate means the window was not
  // being composited after all — occluded, on another workspace, or drawn by a
  // compositor that stopped. The visibility check does not catch every case.
  const expected = durationMs / FRAME_BUDGET_MS;
  if (stamps.length < Math.max(10, expected / 10)) {
    return {
      refused: `only ${stamps.length} frames in ${durationMs}ms — the window was not composited`,
    };
  }

  const intervals = [];
  for (let i = 1; i < stamps.length; i += 1) {
    intervals.push((stamps[i] ?? 0) - (stamps[i - 1] ?? 0));
  }
  return summarize(intervals, scrolledPx);
}

/** Scrolls at `speed` pixels a frame, recording when each frame arrived. */
function drive(element: HTMLElement, speed: number, durationMs: number): Promise<number[]> {
  return new Promise((resolve) => {
    const stamps: number[] = [];
    const started = performance.now();
    let down = true;

    const frame = (now: number): void => {
      stamps.push(now);
      // Turns around at the ends rather than stopping: a benchmark that ran off
      // the bottom would measure an idle grid for the rest of its duration.
      const limit = element.scrollHeight - element.clientHeight;
      if (down && element.scrollTop >= limit) down = false;
      if (!down && element.scrollTop <= 0) down = true;
      element.scrollTop += down ? speed : -speed;

      if (now - started < durationMs) requestAnimationFrame(frame);
      else resolve(stamps);
    };

    requestAnimationFrame(frame);
  });
}

export function summarize(intervals: readonly number[], scrolledPx: number): ScrollResult {
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = percentile(sorted, 50);
  const elapsed = intervals.reduce((total, interval) => total + interval, 0);

  const missed = intervals.filter(
    (interval) => median > 0 && interval >= median * MISSED_VSYNC_RATIO,
  ).length;
  const over60 = intervals.filter((interval) => interval > FRAME_BUDGET_MS).length;
  const denominator = Math.max(1, intervals.length);

  return {
    frames: intervals.length + 1,
    elapsedMs: round(elapsed),
    fps: round(elapsed > 0 ? (intervals.length / elapsed) * 1000 : 0),
    steadyHz: median > 0 ? Math.round(1000 / median) : 0,
    missed,
    missedPercent: round((missed / denominator) * 100),
    over60,
    over60Percent: round((over60 / denominator) * 100),
    medianMs: round(median),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    worstMs: round(sorted[sorted.length - 1] ?? 0),
    scrolledPx: Math.round(scrolledPx),
  };
}

/**
 * Nearest-rank, so every reported value is a frame that actually happened.
 *
 * Interpolating would invent an interval nobody waited, which for a percentile
 * whose whole job is "how bad does it get" is the wrong direction to round.
 */
function percentile(sorted: readonly number[], rank: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.ceil((rank / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, at))] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
