/**
 * Where every cell goes, as arithmetic rather than as CSS.
 *
 * The grid is virtualized, so the browser never sees most of these — the layout
 * has to be computable without laying anything out. Keeping it a pure function
 * is also what makes `UI_SPEC.md` §6's rules assertable: that a missing
 * dimension lays out square, that a panorama does not produce a cell taller than
 * the window, and that nothing overlaps.
 *
 * **Columns, not a flat list.** Masonry places each cell in the shortest column,
 * so cells are not in `y` order overall — but within one column they always are.
 * Culling then costs a binary search per column, with a column count in the
 * single digits, instead of a scan over nine hundred thousand rows per frame.
 * Uniform mode fills the same structure row-major, so both share one path.
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

export type GridMode = "masonry" | "uniform";

export interface LayoutOptions {
  readonly mode: GridMode;
  readonly containerWidth: number;
  /** The zoom target: roughly how wide a cell wants to be. */
  readonly target: number;
  readonly gap: number;
  /** The band under the thumbnail. Reserved, never an overlay (`UI_SPEC.md` §6). */
  readonly caption: number;
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
  const { mode, containerWidth, target, gap, caption } = options;
  const count = columnCountFor(containerWidth, target, gap);
  const columnWidth = Math.max(1, Math.floor((containerWidth - gap * (count - 1)) / count));

  const columns: Tile[][] = Array.from({ length: count }, () => []);
  const bottoms = new Array<number>(count).fill(0);
  const order: Tile[] = [];

  items.forEach((item, index) => {
    // Masonry packs into whichever column ends highest up; uniform keeps result
    // order, which is what makes it a *grid* rather than a second masonry.
    const column = mode === "masonry" ? shortest(bottoms) : index % count;
    const body = mode === "masonry" ? Math.round(columnWidth * ratioOf(item)) : columnWidth;
    const tile: Tile = {
      hash: item.hash,
      index,
      x: column * (columnWidth + gap),
      y: bottoms[column] ?? 0,
      width: columnWidth,
      height: body + caption,
    };
    columns[column]?.push(tile);
    order.push(tile);
    bottoms[column] = tile.y + tile.height + gap;
  });

  // The trailing gap is not part of the content, so it is taken back off.
  const height = Math.max(0, Math.max(0, ...bottoms) - gap);
  return { columns, columnWidth, height, order };
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
