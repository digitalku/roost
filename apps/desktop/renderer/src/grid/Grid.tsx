import type { AssetCard, SidebarFolderRow } from "@roost/contract";
import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { benchTarget } from "../bench/bench.js";
import { ASSET_DRAG_TYPE, carriesAssets, draggedAssets } from "../dnd.js";
import { FolderContextMenu } from "../FolderContextMenu.js";
import { AssetCell, cellId } from "./AssetCell.js";
import { FolderCell } from "./FolderCell.js";
import { folderTileId, isFolderTile } from "./folderTiles.js";
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
 * allocate on every page; one listener reading `data-id` off the event target
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

/**
 * The folders drawn ahead of the assets, and everything they can do (ADR-0043).
 *
 * One object rather than seven props, and it is the one object here that may be
 * allocated per render — it is the grid's prop, not a cell's, so the rule in
 * `UI_SPEC.md` §6 does not reach it. The window memoizes it anyway, because
 * `rows` changing is what re-lays the grid out.
 *
 * Absent where there are no tiles to draw, which is everywhere except a query
 * that is one folder's own contents: the window decides that, because it is the
 * window that knows what the query says.
 */
export interface FolderTiles {
  readonly rows: readonly SidebarFolderRow[];
  /** Descend: the row's own query, applied exactly as a sidebar click does. */
  readonly onOpen: (row: SidebarFolderRow) => void;
  readonly onNewFolder: (parent: SidebarFolderRow) => void;
  readonly onRename: (row: SidebarFolderRow) => void;
  readonly onMoveFolder: (folder: number, parent: number | null) => void;
  readonly onDelete: (row: SidebarFolderRow) => void;
  /**
   * Assets dropped on a tile (`UI_SPEC.md` §4.3).
   *
   * `copy` is the answer to "was `Ctrl` held" and nothing more. Whether the
   * drop is a move is the window's decision, as it is for the pane — and from
   * inside a folder it always is.
   */
  readonly onDropAssets: (row: SidebarFolderRow, ids: readonly string[], copy: boolean) => void;
}

export interface GridProps {
  readonly assets: readonly AssetCard[];
  readonly view: GridView;
  /** Icons take the asset's own shape rather than a square (ADR-0018). */
  readonly proportional: boolean;
  /** The zoom target: roughly how wide a cell wants to be. */
  readonly target: number;
  readonly selection: SelectionStore;
  readonly onMore: () => void;
  readonly onOpen?: (id: string) => void;
  /** The subfolders of the folder on screen, where there is one (ADR-0043). */
  readonly folders?: FolderTiles;
}

export function Grid({
  assets,
  view,
  proportional,
  target,
  selection,
  onMore,
  onOpen,
  folders,
}: GridProps): React.JSX.Element {
  const frame = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const sweeping = useRef<Sweep | undefined>(undefined);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [top, setTop] = useState(0);

  /**
   * The folder tiles ahead of the assets (ADR-0043).
   *
   * They have no dimensions, which is what the layout already does with an
   * asset that has none: it lays it out square. So a folder needs no case in
   * `layout()` at all, and in proportional Icons the shortest-column packing
   * puts them across the first row because they come first.
   */
  const items = useMemo(() => {
    const rows = folders?.rows ?? [];
    if (rows.length === 0) return assets;
    return [
      ...rows.map((row) => ({ id: folderTileId(row.folder), width: null, height: null })),
      ...assets,
    ];
  }, [assets, folders]);

  const grid = useMemo(
    () =>
      layout(items, {
        view,
        proportional,
        containerWidth: width,
        target,
        gap: view === "details" ? 0 : 8,
        caption: CAPTION,
      }),
    [items, view, proportional, width, target],
  );

  // The order is what Shift-click and the arrow keys move through, so it
  // follows the layout rather than being computed twice.
  //
  // **Assets only.** The store's order is what `Ctrl+A` selects and what a
  // `Shift`-click ranges over, and a folder is not a result (ADR-0043 §4) — so
  // leaving the tiles out here is the whole of how they stay out of every edit,
  // rather than a filter each of those has to remember. The arrow keys move
  // through the *layout's* order, which still holds them.
  useEffect(() => {
    selection.setOrder(grid.order.map((tile) => tile.id).filter((id) => !isFolderTile(id)));
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
      const id = selection.focused;
      if (element === null) return;
      if (id === undefined) {
        element.removeAttribute("aria-activedescendant");
        element.removeAttribute("data-roving");
        return;
      }
      element.setAttribute("aria-activedescendant", cellId(id));
      // A cell is carrying the ring, so the frame gives up its own — the same
      // rule the cells already follow among themselves (`UI_SPEC.md` §6). It is
      // written here because it is the same fact as the line above, and for the
      // same reason: one attribute rather than four hundred re-renders.
      element.setAttribute("data-roving", "");

      // Not while a sweep is running: the selection changes every frame, focus
      // does not move with it, and scrolling an off-screen ring back into view
      // would drag the grid out from under the drag.
      if (sweeping.current !== undefined) return;

      const tile = grid.order.find((candidate) => candidate.id === id);
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
    for (const asset of assets) map.set(asset.id, asset);
    return map;
  }, [assets]);

  const byFolder = useMemo(() => {
    const map = new Map<string, SidebarFolderRow>();
    for (const row of folders?.rows ?? []) map.set(folderTileId(row.folder), row);
    return map;
  }, [folders]);

  /** The folder a pointer event landed in, if it landed in a tile. */
  const folderAt = useCallback(
    (target: EventTarget): SidebarFolderRow | undefined => {
      const id = hashAt(target);
      return id === undefined ? undefined : byFolder.get(id);
    },
    [byFolder],
  );

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

    // A sweep selects assets. A folder tile it crosses is passed over rather
    // than picked up: the marquee's result is what the inspector and every edit
    // read (ADR-0043 §4).
    const ids = tilesIn(grid, rect)
      .map((tile) => tile.id)
      .filter((id) => !isFolderTile(id));
    if (!same(ids, sweep.swept)) {
      sweep.swept = ids;
      selection.sweep(ids, sweep.base);
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

  /**
   * A press on an already-selected cell, waiting to find out what it was.
   *
   * A ref rather than state: nothing renders differently while it is held, and
   * it is written and read inside handlers in the same gesture.
   */
  const pendingClick = useRef<string | undefined>(undefined);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const id = hashAt(event.target);

      // The secondary button opens a menu over the selection, so it must not
      // collapse one. An asset already selected is left alone — right-clicking
      // one of twelve to export all twelve is the ordinary gesture — and one
      // that is not becomes the selection, which is what every file manager
      // does.
      if (event.button === SECONDARY) {
        if (id === undefined) return selection.clear();
        // A folder is marked rather than selected, so the same rule reads one
        // step differently: right-clicking a tile makes it the marked one, and
        // the menu that opens over it is the folder's, not the assets'.
        if (isFolderTile(id)) return selection.focusOnly(id);
        if ((selection.stateOf(id) & SELECTED) === 0) selection.click(id);
        return;
      }

      /*
       * A folder tile takes the mark and clears the selection (ADR-0043 §5).
       *
       * Before the modifiers, because none of them means anything here: there
       * is no range to extend to a folder and nothing to add it to. Opening is
       * the double-click, which is what Explorer does — and what a hand that
       * learned Explorer will do whether or not this build agrees.
       */
      if (id !== undefined && isFolderTile(id)) {
        if (event.button === PRIMARY) selection.focusOnly(id);
        return;
      }

      if (id === undefined) {
        // A press on the background is a sweep until it turns out to be a
        // click; the clear happens on release (`UI_SPEC.md` §6). Clearing here
        // instead would empty the inspector at the start of every drag.
        if (event.button === PRIMARY) return beginSweep(event);
        return selection.clear();
      }
      if (event.shiftKey) return selection.extendTo(id);
      if (event.ctrlKey || event.metaKey) return selection.toggle(id);

      /*
       * A press on a cell that is **already selected** changes nothing yet.
       *
       * Collapsing the selection here is what every file manager defers, and
       * for one reason: pressing one of five selected assets is how a drag of
       * five begins, and a press that collapses first leaves one. Found by
       * driving a real window on 2026-09-07 — the drag carried a single asset
       * however many were selected, and every component test passed because
       * `fireEvent.dragStart` fires no pointer event before it.
       *
       * So the click is remembered and settled on release, unless a drag has
       * taken the press first.
       */
      if ((selection.stateOf(id) & SELECTED) !== 0) {
        pendingClick.current = id;
        return;
      }
      selection.click(id);
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
      // The press on an already-selected cell, settling now that it turns out
      // not to have been a drag.
      const pending = pendingClick.current;
      pendingClick.current = undefined;
      if (pending !== undefined) selection.click(pending);

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
      const id = hashAt(event.target);
      if (id === undefined) return;
      const row = byFolder.get(id);
      if (row !== undefined) return folders?.onOpen(row);
      onOpen?.(id);
    },
    [onOpen, byFolder, folders],
  );

  /**
   * The grid is a drag source (`UI_SPEC.md` §4.3).
   *
   * One listener on the container, like every other gesture here — `dragstart`
   * bubbles, and the id comes back off the DOM rather than out of four
   * hundred closures. What travels is the **selection**, not the cell under the
   * pointer: `pointerdown` has already run by the time a drag starts, and it
   * selects an unselected cell exactly as a right-click does, so dragging one
   * of twelve selected assets drags all twelve.
   *
   * The payload is ids under a Roost-only media type. `DropZone` takes a
   * drop only when the types include `Files`, which an internal drag never
   * carries — so the import overlay stays out of the way without either of them
   * knowing about the other.
   */
  const onDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const id = hashAt(event.target);
      if (id === undefined) return;
      // A folder tile is not a drag source here. Re-parenting by dragging is
      // the tree's gesture (`UI_SPEC.md` §4.3) and ADR-0043 §5 leaves it there;
      // what must not happen is a folder id travelling as an asset payload.
      if (isFolderTile(id)) return event.preventDefault();
      // The press became a drag, so it was never a click: the selection stands
      // as it was, which is the whole point of deferring it.
      pendingClick.current = undefined;
      const dragged = selection.selected();
      const ids = dragged.includes(id) ? dragged : [id];
      event.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(ids));
      // Both, because the drop decides which: into a folder from a folder is a
      // move, from anywhere else there is nothing to move out of.
      event.dataTransfer.effectAllowed = "copyMove";

      const cell = event.target instanceof Element ? event.target.closest(".cell") : null;
      if (cell !== null) {
        const ghost = dragGhost(cell, ids.length);
        event.dataTransfer.setDragImage(ghost, GHOST_ANCHOR, GHOST_ANCHOR);
        requestAnimationFrame(() => ghost.remove());
      }
    },
    [selection],
  );

  /**
   * The tile a drag is hovering, marked on the element rather than in state.
   *
   * `dragover` fires continuously while the hand is still, so a `setState` here
   * would re-render the grid several times a second for one outline
   * (`CLAUDE.md` §8). The same reasoning as the roving ring above.
   */
  const over = useRef<Element | null>(null);
  const markOver = useCallback((cell: Element | null) => {
    if (over.current === cell) return;
    over.current?.removeAttribute("data-over");
    over.current = cell;
    cell?.setAttribute("data-over", "");
  }, []);

  useEffect(() => () => markOver(null), [markOver]);

  /**
   * Assets dropped on a folder tile (`UI_SPEC.md` §4.3, ADR-0043 §5).
   *
   * The tile inherits the pane's rule rather than restating it: the window
   * decides whether this is a move, and from inside a folder it always is —
   * which is what a file manager does when a file is dragged onto a folder
   * beside it.
   */
  const onDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const row = folderAt(event.target);
      if (row === undefined || !carriesAssets(event.dataTransfer)) return markOver(null);
      // Both halves are required: without `preventDefault` on *every*
      // `dragover` the browser refuses the drop, and `dropEffect` is what the
      // cursor shows the hand.
      event.preventDefault();
      event.dataTransfer.dropEffect = event.ctrlKey ? "copy" : "move";
      markOver(event.target instanceof Element ? event.target.closest(".cell") : null);
    },
    [folderAt, markOver],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const row = folderAt(event.target);
      markOver(null);
      if (row === undefined || !carriesAssets(event.dataTransfer)) return;
      event.preventDefault();
      const ids = draggedAssets(event.dataTransfer);
      if (ids.length > 0) folders?.onDropAssets(row, ids, event.ctrlKey);
    },
    [folderAt, folders, markOver],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const direction = DIRECTIONS[event.key];
      if (direction !== undefined) {
        event.preventDefault();
        const from = selection.focused ?? grid.order[0]?.id;
        if (from === undefined) return;
        const to = selection.focused === undefined ? from : moveFocus(grid, from, direction);
        if (to === undefined) return;
        // A folder is marked, never selected — the same thing the pointer does,
        // and the reason the ring can rest on a tile at all.
        if (isFolderTile(to)) selection.focusOnly(to);
        // Focus and selection are separate: holding Ctrl moves the ring alone.
        else if (event.ctrlKey || event.metaKey) selection.focus(to);
        else selection.click(to);
        return;
      }

      if (event.key === " ") {
        event.preventDefault();
        // Nothing to toggle on a folder: it is the one thing in the grid that
        // cannot be part of a selection.
        if (selection.focused === undefined || isFolderTile(selection.focused)) return;
        selection.toggleFocused();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const id = selection.focused;
        if (id === undefined) return;
        const row = byFolder.get(id);
        if (row !== undefined) return folders?.onOpen(row);
        onOpen?.(id);
        return;
      }
      if (event.key === "a" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        // What is loaded, which is all the grid can honestly promise over rows
        // it has never seen (`UI_SPEC.md` §6).
        selection.selectLoaded();
      }
    },
    [grid, selection, onOpen, byFolder, folders],
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
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={() => markOver(null)}
        onDrop={onDrop}
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
            const row = byFolder.get(tile.id);
            if (row !== undefined && folders !== undefined) {
              return (
                <FolderContextMenu
                  key={tile.id}
                  row={row}
                  onNewFolder={folders.onNewFolder}
                  onRename={folders.onRename}
                  onMoveFolder={folders.onMoveFolder}
                  onDelete={folders.onDelete}
                >
                  <ConnectedFolderCell
                    row={row}
                    view={view}
                    x={tile.x}
                    y={tile.y}
                    width={tile.width}
                    height={tile.height}
                    selection={selection}
                    // The grid is itself inside the asset menu's trigger, so
                    // without this a right-click here opens both menus over one
                    // another. Radix's own handler is merged onto the same
                    // element and still runs; what stops is the bubble.
                    onContextMenu={stopBubble}
                  />
                </FolderContextMenu>
              );
            }
            const asset = byHash.get(tile.id);
            return asset === undefined ? null : (
              <ConnectedCell
                key={tile.id}
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
  return a.every((id, at) => id === b[at]);
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
 * when this id's state changes, and what it passes down are two booleans. The
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
  const subscribe = useMemo(() => selection.subscribe(asset.id), [selection, asset.id]);
  const snapshot = useCallback(() => selection.stateOf(asset.id), [selection, asset.id]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);

  return (
    <AssetCell
      id={asset.id}
      name={asset.name}
      ext={asset.ext}
      posterMs={asset.posterMs}
      derivedAt={asset.derivedAt}
      x={x}
      y={y}
      width={width}
      height={height}
      caption={CAPTION}
      isSelected={(state & SELECTED) !== 0}
      isFocused={(state & FOCUSED) !== 0}
      view={view}
      size={asset.size ?? 0}
      assetWidth={asset.width}
      assetHeight={asset.height}
      importedAt={asset.importedAt}
    />
  );
}

/**
 * A folder tile's subscription, which is the focus bit and nothing else.
 *
 * The mark on a folder is the ring: a folder is never selected, because the
 * selection is what every edit reads (ADR-0043 §4). The props and the ref are
 * forwarded because this sits inside a Radix trigger — the folder's own menu,
 * the same one the tree draws.
 */
const ConnectedFolderCell = forwardRef<
  HTMLDivElement,
  {
    readonly row: SidebarFolderRow;
    readonly view: GridView;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly selection: SelectionStore;
  } & React.ComponentPropsWithoutRef<"div">
>(function ConnectedFolderCell({ row, view, x, y, width, height, selection, ...rest }, ref) {
  const id = folderTileId(row.folder);
  const subscribe = useMemo(() => selection.subscribe(id), [selection, id]);
  const snapshot = useCallback(() => selection.stateOf(id), [selection, id]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);

  return (
    <FolderCell
      {...rest}
      ref={ref}
      id={id}
      name={row.name}
      count={row.count}
      x={x}
      y={y}
      width={width}
      height={height}
      caption={CAPTION}
      isFocused={(state & FOCUSED) !== 0}
      view={view}
    />
  );
});

/** Keeps a right-click on a folder tile out of the asset menu's trigger. */
function stopBubble(event: React.MouseEvent): void {
  event.stopPropagation();
}

/**
 * The picture a drag carries under the cursor (`UI_SPEC.md` §4.3).
 *
 * **Not the cell.** A browser's default drag image is a snapshot of the element
 * being dragged, and a grid cell at a comfortable zoom is several hundred
 * pixels square — it covered the sidebar it was being dragged *to*, which is
 * the one thing the hand needs to see. Reported from a real window on
 * 2026-09-07.
 *
 * The thumbnail is **cloned**, not re-fetched: it is the same `roost://`
 * address the cell already drew, so Chromium has it decoded and the ghost is
 * painted in the frame it is asked for. A cell with no thumbnail — a `.zip`,
 * anything still in the derive queue — carries its extension instead, which is
 * what the cell itself shows.
 *
 * It goes in the document because `setDragImage` snapshots a **rendered**
 * element, and comes out on the next frame: the snapshot is taken
 * synchronously, so nothing needs it after that.
 */
function dragGhost(cell: Element, count: number): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";

  const thumbnail = cell.querySelector(".cell-image");
  if (thumbnail instanceof HTMLImageElement && !thumbnail.hidden) {
    ghost.append(thumbnail.cloneNode(true));
  } else {
    const kind = document.createElement("span");
    kind.className = "drag-ghost-kind";
    kind.textContent = cell.querySelector(".cell-kind")?.textContent ?? "file";
    ghost.append(kind);
  }

  if (count > 1) {
    const badge = document.createElement("span");
    badge.className = "drag-ghost-count";
    badge.textContent = String(count);
    ghost.append(badge);
  }

  document.body.append(ghost);
  return ghost;
}

/** Half the ghost's side, so it hangs centred under the pointer. */
const GHOST_ANCHOR = 32;

/** The id of the cell a pointer event landed in, if it landed in one. */
function hashAt(target: EventTarget): string | undefined {
  if (!(target instanceof Element)) return undefined;
  return target.closest("[data-id]")?.getAttribute("data-id") ?? undefined;
}
