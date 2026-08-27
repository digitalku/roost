import type { AssetCard } from "@roost/contract";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AssetCell, cellId } from "./AssetCell.js";
import { type Direction, type GridMode, layout, moveFocus, visibleTiles } from "./layout.js";
import { FOCUSED, SELECTED, type SelectionStore } from "./selection.js";

/**
 * The virtualized grid.
 *
 * Everything `UI_SPEC.md` §6 forbids is absent by construction rather than by
 * discipline: there is no context around the cells, no callback prop on a cell,
 * and no `setState` in a scroll handler — the handler stores the offset on a
 * ref and lets one animation frame publish it, so a fling costs one render per
 * frame rather than one per event.
 *
 * Pointer and keyboard handling live on the container, not on the cells. Four
 * hundred cells with three listeners each is twelve hundred closures to
 * allocate on every page; one listener reading `data-hash` off the event target
 * is none.
 */

/** How far past the viewport to keep rendered, so a fling has somewhere to land. */
const OVERSCAN = 900;

/** How close to the bottom asks for the next page. */
const PREFETCH = 1200;

/** The band under the thumbnail, reserved rather than overlaid. */
const CAPTION = 22;

export interface GridProps {
  readonly assets: readonly AssetCard[];
  readonly mode: GridMode;
  /** The zoom target: roughly how wide a cell wants to be. */
  readonly target: number;
  readonly selection: SelectionStore;
  readonly onMore: () => void;
  readonly onOpen?: (hash: string) => void;
}

export function Grid({
  assets,
  mode,
  target,
  selection,
  onMore,
  onOpen,
}: GridProps): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [top, setTop] = useState(0);

  const grid = useMemo(
    () => layout(assets, { mode, containerWidth: width, target, gap: 8, caption: CAPTION }),
    [assets, mode, width, target],
  );

  // The order is what Shift-click and the arrow keys move through, so it
  // follows the layout rather than being computed twice.
  useEffect(() => {
    selection.setOrder(grid.order.map((tile) => tile.hash));
  }, [grid, selection]);

  // Width and height come from the element, so the grid reflows with the window
  // and with the sidebar rather than from a media query guessing at both.
  useEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const measure = (): void => {
      setWidth(element.clientWidth);
      setHeight(element.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const pending = useRef<number | undefined>(undefined);
  const onScroll = useCallback(() => {
    // One publish per frame, whatever the wheel is doing. `roost-old` learned
    // this the other way round.
    if (pending.current !== undefined) return;
    pending.current = requestAnimationFrame(() => {
      pending.current = undefined;
      const element = viewport.current;
      if (element === null) return;
      setTop(element.scrollTop);
    });
  }, []);

  useEffect(
    () => () => {
      if (pending.current !== undefined) cancelAnimationFrame(pending.current);
    },
    [],
  );

  // Asking here rather than from the scroll handler: this runs after a render,
  // so it sees the rows the last page actually added and cannot ask twice for
  // the same one within a frame.
  useEffect(() => {
    if (grid.height > 0 && top + height + PREFETCH >= grid.height) onMore();
  }, [top, height, grid.height, onMore]);

  /**
   * The roving ring, written to the DOM rather than rendered.
   *
   * `aria-activedescendant` changes on every focus move, and re-rendering the
   * grid to update one attribute would re-run the four hundred cell components
   * this file exists to avoid waking. One attribute write and, when focus has
   * moved off screen, one scroll — which is the other half of what an arrow key
   * means.
   */
  useEffect(() => {
    const paint = (): void => {
      const element = viewport.current;
      const hash = selection.focused;
      if (element === null) return;
      if (hash === undefined) {
        element.removeAttribute("aria-activedescendant");
        return;
      }
      element.setAttribute("aria-activedescendant", cellId(hash));

      const tile = grid.order.find((candidate) => candidate.hash === hash);
      if (tile === undefined) return;
      const visibleTop = element.scrollTop;
      const visibleBottom = visibleTop + element.clientHeight;
      if (tile.y < visibleTop) element.scrollTop = tile.y;
      else if (tile.y + tile.height > visibleBottom) {
        element.scrollTop = tile.y + tile.height - element.clientHeight;
      }
    };

    // Painted once as well as on every change: the grid is unmounted while the
    // preview is open, and on the way back the focus it left with has to be on
    // the element and in view — which is also what makes stepping through the
    // preview leave the grid scrolled to where it ended up.
    paint();
    return selection.subscribeRevision(paint);
  }, [grid, selection]);

  const tiles = useMemo(
    () => visibleTiles(grid, top, top + Math.max(height, 1), OVERSCAN),
    [grid, top, height],
  );

  const byHash = useMemo(() => {
    const map = new Map<string, AssetCard>();
    for (const asset of assets) map.set(asset.hash, asset);
    return map;
  }, [assets]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const hash = hashAt(event.target);
      // A click on the background clears, which is what makes a mis-click
      // recoverable without a keyboard.
      if (hash === undefined) return selection.clear();
      if (event.shiftKey) selection.extendTo(hash);
      else if (event.ctrlKey || event.metaKey) selection.toggle(hash);
      else selection.click(hash);
    },
    [selection],
  );

  const onDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // The pointer-down that preceded this already selected and focused the
      // cell, so opening is all that is left to do.
      const hash = hashAt(event.target);
      if (hash !== undefined) onOpen?.(hash);
    },
    [onOpen],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const direction = DIRECTIONS[event.key];
      if (direction !== undefined) {
        event.preventDefault();
        const from = selection.focused ?? grid.order[0]?.hash;
        if (from === undefined) return;
        const to = selection.focused === undefined ? from : moveFocus(grid, from, direction);
        if (to === undefined) return;
        // Focus and selection are separate: holding Ctrl moves the ring alone.
        if (event.ctrlKey || event.metaKey) selection.focus(to);
        else selection.click(to);
        return;
      }

      if (event.key === " ") {
        event.preventDefault();
        selection.toggleFocused();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const hash = selection.focused;
        if (hash !== undefined) onOpen?.(hash);
        return;
      }
      if (event.key === "a" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        // What is loaded, which is all the grid can honestly promise over rows
        // it has never seen (`UI_SPEC.md` §6).
        selection.selectLoaded();
      }
    },
    [grid, selection, onOpen],
  );

  return (
    <div
      className="grid"
      ref={viewport}
      onScroll={onScroll}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      role="listbox"
      aria-multiselectable
      aria-label="Assets"
      tabIndex={0}
    >
      <div className="grid-canvas" style={{ height: grid.height }}>
        {tiles.map((tile) => {
          const asset = byHash.get(tile.hash);
          return asset === undefined ? null : (
            <ConnectedCell
              key={tile.hash}
              asset={asset}
              x={tile.x}
              y={tile.y}
              width={tile.width}
              height={tile.height}
              selection={selection}
            />
          );
        })}
      </div>
    </div>
  );
}

const DIRECTIONS: Readonly<Record<string, Direction | undefined>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * The subscription, kept out of the cell.
 *
 * This is the per-cell subscription `UI_SPEC.md` §6 asks for: it wakes only
 * when this hash's state changes, and what it passes down are two booleans. The
 * cell itself stays memo'd on primitives, so a wake that changes neither
 * re-renders nothing.
 */
function ConnectedCell({
  asset,
  x,
  y,
  width,
  height,
  selection,
}: {
  readonly asset: AssetCard;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly selection: SelectionStore;
}): React.JSX.Element {
  const subscribe = useMemo(() => selection.subscribe(asset.hash), [selection, asset.hash]);
  const snapshot = useCallback(() => selection.stateOf(asset.hash), [selection, asset.hash]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);

  return (
    <AssetCell
      hash={asset.hash}
      name={asset.name}
      ext={asset.ext}
      x={x}
      y={y}
      width={width}
      height={height}
      caption={CAPTION}
      isSelected={(state & SELECTED) !== 0}
      isFocused={(state & FOCUSED) !== 0}
    />
  );
}

/** The hash of the cell a pointer event landed in, if it landed in one. */
function hashAt(target: EventTarget): string | undefined {
  if (!(target instanceof Element)) return undefined;
  return target.closest("[data-hash]")?.getAttribute("data-hash") ?? undefined;
}
