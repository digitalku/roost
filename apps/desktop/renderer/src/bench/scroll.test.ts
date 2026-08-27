import { describe, expect, it, vi } from "vitest";
import { FRAME_BUDGET_MS, measureScroll, summarize } from "./scroll.js";

describe("summarising frame intervals", () => {
  it("reports percentiles as frames that actually happened", () => {
    // Nearest-rank, not interpolated: a percentile whose job is "how bad does
    // it get" must not invent an interval nobody waited.
    const intervals = [16, 16, 16, 16, 16, 16, 16, 16, 16, 100];
    const result = summarize(intervals, 4000);

    expect(result.medianMs).toBe(16);
    expect(result.p99Ms).toBe(100);
    expect(result.worstMs).toBe(100);
    expect(result.frames).toBe(11);
    expect(result.scrolledPx).toBe(4000);
  });

  it("counts a hitch against the run's own rhythm, not against sixty", () => {
    // The measurement that caught this: the first real run held a median of
    // 8.3ms, and reading it against a 60fps budget alone would call a grid that
    // skipped every other frame flawless. Both figures are reported now.
    const at120 = Array.from({ length: 20 }, (_, i) => (i % 4 === 0 ? 25 : 8.3));
    const result = summarize(at120, 0);

    expect(result.steadyHz).toBe(120);
    expect(result.missed).toBe(5);
    expect(result.missedPercent).toBe(25);
    expect(result.over60).toBe(5);
  });

  it("puts a uniformly slower run in the rate rather than in the misses", () => {
    // Nothing hitched — the whole run was slower — and that is the honest place
    // for it. The 60fps figure is what says it was slower than the target.
    const halved = Array.from({ length: 20 }, () => 16.7);
    const result = summarize(halved, 0);

    expect(result.steadyHz).toBe(60);
    expect(result.missed).toBe(0);
    expect(result.over60).toBe(20);
    expect(FRAME_BUDGET_MS).toBeCloseTo(16.67, 1);
  });

  it("reports the rate a run held", () => {
    const result = summarize([16, 16, 17, 16, 34, 16, 16, 16, 16, 16], 0);
    expect(result.steadyHz).toBe(63);
    // 34ms is two vsyncs; 17ms is not.
    expect(result.missed).toBe(1);
    expect(result.over60).toBe(2);
    expect(result.fps).toBeGreaterThan(50);
  });

  it("survives a run with no intervals at all", () => {
    const result = summarize([], 0);
    expect(result).toMatchObject({ frames: 1, medianMs: 0, missed: 0, steadyHz: 0, fps: 0 });
  });
});

describe("refusing to report", () => {
  const grid = (scrollHeight: number): HTMLElement => {
    const element = document.createElement("div");
    Object.defineProperty(element, "clientHeight", { value: 800, configurable: true });
    Object.defineProperty(element, "scrollHeight", { value: scrollHeight, configurable: true });
    return element;
  };

  it("refuses when the window is not visible", async () => {
    // Chromium throttles rAF to a crawl for a hidden window, and the numbers
    // that come out are not slow — they are meaningless. Reporting them would
    // read as a catastrophic regression against a real measurement.
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      expect(await measureScroll(grid(50_000))).toEqual({
        refused: "the window is hidden, so frames are throttled",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses when there is nothing to scroll", async () => {
    expect(await measureScroll(grid(400))).toEqual({ refused: "there is nothing to scroll" });
  });

  it("refuses when too few frames arrived to mean anything", async () => {
    // The visibility check does not catch an occluded window or a compositor
    // that stopped; a frame count far below the expected rate does.
    let now = 0;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      // Two frames a second: what a throttled window actually looks like.
      now += 500;
      queueMicrotask(() => fn(now));
      return 0;
    });
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const result = await measureScroll(grid(50_000), { durationMs: 4000 });
    expect(result).toMatchObject({ refused: expect.stringContaining("not composited") });

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports when the frames arrive at a plausible rate", async () => {
    let now = 0;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      now += 16;
      queueMicrotask(() => fn(now));
      return 0;
    });
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const element = grid(50_000);
    const result = await measureScroll(element, { durationMs: 1000, speed: 40 });

    expect(result).toMatchObject({ medianMs: 16, missed: 0, steadyHz: 63 });
    expect("refused" in result).toBe(false);
    // It actually moved the grid, so a run over a short list is visible in the
    // result rather than being reported as a fast one.
    expect((result as { scrolledPx: number }).scrolledPx).toBeGreaterThan(0);

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
