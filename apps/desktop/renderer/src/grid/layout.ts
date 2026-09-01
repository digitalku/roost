/**
 * Where every cell goes, as arithmetic rather than as CSS.
 *
 * The grid is virtualized, so the browser never sees most of these — the layout
 * has to be computable without laying anything out. Keeping it a pure function
 * is also what makes `UI_SPEC.md` §6's rules assertable: that a missing
 * dimension lays out square, that a panorama does not produce a cell taller than
 * the window, and that nothing overlaps.
 *
 * **Columns, not a flat list.** Proportional icons place each cell in the
 * shortest column, so cells are not in `y` order overall — but within one column
 * they always are. Culling then costs a binary search per column, with a column
 * count in the single digits, instead of a scan over nine hundred thousand rows
 * per frame. Every other view fills the same structure row-major, so all four
 * share one path.
 *
 * **Every view scrolls vertically**, including Compact. A file manager's compact
 * view flows down a column and wraps to the next, which means scrolling
 * sideways; here it wraps the other way. Two scroll axes in one window is
 * jarring, and the culling, the prefetch, and the roving ring are all written
 * against `y` — see `UI_SPEC.md` §6.
 */

/** What the layout needs to know about one asset. */
export interface Shaped {
  readonly hash: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface Tile {
  readonly hash: string;
  /** Position in the result set, which is what the keyboard moves through. */
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  /** The whole cell: the thumbnail band plus the reserved caption band. */
  readonly height: number;
}

export interface Layout {
  readonly columns: readonly (readonly Tile[])[];
  readonly columnWidth: number;
  /** The scrollable height, so the scrollbar is right before anything renders. */
  readonly height: number;
  /** Every tile in result order, for the keyboard and for `Ctrl+A`. */
  readonly order: readonly Tile[];
}

/** The three views the view menu offers (ADR-0018). */
export const GRID_VIEWS = ["icons", "compact", "details"] as const;
export type GridView = (typeof GRID_VIEWS)[number];

export function isGridView(value: string): value is GridView {
  return (GRID_VIEWS as readonly string[]).includes(value);
}

/** The zoom targets, snapped rather than free (`UI_SPEC.md` §6). */
export const ZOOM_STEPS = [120, 160, 200, 240, 300, 360, 400] as const;
export const DEFAULT_ZOOM = 240;

/** Moves along {@link ZOOM_STEPS}, stopping at the ends. */
export function zoomBy(target: number, steps: number): number {
  const at = ZOOM_STEPS.indexOf(target as (typeof ZOOM_STEPS)[number]);
  const from = at === -1 ? ZOOM_STEPS.indexOf(DEFAULT_ZOOM) : at;
  const to = Math.min(ZOOM_STEPS.length - 1, Math.max(0, from + steps));
  return ZOOM_STEPS[to] ?? DEFAULT_ZOOM;
}

export interface LayoutOptions {
  readonly view: GridView;
  /**
   * Icons take the asset's own shape rather than a square.
   *
   * A property of how an icon is drawn rather than a fourth view, which is what
   * it always was (ADR-0018). Ignored by the other two views: a compact row and
   * a details row have no picture to be shaped by.
   */
  readonly proportional: boolean;
  readonly containerWidth: number;
  /** The zoom target: roughly how wide an icon wants to be. */
  readonly target: number;
  readonly gap: number;
  /** The band under the thumbnail. Reserved, never an overlay (`UI_SPEC.md` §6). */
  readonly caption: number;
}

/**
 * A compact column has to hold a name beside its thumbnail, so it is wider than
 * the zoom target and never narrower than this.
 */
const COMPACT_MIN_WIDTH = 260;

/** What a row is worth at a given zoom, clamped so neither end is unusable. */
function rowHeight(target: number, divisor: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.round(target / divisor)));
}

/**
 * How far from square a cell may get.
 *
 * A 12000×400 panorama at a 240px column would otherwise be a cell 7200px tall
 * — taller than the window, so it would be the only thing on screen and the
 * scrollbar would be lying about how much is left. Clamping crops the preview
 * rather than the grid.
 */
const MIN_RATIO = 0.4;
const MAX_RATIO = 2.5;

export function columnCountFor(containerWidth: number, target: number, gap: number): number {
  if (containerWidth <= 0 || target <= 0) return 1;
  return Math.max(1, Math.floor((containerWidth + gap) / (target + gap)));
}

export function layout(items: readonly Shaped[], options: LayoutOptions): Layout {
  const { view, proportional, containerWidth, target, gap, caption } = options;

  // Details is one row per asset across the whole width; compact needs room for
  // a name, so it does not follow the zoom target directly.
  const count =
    view === "details"
      ? 1
      : columnCountFor(
          containerWidth,
          view === "compact" ? Math.max(COMPACT_MIN_WIDTH, target + 120) : target,
          gap,
        );
  const columnWidth = Math.max(1, Math.floor((containerWidth - gap * (count - 1)) / count));

  // Only icons reserve a band under the picture. The other two put the name
  // beside it, so there is nothing to reserve.
  const band = view === "icons" ? caption : 0;
  const packed = view === "icons" && proportional;

  const columns: Tile[][] = Array.from({ length: count }, () => []);
  const bottoms = new Array<number>(count).fill(0);
  const order: Tile[] = [];

  items.forEach((item, index) => {
    // Proportional icons pack into whichever column ends highest up; everything
    // else keeps result order, which is what makes it a *grid* rather than a
    // second masonry.
    const column = packed ? shortest(bottoms) : index % count;
    const body = bodyHeight(view, packed, columnWidth, target, item);
    const tile: Tile = {
      hash: item.hash,
      index,
      x: column * (columnWidth + gap),
      y: bottoms[column] ?? 0,
      width: columnWidth,
      height: body + band,
    };
    columns[column]?.push(tile);
    order.push(tile);
    bottoms[column] = tile.y + tile.height + gap;
  });

  // The trailing gap is not part of the content, so it is taken back off.
  const height = Math.max(0, Math.max(0, ...bottoms) - gap);
  return { columns, columnWidth, height, order };
}

/** How tall the picture-or-row part of a cell is, before any caption band. */
function bodyHeight(
  view: GridView,
  packed: boolean,
  columnWidth: number,
  target: number,
  item: Shaped,
): number {
  if (view === "compact") return rowHeight(target, 5, 32, 72);
  if (view === "details") return rowHeight(target, 7, 26, 48);
  return packed ? Math.round(columnWidth * ratioOf(item)) : columnWidth;
}

/**
 * An asset with no recorded dimensions lays out square.
 *
 * `UI_SPEC.md` §6 permits exactly one reflow for this: when metadata arrives,
 * the cell takes its real shape. Everything the derive queue has not reached
 * yet, and everything that has no shape at all — a `.zip`, a font — stays here.
 */
function ratioOf(item: Shaped): number {
  const { width, height } = item;
  if (width === null || height === null || width <= 0 || height <= 0) return 1;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, height / width));
}

function shortest(bottoms: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < bottoms.length; i += 1) {
    if ((bottoms[i] ?? 0) < (bottoms[best] ?? 0)) best = i;
  }
  return best;
}

/**
 * The tiles that intersect `[top, bottom)`, plus whatever `overscan` adds.
 *
 * A binary search per column, so the cost is the number of columns times the
 * log of a column's length — not the length of the result set. That is the
 * difference between a grid that scrolls the same at row 900,000 as at row 100
 * and one that does not.
 */
export function visibleTiles(grid: Layout, top: number, bottom: number, overscan: number): Tile[] {
  const from = top - overscan;
  const to = bottom + overscan;
  const found: Tile[] = [];

  for (const column of grid.columns) {
    for (let i = firstBelow(column, from); i < column.length; i += 1) {
      const tile = column[i];
      if (tile === undefined || tile.y >= to) break;
      found.push(tile);
    }
  }
  // In result order, so the DOM order matches reading order — which is what a
  // screen reader and a `Tab` into the grid both follow.
  return found.sort((a, b) => a.index - b.index);
}

/** The first tile whose bottom edge is at or past `y`. */
function firstBelow(column: readonly Tile[], y: number): number {
  let low = 0;
  let high = column.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const tile = column[mid];
    if (tile !== undefined && tile.y + tile.height <= y) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** A region of the canvas, in content coordinates. */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * The tiles a marquee touches.
 *
 * **Touching, not enclosing** (`UI_SPEC.md` §6). Enclosing is unusable in
 * proportional Icons, where a cell is routinely taller than the sweep that was
 * meant to catch it, and touching is what every file manager does.
 *
 * The same binary search per column as {@link visibleTiles}, for the same
 * reason: a sweep runs once per frame, so it cannot afford to look at rows it
 * is nowhere near. A degenerate rect touches nothing, which is what makes a
 * click on the background a click rather than a sweep of whatever sits under
 * the pointer.
 */
export function tilesIn(grid: Layout, rect: Rect): Tile[] {
  const found: Tile[] = [];
  if (rect.right <= rect.left || rect.bottom <= rect.top) return found;

  for (const column of grid.columns) {
    // Every tile in a column shares its x and width, so one of them answers for
    // the column and a column the sweep misses costs nothing.
    const first = column[0];
    if (first === undefined) continue;
    if (first.x >= rect.right || first.x + first.width <= rect.left) continue;

    for (let i = firstBelow(column, rect.top); i < column.length; i += 1) {
      const tile = column[i];
      if (tile === undefined || tile.y >= rect.bottom) break;
      found.push(tile);
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

export type Direction = "left" | "right" | "up" | "down";

/**
 * Where an arrow key moves focus.
 *
 * By geometry rather than by index, because in masonry the two are not the same
 * thing: the cell to the right of a tall one is often several results away, and
 * moving by index would send focus somewhere the eye did not follow. Up and
 * down walk the tile's own column; left and right cross to the neighbouring
 * column and land on whatever is nearest the current vertical centre.
 *
 * Returns `undefined` at the edge, so the caller can leave focus where it is
 * rather than wrapping — wrapping in a grid this long would be a jump of
 * thousands of rows.
 */
export function moveFocus(grid: Layout, from: string, direction: Direction): string | undefined {
  const found = locate(grid, from);
  if (found === undefined) return undefined;
  const [column, row] = found;

  if (direction === "up" || direction === "down") {
    const next = grid.columns[column]?.[row + (direction === "up" ? -1 : 1)];
    return next?.hash;
  }

  const target = column + (direction === "left" ? -1 : 1);
  const neighbour = grid.columns[target];
  const tile = grid.columns[column]?.[row];
  if (neighbour === undefined || tile === undefined) return undefined;
  return nearestTo(neighbour, tile.y + tile.height / 2)?.hash;
}

function locate(grid: Layout, hash: string): [number, number] | undefined {
  for (let column = 0; column < grid.columns.length; column += 1) {
    const row = grid.columns[column]?.findIndex((tile) => tile.hash === hash) ?? -1;
    if (row !== -1) return [column, row];
  }
  return undefined;
}

function nearestTo(column: readonly Tile[], centre: number): Tile | undefined {
  let best: Tile | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const tile of column) {
    const distance = Math.abs(tile.y + tile.height / 2 - centre);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = tile;
    }
  }
  return best;
}
