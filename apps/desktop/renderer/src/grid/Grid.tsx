import type { AssetCard } from "@roost/contract";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { benchTarget } from "../bench/bench.js";
import { AssetCell, cellId } from "./AssetCell.js";
import {
  type Direction,
  type GridView,
  layout,
  moveFocus,
  type Rect,
  tilesIn,
  visibleTiles,
} from "./layout.js";
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

/** `PointerEvent.button`, for the two that mean something here. */
const PRIMARY = 0;
const SECONDARY = 2;

/** How far the pointer must travel before a press becomes a sweep. */
const SLOP = 4;

/** The band at the top and bottom of the viewport that a sweep scrolls from. */
const EDGE = 32;

/** How far past the viewport to keep rendered, so a fling has somewhere to land. */
const OVERSCAN = 900;

/** How close to the bottom asks for the next page. */
const PREFETCH = 1200;

/** The band under the thumbnail, reserved rather than overlaid. */
const CAPTION = 22;

export interface GridProps {
  readonly assets: readonly AssetCard[];
  readonly view: GridView;
  /** Icons take the asset's own shape rather than a square (ADR-0018). */
  readonly proportional: boolean;
  /** The zoom target: roughly how wide a cell wants to be. */
  readonly target: number;
  readonly selection: SelectionStore;
  readonly onMore: () => void;
  readonly onOpen?: (hash: string) => void;
}

export function Grid({
  assets,
  view,
  proportional,
  target,
  selection,
  onMore,
  onOpen,
}: GridProps): React.JSX.Element {
  const frame = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const sweeping = useRef<Sweep | undefined>(undefined);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [top, setTop] = useState(0);

  const grid = useMemo(
    () =>
      layout(assets, {
        view,
        proportional,
        containerWidth: width,
        target,
        gap: view === "details" ? 0 : 8,
        caption: CAPTION,
      }),
    [assets, view, proportional, width, target],
  );

  // The order is what Shift-click and the arrow keys move through, so it
  // follows the layout rather than being computed twice.
  useEffect(() => {
    selection.setOrder(grid.order.map((tile) => tile.hash));
  }, [grid, selection]);

  // Width and height come from the element, so the grid reflows with the window
  // and with the sidebar rather than from a media query guessing at both.
  // The scroll benchmark drives whatever actually scrolls, which is this
  // element and not the window.
  useEffect(() => {
    benchTarget(viewport.current);
    return () => benchTarget(null);
  }, []);

  useEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const measure = (): void => {
      // `clientWidth` includes the scroller's own padding, and laying out
      // against it makes every view one gutter too wide — the last column ends
      // up under the scrollbar with its right edge cut off. Only a real window
      // shows this: happy-dom does no layout and reports no padding, so the
      // tests were measuring a scroller that had none.
      const style = getComputedStyle(element);
      const padding = px(style.paddingLeft) + px(style.paddingRight);
      setWidth(Math.max(0, element.clientWidth - padding));
      setHeight(element.clientHeight);
      // The details header sits outside the scroller, so it is the one thing in
      // the frame that is not narrowed by the reserved scrollbar strip. Writing
      // the width rather than rendering it: it is one custom property, it
      // changes only on a resize, and the render below does not read it.
      frame.current?.style.setProperty(
        "--scrollbar",
        `${element.offsetWidth - element.clientWidth}px`,
      );
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

      // Not while a sweep is running: the selection changes every frame, focus
      // does not move with it, and scrolling an off-screen ring back into view
      // would drag the grid out from under the drag.
      if (sweeping.current !== undefined) return;

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

  /**
   * One step of a sweep, on a frame.
   *
   * Scrolls first if the pointer is holding at an edge, then selects what the
   * rect now covers — in that order, because the scroll is what changes which
   * cells the same pointer position is over.
   */
  const step = useCallback(() => {
    const sweep = sweeping.current;
    const element = viewport.current;
    const surface = canvas.current;
    if (sweep === undefined || element === null || surface === null) return;
    sweep.frame = undefined;

    // Measured from the box rather than from `clientHeight`: a DOM that does no
    // layout then reports no edge and asks for no further frame, instead of
    // driving this loop for ever.
    const box = element.getBoundingClientRect();
    let scrolled = 0;
    if (box.height > 0) {
      const above = sweep.clientY - (box.top + EDGE);
      const below = sweep.clientY - (box.bottom - EDGE);
      const pull = above < 0 ? above : below > 0 ? below : 0;
      if (pull !== 0) {
        const before = element.scrollTop;
        element.scrollTop = before + Math.max(-EDGE, Math.min(EDGE, pull));
        scrolled = element.scrollTop - before;
      }
    }

    // The canvas box moves with the scroll, so reading the pointer against it
    // gives content coordinates — and the origin, already in them, stays put
    // while the view travels under it.
    const surfaceBox = surface.getBoundingClientRect();
    const x = sweep.clientX - surfaceBox.left;
    const y = sweep.clientY - surfaceBox.top;
    const rect: Rect = {
      left: Math.min(sweep.origin.x, x),
      right: Math.max(sweep.origin.x, x),
      top: Math.min(sweep.origin.y, y),
      bottom: Math.max(sweep.origin.y, y),
    };

    const hashes = tilesIn(grid, rect).map((tile) => tile.hash);
    if (!same(hashes, sweep.swept)) {
      sweep.swept = hashes;
      selection.sweep(hashes, sweep.base);
    }
    setMarquee(rect);

    // Keep pulling while the pointer sits at the edge, even if it never moves
    // again — otherwise the sweep stops the moment the hand does.
    if (scrolled !== 0) sweep.frame = requestAnimationFrame(step);
  }, [grid, selection]);

  const beginSweep = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const element = viewport.current;
      const surface = canvas.current;
      if (element === null || surface === null) return;

      // The scrollbar strip is inside the element's box and outside its
      // content, and a press on it means "scroll", not "select nothing".
      if (event.clientX >= element.getBoundingClientRect().left + element.clientWidth) return;

      const surfaceBox = surface.getBoundingClientRect();
      sweeping.current = {
        pointerId: event.pointerId,
        origin: { x: event.clientX - surfaceBox.left, y: event.clientY - surfaceBox.top },
        startX: event.clientX,
        startY: event.clientY,
        // `Ctrl` adds to what was already selected rather than toggling through
        // it: a rect that grows and shrinks over the same cell would otherwise
        // flip it on and off as the hand wobbled.
        base: event.ctrlKey || event.metaKey ? new Set(selection.selected()) : undefined,
        clientX: event.clientX,
        clientY: event.clientY,
        active: false,
        swept: undefined,
        frame: undefined,
      };
      // Captured, so a sweep that leaves the window keeps arriving here.
      //
      // Best-effort: `setPointerCapture` throws for a pointer the browser does
      // not consider active, which is every synthetic one and a real one
      // released between the dispatch and this handler. Capture is what keeps a
      // drag alive *outside* the window; the sweep itself runs on the events it
      // receives either way, so losing it must not lose the gesture.
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // No capture. The drag still works while the pointer is over the grid.
      }
    },
    [selection],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const hash = hashAt(event.target);

      // The secondary button opens a menu over the selection, so it must not
      // collapse one. An asset already selected is left alone — right-clicking
      // one of twelve to export all twelve is the ordinary gesture — and one
      // that is not becomes the selection, which is what every file manager
      // does.
      if (event.button === SECONDARY) {
        if (hash === undefined) return selection.clear();
        if ((selection.stateOf(hash) & SELECTED) === 0) selection.click(hash);
        return;
      }

      if (hash === undefined) {
        // A press on the background is a sweep until it turns out to be a
        // click; the clear happens on release (`UI_SPEC.md` §6). Clearing here
        // instead would empty the inspector at the start of every drag.
        if (event.button === PRIMARY) return beginSweep(event);
        return selection.clear();
      }
      if (event.shiftKey) selection.extendTo(hash);
      else if (event.ctrlKey || event.metaKey) selection.toggle(hash);
      else selection.click(hash);
    },
    [selection, beginSweep],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const sweep = sweeping.current;
      if (sweep === undefined || event.pointerId !== sweep.pointerId) return;
      sweep.clientX = event.clientX;
      sweep.clientY = event.clientY;

      if (!sweep.active) {
        // A few pixels of slop, so a click from a shaky hand stays a click
        // rather than becoming a sweep of whatever it landed beside.
        if (
          Math.abs(event.clientX - sweep.startX) < SLOP &&
          Math.abs(event.clientY - sweep.startY) < SLOP
        ) {
          return;
        }
        sweep.active = true;
      }
      // One publish per frame, whatever the pointer is doing — the same rule
      // the scroll handler follows, and for the same reason.
      if (sweep.frame === undefined) sweep.frame = requestAnimationFrame(step);
    },
    [step],
  );

  const endSweep = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const sweep = sweeping.current;
      if (sweep === undefined || event.pointerId !== sweep.pointerId) return;
      sweeping.current = undefined;
      if (sweep.frame !== undefined) cancelAnimationFrame(sweep.frame);
      // The press that never travelled is the click on the background, and this
      // is where it clears — which is what keeps a mis-click recoverable
      // without a keyboard.
      if (!sweep.active) selection.clear();
      setMarquee(null);
    },
    [selection],
  );

  useEffect(
    () => () => {
      const sweep = sweeping.current;
      if (sweep?.frame !== undefined) cancelAnimationFrame(sweep.frame);
    },
    [],
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
    <div className="grid-frame" data-view={view} ref={frame}>
      {/*
        The header sits outside the scroller rather than sticking to the top of
        it: the cells are absolutely positioned from y=0, so a sticky row inside
        would cover the first one, and offsetting every tile to make room would
        put a view's decoration into the layout arithmetic.
      */}
      {view === "details" && (
        <div className="details-header" aria-hidden="true">
          <span />
          <span>Name</span>
          <span>Kind</span>
          <span>Size</span>
          <span>Dimensions</span>
          <span>Imported</span>
        </div>
      )}
      <div
        className="grid"
        data-view={view}
        data-sweeping={marquee === null ? undefined : ""}
        ref={viewport}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endSweep}
        onPointerCancel={endSweep}
        onLostPointerCapture={endSweep}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        role="listbox"
        aria-multiselectable
        aria-label="Assets"
        tabIndex={0}
      >
        <div className="grid-canvas" style={{ height: grid.height }} ref={canvas}>
          {marquee !== null && (
            <div
              className="grid-marquee"
              aria-hidden="true"
              style={{
                transform: `translate(${marquee.left}px, ${marquee.top}px)`,
                width: marquee.right - marquee.left,
                height: marquee.bottom - marquee.top,
              }}
            />
          )}
          {tiles.map((tile) => {
            const asset = byHash.get(tile.hash);
            return asset === undefined ? null : (
              <ConnectedCell
                key={tile.hash}
                asset={asset}
                view={view}
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
    </div>
  );
}

/** A marquee in flight, held on a ref because it changes faster than a render. */
interface Sweep {
  readonly pointerId: number;
  /** Where the drag began, in content coordinates, so scrolling does not move it. */
  readonly origin: { readonly x: number; readonly y: number };
  readonly startX: number;
  readonly startY: number;
  /** What an additive sweep adds to; `undefined` when it replaces instead. */
  readonly base: ReadonlySet<string> | undefined;
  clientX: number;
  clientY: number;
  /** Whether the press has travelled far enough to be a drag. */
  active: boolean;
  /** What was last applied, so a frame that changes nothing wakes nothing. */
  swept: readonly string[] | undefined;
  frame: number | undefined;
}

/** Whether a sweep found what it found last frame. Both are in result order. */
function same(a: readonly string[], b: readonly string[] | undefined): boolean {
  if (b === undefined || a.length !== b.length) return false;
  return a.every((hash, at) => hash === b[at]);
}

/** A computed length, or zero where there is no layout to read one from. */
function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
  view,
  x,
  y,
  width,
  height,
  selection,
}: {
  readonly asset: AssetCard;
  readonly view: GridView;
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
      view={view}
      size={asset.size}
      assetWidth={asset.width}
      assetHeight={asset.height}
      importedAt={asset.importedAt}
    />
  );
}

/** The hash of the cell a pointer event landed in, if it landed in one. */
function hashAt(target: EventTarget): string | undefined {
  if (!(target instanceof Element)) return undefined;
  return target.closest("[data-hash]")?.getAttribute("data-hash") ?? undefined;
}
