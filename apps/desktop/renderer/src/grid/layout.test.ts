import { describe, expect, it } from "vitest";
import {
  columnCountFor,
  layout,
  moveFocus,
  rowThumb,
  type Shaped,
  type Tile,
  tilesIn,
  visibleTiles,
  ZOOMS,
  zoomBy,
  zoomFor,
} from "./layout.js";

const OPTIONS = {
  view: "icons",
  proportional: true,
  containerWidth: 1000,
  target: 240,
  gap: 8,
  caption: 20,
} as const;

function shaped(count: number, width: number | null = 800, height: number | null = 600): Shaped[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i.toString(16).padStart(64, "0"),
    width,
    height,
  }));
}

/** Whether any two tiles in one column overlap vertically. */
function overlaps(tiles: readonly Tile[]): boolean {
  const byColumn = new Map<number, Tile[]>();
  for (const tile of tiles) {
    const column = byColumn.get(tile.x) ?? [];
    column.push(tile);
    byColumn.set(tile.x, column);
  }
  for (const column of byColumn.values()) {
    column.sort((a, b) => a.y - b.y);
    for (let i = 1; i < column.length; i += 1) {
      const previous = column[i - 1];
      const current = column[i];
      if (previous === undefined || current === undefined) continue;
      if (current.y < previous.y + previous.height) return true;
    }
  }
  return false;
}

describe("choosing a column count", () => {
  it("fits as many columns of the target width as the container holds", () => {
    expect(columnCountFor(1000, 240, 8)).toBe(4);
    expect(columnCountFor(240, 240, 8)).toBe(1);
    // Never zero: a container narrower than one cell still draws one column,
    // clipped, rather than dividing by zero and rendering nothing.
    expect(columnCountFor(100, 240, 8)).toBe(1);
    expect(columnCountFor(0, 240, 8)).toBe(1);
  });
});

describe("laying out proportional icons", () => {
  it("packs into the shortest column and never overlaps", () => {
    const grid = layout(
      shaped(40).map((item, i) => ({ ...item, height: 200 + (i % 7) * 120 })),
      OPTIONS,
    );
    expect(grid.columns).toHaveLength(4);
    expect(overlaps(grid.order)).toBe(false);
    // Ragged by construction: equal column heights would mean it was not
    // packing by height at all.
    const bottoms = grid.columns.map((column) => {
      const last = column[column.length - 1];
      return last === undefined ? 0 : last.y + last.height;
    });
    expect(new Set(bottoms).size).toBeGreaterThan(1);
  });

  it("lays an asset with no recorded dimensions out square", () => {
    // `UI_SPEC.md` §6: a `.zip` and a not-yet-probed image both land here, and
    // both are ordinary members of the grid rather than broken ones.
    const grid = layout(shaped(1, null, null), OPTIONS);
    const [tile] = grid.order;
    expect(tile?.height).toBe(grid.columnWidth + OPTIONS.caption);
  });

  it("clamps a panorama rather than letting it own the window", () => {
    const grid = layout(shaped(1, 12_000, 400), OPTIONS);
    const [tile] = grid.order;
    // Unclamped this would be a cell 8px tall at a 244px column — the caption
    // band alone would be taller than the picture.
    expect(tile?.height).toBeGreaterThan(OPTIONS.caption + 90);

    const tall = layout(shaped(1, 400, 12_000), OPTIONS);
    const [tower] = tall.order;
    expect(tower?.height).toBeLessThan(700);
  });

  it("reports a height that does not include the trailing gap", () => {
    const grid = layout(shaped(4), OPTIONS);
    const lowest = Math.max(...grid.order.map((tile) => tile.y + tile.height));
    expect(grid.height).toBe(lowest);
  });

  it("is empty for no items, without a negative height", () => {
    const grid = layout([], OPTIONS);
    expect(grid.order).toEqual([]);
    expect(grid.height).toBe(0);
  });
});

describe("laying out a uniform grid", () => {
  it("keeps result order across the row, and gives every cell one shape", () => {
    const grid = layout(shaped(9), { ...OPTIONS, proportional: false });
    // Row-major: the first four are the first row, left to right.
    expect(grid.order.slice(0, 4).map((tile) => tile.x)).toEqual(
      [0, 1, 2, 3].map((i) => i * (grid.columnWidth + OPTIONS.gap)),
    );
    expect(new Set(grid.order.map((tile) => tile.height)).size).toBe(1);
    expect(overlaps(grid.order)).toBe(false);
  });

  it("ignores the aspect ratio, which is what makes it the uniform view", () => {
    const grid = layout(shaped(4, 12_000, 400), { ...OPTIONS, proportional: false });
    expect(new Set(grid.order.map((tile) => tile.height)).size).toBe(1);
  });
});

describe("culling to what is on screen", () => {
  it("returns what intersects the viewport, in result order", () => {
    const grid = layout(shaped(400), OPTIONS);
    const visible = visibleTiles(grid, 0, 800, 0);

    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(grid.order.length);
    expect(visible.map((tile) => tile.index)).toEqual(
      [...visible].map((tile) => tile.index).sort((a, b) => a - b),
    );
    for (const tile of visible) {
      expect(tile.y).toBeLessThan(800);
      expect(tile.y + tile.height).toBeGreaterThan(0);
    }
  });

  it("misses nothing: every tile in the band is returned", () => {
    // The binary search is the part that could silently drop a row, and a
    // dropped row is a hole in the grid that only appears at one scroll offset.
    const grid = layout(
      shaped(500).map((item, i) => ({ ...item, height: 200 + (i % 11) * 90 })),
      OPTIONS,
    );
    for (const top of [0, 137, 1500, 4021, grid.height - 300]) {
      const bottom = top + 600;
      const found = new Set(visibleTiles(grid, top, bottom, 0).map((tile) => tile.index));
      const expected = grid.order
        .filter((tile) => tile.y < bottom && tile.y + tile.height > top)
        .map((tile) => tile.index);
      expect([...found].sort((a, b) => a - b)).toEqual(expected);
    }
  });

  it("widens the band by the overscan", () => {
    const grid = layout(shaped(400), OPTIONS);
    const tight = visibleTiles(grid, 2000, 2600, 0).length;
    const loose = visibleTiles(grid, 2000, 2600, 600).length;
    expect(loose).toBeGreaterThan(tight);
  });

  it("costs the same near the end as near the start", () => {
    // Keyset paging is pointless if the layout scans. This is the layout's half
    // of the same promise: the work is a binary search per column.
    const grid = layout(shaped(20_000), OPTIONS);
    const early = visibleTiles(grid, 0, 900, 400).length;
    const late = visibleTiles(grid, grid.height - 900, grid.height, 400).length;
    expect(Math.abs(early - late)).toBeLessThan(early);
  });
});

describe("what a marquee sweeps", () => {
  // Uniform, so the arithmetic in the assertions is readable: four columns of
  // 244px on a 1000px container, and every cell 244 + 20 tall.
  const uniform = () =>
    layout(shaped(16), { ...OPTIONS, proportional: false, view: "icons" as const });

  it("takes a tile it touches, not only one it encloses", () => {
    const grid = uniform();
    const first = grid.order[0];
    if (first === undefined) throw new Error("expected a tile");

    // A rect over the bottom-right corner of the first cell and nothing else.
    const swept = tilesIn(grid, {
      left: first.x + first.width - 4,
      top: first.y + first.height - 4,
      right: first.x + first.width - 1,
      bottom: first.y + first.height - 1,
    });
    expect(swept.map((tile) => tile.index)).toEqual([0]);
  });

  it("takes every tile the rect crosses, in result order", () => {
    const grid = uniform();
    const swept = tilesIn(grid, { left: 0, top: 0, right: 1000, bottom: 10 });
    // The whole first row, and nothing from the second.
    expect(swept.map((tile) => tile.index)).toEqual([0, 1, 2, 3]);
  });

  it("skips the columns it is nowhere near", () => {
    const grid = uniform();
    const swept = tilesIn(grid, { left: 0, top: 0, right: 4, bottom: 10 });
    expect(swept.map((tile) => tile.index)).toEqual([0]);
  });

  it("sweeps nothing when the rect has no area", () => {
    // What makes a press on the background a click rather than a sweep of
    // whatever happens to sit under the pointer.
    const grid = uniform();
    expect(tilesIn(grid, { left: 300, top: 300, right: 300, bottom: 300 })).toEqual([]);
  });

  it("reaches past the loaded window, because content coordinates do", () => {
    const grid = uniform();
    const swept = tilesIn(grid, { left: 0, top: 0, right: 1000, bottom: 100_000 });
    expect(swept).toHaveLength(16);
  });
});

describe("moving focus with the arrow keys", () => {
  const uniform = { ...OPTIONS, proportional: false } as const;

  it("moves by geometry, not by index", () => {
    const grid = layout(shaped(12), uniform);
    const first = grid.order[0]?.id ?? "";
    // Four columns: right is the next result, down is four along.
    expect(moveFocus(grid, first, "right")).toBe(grid.order[1]?.id);
    expect(moveFocus(grid, first, "down")).toBe(grid.order[4]?.id);
    expect(moveFocus(grid, grid.order[5]?.id ?? "", "up")).toBe(grid.order[1]?.id);
    expect(moveFocus(grid, grid.order[5]?.id ?? "", "left")).toBe(grid.order[4]?.id);
  });

  it("stops at the edge rather than wrapping", () => {
    // Wrapping in a grid this long is a jump of thousands of rows, which is
    // not what an arrow key means anywhere else.
    const grid = layout(shaped(12), uniform);
    expect(moveFocus(grid, grid.order[0]?.id ?? "", "up")).toBeUndefined();
    expect(moveFocus(grid, grid.order[0]?.id ?? "", "left")).toBeUndefined();
    const last = grid.order[grid.order.length - 1]?.id ?? "";
    expect(moveFocus(grid, last, "down")).toBeUndefined();
    expect(moveFocus(grid, last, "right")).toBeUndefined();
  });

  it("lands beside what the eye is looking at in a ragged masonry", () => {
    const grid = layout(
      shaped(24).map((item, i) => ({ ...item, height: i % 2 === 0 ? 1400 : 400 })),
      OPTIONS,
    );
    const start = grid.columns[1]?.[2];
    const landed = grid.columns[0]?.find(
      (tile) => tile.id === moveFocus(grid, start?.id ?? "", "left"),
    );

    expect(landed).toBeDefined();
    // Whatever it landed on overlaps the row the eye was on, which moving by
    // index through a ragged layout would not guarantee.
    const centre = (start?.y ?? 0) + (start?.height ?? 0) / 2;
    expect(landed?.y).toBeLessThanOrEqual(centre);
    expect((landed?.y ?? 0) + (landed?.height ?? 0)).toBeGreaterThanOrEqual(centre);
  });

  it("says nothing about a id the layout does not hold", () => {
    const grid = layout(shaped(4), uniform);
    expect(moveFocus(grid, "nothing", "down")).toBeUndefined();
  });
});

describe("a zoom per view", () => {
  // ADR-0039 §10: an icon's width and a row's height are different quantities,
  // so each view snaps to its own steps and starts at its own size.
  it("starts each view at its own size where the library holds none", () => {
    expect(zoomFor("icons", undefined)).toBe(ZOOMS.icons.initial);
    expect(zoomFor("compact", undefined)).toBe(ZOOMS.compact.initial);
    // Details was right as it was (2026-09-25): a 34px row, a 26px thumbnail.
    expect(zoomFor("details", undefined)).toBe(34);
    expect(rowThumb(34)).toBe(26);
  });

  it("snaps a stored zoom to the nearest of that view's steps", () => {
    expect(zoomFor("icons", 230)).toBe(240);
    expect(zoomFor("details", 45)).toBe(42);
    // An icon's width read as a row's height lands on the tallest row rather
    // than off the end of the scale.
    expect(zoomFor("compact", 240)).toBe(72);
  });

  it("moves every step, and stops at the ends", () => {
    // The zoom these replaced divided a cell width down and clamped it, so
    // two steps at each end of a row view moved nothing.
    const heights = ZOOMS.details.steps.map(
      (step) => layout(shaped(1), { ...OPTIONS, view: "details", target: step }).order[0]?.height,
    );
    expect(new Set(heights).size).toBe(ZOOMS.details.steps.length);
    const last = ZOOMS.details.steps[ZOOMS.details.steps.length - 1] ?? 0;
    expect(zoomBy("details", last, 1)).toBe(last);
    expect(zoomBy("icons", 160, -1)).toBe(120);
    expect(zoomBy("icons", 120, -1)).toBe(120);
  });

  it("widens a compact column with its row", () => {
    const small = layout(shaped(1), { ...OPTIONS, view: "compact", target: 30 });
    const large = layout(shaped(1), { ...OPTIONS, view: "compact", target: 72 });
    expect(small.columns.length).toBeGreaterThan(large.columns.length);
  });
});

describe("a break between a folder's own assets and its subfolders' (ADR-0059)", () => {
  const items = shaped(7);
  const breakBefore = { id: items[5]?.id ?? "", height: 32 };

  it("starts a fresh row below a band across every column", () => {
    const plain = layout(items, { ...OPTIONS, proportional: false });
    const broken = layout(items, { ...OPTIONS, proportional: false, breakBefore });
    const columns = plain.columns.length;
    expect(columns).toBeGreaterThan(2);

    const first = broken.order[5];
    const last = broken.order[4];
    expect(broken.divider).not.toBeNull();
    // The band begins below the rows above it, and the next tile below the band.
    expect(broken.divider?.y).toBeGreaterThanOrEqual((last?.y ?? 0) + (last?.height ?? 0));
    expect(first?.x).toBe(0);
    expect(first?.y).toBe((broken.divider?.y ?? 0) + 32 + OPTIONS.gap);
    expect(broken.order[6]?.x).toBe(broken.order[1]?.x);
    expect(broken.height).toBeGreaterThan(plain.height);
    expect(overlaps(broken.order)).toBe(false);
  });

  it("draws the band at the top when the folder holds nothing of its own", () => {
    const broken = layout(items, {
      ...OPTIONS,
      breakBefore: { id: items[0]?.id ?? "", height: 32 },
    });
    expect(broken.divider).toEqual({ y: 0, height: 32 });
    expect(broken.order[0]?.y).toBe(32 + OPTIONS.gap);
  });

  it("packs proportional icons below the band too", () => {
    const broken = layout(items, { ...OPTIONS, proportional: true, breakBefore });
    const above = broken.order.slice(0, 5);
    const lowest = Math.max(...above.map((tile) => tile.y + tile.height));
    expect(broken.divider?.y).toBeGreaterThanOrEqual(lowest);
    for (const tile of broken.order.slice(5)) {
      expect(tile.y).toBeGreaterThanOrEqual((broken.divider?.y ?? 0) + 32);
    }
  });

  it("has none where nothing asked for one", () => {
    expect(layout(items, OPTIONS).divider).toBeNull();
  });
});
