import type { SidebarFolderRow } from "@roost/contract";
import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASSET_DRAG_TYPE } from "../dnd.js";
import { FakeEngine, fakeAsset, install } from "../testing/fake-engine.js";
import { Grid } from "./Grid.js";
import type { GridView } from "./layout.js";
import { SelectionStore } from "./selection.js";

/**
 * The grid, driven the way a person drives it.
 *
 * happy-dom does no layout, so `clientWidth` and `clientHeight` are zero and
 * the grid would lay out one column of nothing. They are stubbed to a plausible
 * window — which is honest about what this covers: the wiring, the selection,
 * the keyboard, and the culling. What it cannot cover is whether the result
 * *looks* right, and no unit test in any DOM implementation can.
 */

const WIDTH = 1000;
const HEIGHT = 800;

function sized(): void {
  for (const [name, value] of [
    ["clientWidth", WIDTH],
    ["clientHeight", HEIGHT],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
  }
}

describe("the grid", () => {
  let selection: SelectionStore;
  let more: () => void;
  let moreCalls: string[];

  const show = (
    count: number,
    proportional = false,
    onDragOut?: (ids: readonly string[]) => boolean,
  ) => {
    const assets = Array.from({ length: count }, (_, i) => fakeAsset(i));
    const view = render(
      <Grid
        assets={assets}
        view="icons"
        proportional={proportional}
        target={240}
        selection={selection}
        onMore={more}
        onOpen={onOpen}
        {...(onDragOut === undefined ? {} : { onDragOut })}
      />,
    );
    return { user: userEvent.setup(), assets, ...view };
  };

  const onOpen = vi.fn();

  beforeEach(() => {
    sized();
    selection = new SelectionStore();
    moreCalls = [];
    more = () => moreCalls.push("more");
    onOpen.mockClear();
    // Frames run immediately: the scroll handler publishes through one, and a
    // test that waited for a real frame would be waiting on a compositor that
    // is not there.
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      fn(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    // happy-dom reports no padding, and the layout depends on the width it
    // leaves — so this says so rather than inheriting whatever the last test
    // that stubbed it left behind.
    vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "0px", paddingRight: "0px" }));
  });

  it("renders only what is near the viewport", () => {
    show(2000);
    const drawn = screen.getAllByRole("option");
    // Four columns of ~250px cells over an 800px window plus overscan: a long
    // way short of two thousand, and the whole point of the exercise.
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(200);
  });

  describe("before the first page", () => {
    const waiting = (assets = 0) =>
      render(
        <Grid
          assets={Array.from({ length: assets }, (_, i) => fakeAsset(i))}
          view="icons"
          proportional={false}
          target={240}
          selection={selection}
          onMore={more}
          loading
        />,
      );

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("draws nothing for the first 150ms, so a quick page does not flash", () => {
      waiting();
      act(() => {
        vi.advanceTimersByTime(149);
      });
      expect(document.querySelectorAll(".cell-skeleton")).toHaveLength(0);
    });

    it("then draws skeleton cells, as many as the window holds and no more", () => {
      waiting();
      act(() => {
        vi.advanceTimersByTime(150);
      });
      const cells = document.querySelectorAll(".cell-skeleton");
      // Four columns of ~250px cells over an 800px window: a screenful, and a
      // long way short of the hundred and sixty it was laid out from.
      expect(cells.length).toBeGreaterThan(4);
      expect(cells.length).toBeLessThan(40);
      // Not options: nothing in them can be selected, and the grid says it is
      // busy instead (`UI_SPEC.md` §8).
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");
    });

    it("gives way to the assets the moment they arrive", () => {
      const { rerender } = waiting();
      act(() => {
        vi.advanceTimersByTime(150);
      });
      rerender(
        <Grid
          assets={[fakeAsset(0)]}
          view="icons"
          proportional={false}
          target={240}
          selection={selection}
          onMore={more}
          loading
        />,
      );
      expect(document.querySelectorAll(".cell-skeleton")).toHaveLength(0);
      expect(screen.getAllByRole("option")).toHaveLength(1);
      expect(screen.getByRole("listbox").hasAttribute("aria-busy")).toBe(false);
    });
  });

  it("points the thumbnail at roost:// and never at a data URL", () => {
    // Invariant 12 and ADR-0008: bytes reach the window over the protocol, and
    // Chromium owns the decode and the cache.
    const { assets } = show(4);
    const image = document.querySelector<HTMLImageElement>(".cell-image");
    const src = image?.getAttribute("src") ?? "";
    expect(src.startsWith(`roost://thumb/${assets[0]?.id}@256`)).toBe(true);
    expect(src.startsWith("data:")).toBe(false);
  });

  it("puts the derive time in the thumbnail's address, so an edited file redraws", () => {
    // The response is served `immutable` for a year, and under version 2 the
    // bytes behind an id can change (RL-20) — so an `<img>` whose `src` did not
    // change is one Chromium never asks about again (ADR-0047).
    const { assets } = show(1);
    const first = document.querySelector<HTMLImageElement>(".cell-image");
    expect(first?.getAttribute("src")).toContain(`v=${assets[0]?.derivedAt}`);
  });

  it("hides a thumbnail that could not be loaded, so the placeholder shows", () => {
    // A zip, a BMP, anything still in the derive queue: the cell asks for a
    // thumbnail and gets a 404, and Chromium draws its own broken icon over the
    // placeholder unless the image takes itself out of the way.
    show(4);
    const image = document.querySelector(".cell-image") as HTMLImageElement;

    fireEvent.error(image);

    expect(image.hidden).toBe(true);
    expect(image?.getAttribute("loading")).toBe("lazy");
  });

  it("shows the extension for every cell, whether or not a thumbnail arrives", () => {
    // `UI_SPEC.md` §6: a library holds anything, so a `.zip` is an ordinary
    // member of the grid rather than a broken image.
    render(
      <Grid
        assets={[fakeAsset(0, { ext: "zip", name: "backup.zip", width: null, height: null })]}
        view="icons"
        proportional={false}
        target={240}
        selection={selection}
        onMore={more}
      />,
    );
    expect(screen.getByText("zip")).toBeDefined();
  });

  it("lays out inside the scroller's padding, not over it", () => {
    // Found in a real window on 2026-08-30: `clientWidth` includes the
    // scroller's own padding, so every view was one gutter too wide and the
    // rightmost column ran under the scrollbar with its edge cut off. happy-dom
    // reports no padding, which is why no test saw it — so this one says what
    // the padding is.
    const PADDING = 12;
    vi.stubGlobal("getComputedStyle", () => ({
      paddingLeft: `${PADDING}px`,
      paddingRight: `${PADDING}px`,
    }));
    show(60);

    const cells = screen.getAllByRole("option");
    const right = Math.max(
      ...cells.map((cell) => {
        const x = Number(/translate\((-?[\d.]+)px/.exec(cell.style.transform)?.[1] ?? "0");
        return x + Number.parseFloat(cell.style.width);
      }),
    );
    expect(right).toBeLessThanOrEqual(WIDTH - PADDING * 2);
  });

  it("keeps a selection when one of it is right-clicked, and moves one when it is not", async () => {
    // The context menu acts on the selection, so the gesture that opens it must
    // not collapse one: right-clicking one of twelve to export all twelve is the
    // ordinary case, and `click` would have left one selected.
    const { user, assets } = show(12);
    const cells = screen.getAllByRole("option");

    await user.click(cells[0] as HTMLElement);
    await user.keyboard("{Shift>}");
    await user.click(cells[2] as HTMLElement);
    await user.keyboard("{/Shift}");
    expect(selection.selected()).toHaveLength(3);

    await user.pointer({ keys: "[MouseRight]", target: cells[1] as HTMLElement });
    expect(selection.selected()).toHaveLength(3);

    await user.pointer({ keys: "[MouseRight]", target: cells[7] as HTMLElement });
    expect(selection.selected()).toEqual([assets[7]?.id]);
  });

  it("selects with a click, adds with ctrl, and extends with shift", async () => {
    const { user, assets } = show(12);
    const cells = screen.getAllByRole("option");

    await user.click(cells[0] as HTMLElement);
    expect(selection.selected()).toEqual([assets[0]?.id]);

    await user.keyboard("{Control>}");
    await user.click(cells[3] as HTMLElement);
    await user.keyboard("{/Control}");
    expect(selection.selected()).toEqual([assets[0]?.id, assets[3]?.id]);

    await user.keyboard("{Shift>}");
    await user.click(cells[5] as HTMLElement);
    await user.keyboard("{/Shift}");
    expect(selection.selected()).toEqual([3, 4, 5].map((i) => assets[i]?.id));
  });

  it("clears when the click lands on the background", async () => {
    const { user } = show(12);
    await user.click(screen.getAllByRole("option")[2] as HTMLElement);
    expect(selection.size).toBe(1);

    await user.click(screen.getByRole("listbox"));
    expect(selection.size).toBe(0);
  });

  /**
   * A drag on the background, in the coordinates happy-dom gives.
   *
   * It lays nothing out, so every box it reports is at the origin with no size
   * — which makes a client coordinate a content coordinate here, and makes the
   * autoscroll silent, since a viewport with no height has no edge to pull
   * from. The layout arithmetic is real either way: four columns of 244px.
   */
  const drag = (
    from: readonly [number, number],
    to: readonly [number, number],
    modifier: { ctrlKey?: boolean } = {},
  ): void => {
    const grid = screen.getByRole("listbox");
    const [x, y] = from;
    const [toX, toY] = to;
    fireEvent.pointerDown(grid, { button: 0, pointerId: 1, clientX: x, clientY: y, ...modifier });
    fireEvent.pointerMove(grid, { pointerId: 1, clientX: toX, clientY: toY });
    fireEvent.pointerUp(grid, { pointerId: 1, clientX: toX, clientY: toY });
  };

  it("sweeps up everything a drag on the background crosses", () => {
    const { assets } = show(40);
    // Across the first row, into the third column and no further.
    drag([0, 0], [600, 10]);
    expect(selection.selected()).toEqual([assets[0]?.id, assets[1]?.id, assets[2]?.id]);
  });

  it("takes a cell the sweep only touches, rather than one it encloses", () => {
    // `UI_SPEC.md` §6: enclosing is unusable in proportional icons, where a
    // cell is routinely taller than the sweep meant to catch it.
    const { assets } = show(40);
    drag([0, 0], [4, 4]);
    expect(selection.selected()).toEqual([assets[0]?.id]);
  });

  it("adds to the selection when the drag starts with ctrl held", () => {
    const { assets } = show(40);
    fireEvent.pointerDown(screen.getAllByRole("option")[8] as HTMLElement, {
      button: 0,
      pointerId: 1,
    });
    expect(selection.selected()).toEqual([assets[8]?.id]);

    drag([0, 0], [300, 10], { ctrlKey: true });
    expect(selection.selected()).toEqual([assets[0]?.id, assets[1]?.id, assets[8]?.id]);
  });

  it("stays a click when the pointer barely moves, and still clears", () => {
    const { assets } = show(40);
    fireEvent.pointerDown(screen.getAllByRole("option")[8] as HTMLElement, {
      button: 0,
      pointerId: 1,
    });
    expect(selection.selected()).toEqual([assets[8]?.id]);

    // Two pixels of travel is a shaky hand, not a sweep — and a press on the
    // background that never becomes a drag clears on release.
    drag([500, 500], [502, 501]);
    expect(selection.size).toBe(0);
  });

  it("does not haul the viewport back to the ring while a sweep is running", () => {
    // The ring does not move with a sweep, so without a guard every frame of
    // the drag would scroll the grid back to wherever focus was left.
    const { assets } = show(60);
    const far = assets[40]?.id;
    if (far === undefined) throw new Error("expected an asset");
    act(() => selection.focus(far));

    const grid = screen.getByRole("listbox");
    grid.scrollTop = 0;
    drag([0, 0], [600, 10]);
    expect(grid.scrollTop).toBe(0);
  });

  it("moves focus with the arrows and keeps selection separate under ctrl", async () => {
    const { user, assets } = show(12);
    const grid = screen.getByRole("listbox");
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);

    await user.type(grid, "{ArrowRight}");
    expect(selection.focused).toBe(assets[1]?.id);
    expect(selection.selected()).toEqual([assets[1]?.id]);

    // Ctrl moves the ring alone (`UI_SPEC.md` §6).
    await user.keyboard("{Control>}{ArrowRight}{/Control}");
    expect(selection.focused).toBe(assets[2]?.id);
    expect(selection.selected()).toEqual([assets[1]?.id]);

    // Space toggles what the ring is on, leaving the ring where it is.
    await user.keyboard(" ");
    expect(selection.selected()).toEqual([assets[1]?.id, assets[2]?.id]);
    expect(selection.focused).toBe(assets[2]?.id);
  });

  it("opens the focused asset on Enter", async () => {
    const { user, assets } = show(12);
    await user.click(screen.getAllByRole("option")[4] as HTMLElement);
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith(assets[4]?.id);
  });

  it("selects what is loaded on Ctrl+A, and no more", async () => {
    const { user, assets } = show(30);
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    await user.keyboard("{Control>}a{/Control}");
    // Every row it has, including the ones culled out of the DOM — and nothing
    // it has not fetched.
    expect(selection.size).toBe(assets.length);
  });

  it("drags the selection, under a picture the size of a thumbnail", async () => {
    // `UI_SPEC.md` §4.3. Both halves were reported from real windows: the drag
    // has to carry the *selection* rather than the cell under the pointer, and
    // the browser's default drag image is a snapshot of that cell — several
    // hundred pixels square, covering the sidebar it is being dragged to.
    const { user, assets } = show(12);
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    await user.keyboard("{Shift>}");
    await user.click(screen.getAllByRole("option")[2] as HTMLElement);
    await user.keyboard("{/Shift}");

    const set = new Map<string, string>();
    let image: { node: Element; x: number; y: number } | undefined;
    const dataTransfer = {
      types: [],
      setData: (type: string, value: string) => set.set(type, value),
      getData: (type: string) => set.get(type) ?? "",
      setDragImage: (node: Element, x: number, y: number) => {
        image = { node, x, y };
      },
      effectAllowed: "none",
    } as unknown as DataTransfer;

    fireEvent(
      screen.getAllByRole("option")[1] as HTMLElement,
      createEvent.dragStart(screen.getAllByRole("option")[1] as HTMLElement, { dataTransfer }),
    );

    expect(JSON.parse(set.get(ASSET_DRAG_TYPE) ?? "[]")).toEqual(
      assets.slice(0, 3).map((asset) => asset.id),
    );
    expect(image?.node.className).toBe("drag-ghost");
    // Anchored at its own centre, so it hangs under the pointer rather than
    // off to one side of it.
    expect([image?.x, image?.y]).toEqual([32, 32]);
    // Three of them, said on the ghost: a picture of one asset over a drag of
    // three is the drag saying something untrue.
    expect(image?.node.querySelector(".drag-ghost-count")?.textContent).toBe("3");
  });

  it("hands the selection to a drag out, and starts none of its own", async () => {
    // ADR-0034 §4: a drag that can leave the window is a native one, started
    // by main. The grid's own drag has to be cancelled, or the window would
    // be carrying two things at once.
    const asked: (readonly string[])[] = [];
    const { user, assets } = show(12, false, (ids) => {
      asked.push(ids);
      return true;
    });
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    await user.keyboard("{Shift>}");
    await user.click(screen.getAllByRole("option")[1] as HTMLElement);
    await user.keyboard("{/Shift}");

    const set = new Map<string, string>();
    const dataTransfer = {
      types: [],
      setData: (type: string, value: string) => set.set(type, value),
      getData: (type: string) => set.get(type) ?? "",
      setDragImage: () => {},
      effectAllowed: "none",
    } as unknown as DataTransfer;
    const cell = screen.getAllByRole("option")[1] as HTMLElement;
    const event = createEvent.dragStart(cell, { dataTransfer });
    fireEvent(cell, event);

    expect(asked).toEqual([assets.slice(0, 2).map((asset) => asset.id)]);
    expect(event.defaultPrevented).toBe(true);
    expect(set.size).toBe(0);
  });

  it("drags inside the window as before when the drag cannot go out", async () => {
    const { user, assets } = show(12, false, () => false);
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);

    const set = new Map<string, string>();
    const dataTransfer = {
      types: [],
      setData: (type: string, value: string) => set.set(type, value),
      getData: (type: string) => set.get(type) ?? "",
      setDragImage: () => {},
      effectAllowed: "none",
    } as unknown as DataTransfer;
    const cell = screen.getAllByRole("option")[0] as HTMLElement;
    const event = createEvent.dragStart(cell, { dataTransfer });
    fireEvent(cell, event);

    expect(event.defaultPrevented).toBe(false);
    expect(JSON.parse(set.get(ASSET_DRAG_TYPE) ?? "[]")).toEqual([assets[0]?.id]);
  });

  it("keeps a multi-selection through a press, and collapses it on release", async () => {
    // What every file manager defers, and for one reason: pressing one of five
    // selected assets is how a drag of five begins. Found in a real window on
    // 2026-09-07 — the drag carried one asset however many were selected.
    const { user, assets } = show(12);
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    await user.keyboard("{Shift>}");
    await user.click(screen.getAllByRole("option")[2] as HTMLElement);
    await user.keyboard("{/Shift}");
    expect(selection.size).toBe(3);

    const middle = screen.getAllByRole("option")[1] as HTMLElement;
    fireEvent.pointerDown(middle, { button: 0, pointerId: 1 });
    expect(selection.size).toBe(3);

    // A press that turns out to be a click still collapses, on release.
    fireEvent.pointerUp(middle, { button: 0, pointerId: 1 });
    expect(selection.selected()).toEqual([assets[1]?.id]);
  });

  it("does not collapse the selection when the press becomes a drag", async () => {
    const { user, assets } = show(12);
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    await user.keyboard("{Shift>}");
    await user.click(screen.getAllByRole("option")[2] as HTMLElement);
    await user.keyboard("{/Shift}");

    const middle = screen.getAllByRole("option")[1] as HTMLElement;
    fireEvent.pointerDown(middle, { button: 0, pointerId: 1 });

    const set = new Map<string, string>();
    const dataTransfer = {
      types: [],
      setData: (type: string, value: string) => set.set(type, value),
      getData: (type: string) => set.get(type) ?? "",
      setDragImage: () => {},
      effectAllowed: "none",
    } as unknown as DataTransfer;
    fireEvent(middle, createEvent.dragStart(middle, { dataTransfer }));

    expect(JSON.parse(set.get(ASSET_DRAG_TYPE) ?? "[]")).toEqual(
      assets.slice(0, 3).map((asset) => asset.id),
    );
    // And the release at the end of the drag must not collapse it either.
    fireEvent.pointerUp(middle, { button: 0, pointerId: 1 });
    expect(selection.size).toBe(3);
  });

  it("points the listbox at the focused option rather than focusing it", async () => {
    // The ARIA listbox pattern: one tab stop, a roving ring. Four hundred
    // focusable cells would be four hundred tab stops.
    const { user, assets } = show(12);
    await user.click(screen.getAllByRole("option")[2] as HTMLElement);
    expect(screen.getByRole("listbox").getAttribute("aria-activedescendant")).toBe(
      `cell-${assets[2]?.id}`,
    );
    expect(screen.getAllByRole("option")[2]?.getAttribute("tabindex")).toBeNull();
  });

  it("asks for another page when the scroll gets near the bottom", () => {
    show(200);
    const grid = screen.getByRole("listbox");
    moreCalls = [];

    Object.defineProperty(grid, "scrollTop", { configurable: true, value: 100_000 });
    act(() => {
      grid.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(moreCalls.length).toBeGreaterThan(0);
  });

  it("publishes one scroll offset per frame, however many events arrive", () => {
    show(200);
    const grid = screen.getByRole("listbox");

    // A wheel emits many events per frame. `roost-old` learned this the other
    // way round; here the handler is the thing under test.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      frames.push(fn);
      return frames.length;
    });

    act(() => {
      for (let i = 0; i < 20; i += 1) grid.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(frames).toHaveLength(1);
  });
});

/**
 * The folders drawn among the thumbnails (ADR-0043).
 *
 * Every claim here is about the one distinction the feature rests on: a tile is
 * a **control**, not a result. It is laid out like a cell and it is in none of
 * the places a result is — the selection, `Ctrl+A`, the marquee, a drag.
 */
describe("folders in the grid", () => {
  let selection: SelectionStore;
  const opened = vi.fn();
  const onOpen = vi.fn();

  function folderRow(folder: number, name: string): SidebarFolderRow {
    return {
      id: `folder:${folder}`,
      name,
      query: `infolder:"${name}"`,
      count: 3,
      depth: 1,
      group: null,
      stars: null,
      folder,
      path: `Design/${name}`,
    };
  }

  const ICONS = folderRow(7, "Icons");
  const LOGOS = folderRow(8, "Logos");

  const show = (count: number, view: GridView = "icons", located = false) => {
    const assets = Array.from({ length: count }, (_, i) => fakeAsset(i));
    render(
      <Grid
        assets={assets}
        view={view}
        proportional={false}
        target={240}
        selection={selection}
        onMore={() => {}}
        onOpen={onOpen}
        folders={{
          rows: [ICONS, LOGOS],
          located,
          onOpen: opened,
          onNewFolder: () => {},
          onRename: () => {},
          onMoveFolder: () => {},
          onDelete: () => {},
          onDropAssets: () => {},
        }}
      />,
    );
    return { user: userEvent.setup(), assets };
  };

  const tile = (folder: number): HTMLElement => {
    const cell = document.querySelector(`[data-id="folder-${folder}"]`);
    if (!(cell instanceof HTMLElement)) throw new Error(`no tile for folder ${folder}`);
    return cell;
  };

  beforeEach(() => {
    sized();
    selection = new SelectionStore();
    opened.mockClear();
    onOpen.mockClear();
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      fn(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "0px", paddingRight: "0px" }));
  });

  it("draws the subfolders ahead of the assets, with their counts", () => {
    show(12);
    const cells = screen.getAllByRole("option");
    expect(cells[0]?.getAttribute("data-id")).toBe("folder-7");
    expect(cells[1]?.getAttribute("data-id")).toBe("folder-8");
    expect(cells[0]?.getAttribute("aria-label")).toBe("Icons, folder, 3 assets");
    // Two tiles and twelve assets: the tiles are laid out, not overlaid.
    expect(cells.length).toBe(14);
  });

  it("says where a search's folder is, before its name (ADR-0057)", () => {
    show(0, "icons", true);
    expect(tile(7).getAttribute("aria-label")).toBe("Design/Icons, folder, 3 assets");
    expect(tile(7).querySelector(".cell-where")?.textContent).toBe("Design/");
    expect(tile(7).querySelector(".cell-name-own")?.textContent).toBe("Icons");
  });

  it("draws a folder as a sleeve with its newest pictures in it", async () => {
    // ADR-0043 §7, the user's drawing of 2026-09-25: up to four, and one fills
    // the sheet. Addresses only — the pictures come over roost://thumb.
    const covers = (folder: number, n: number) => ({
      folder,
      assets: Array.from({ length: n }, (_, i) => ({
        id: `A${folder}${String(i).padStart(10, "0")}`,
        posterMs: null,
        derivedAt: 1_700_000_000,
      })),
    });
    install(new FakeEngine({ folderCovers: [covers(7, 4), covers(8, 1)] }));
    show(2);

    await waitFor(() => {
      expect(tile(7).querySelectorAll(".folder-sheet-image")).toHaveLength(4);
    });
    const first = tile(7).querySelector(".folder-sheet-image")?.getAttribute("src");
    expect(first).toBe("roost://thumb/A70000000000@256?v=1700000000");
    expect(tile(8).querySelector(".folder-sheet")?.getAttribute("data-covers")).toBe("1");
    // The punched strip is what says "folder" rather than "collage".
    expect(tile(7).querySelectorAll(".folder-hole")).toHaveLength(6);
  });

  it.each(["details", "compact"] as const)(
    "draws a folder's row in %s as the punched sleeve, without pictures",
    async (view) => {
      // The user's call, 2026-09-25: in a list the icon only has to say
      // "folder", so a row asks for covers it does not draw.
      const covers = {
        folder: 7,
        assets: ["A70000000000"].map((id) => ({ id, posterMs: null, derivedAt: 1_700_000_000 })),
      };
      install(new FakeEngine({ folderCovers: [covers] }));
      show(2, view);

      await waitFor(() => {
        expect(tile(7).querySelector(".folder-sheet")).not.toBeNull();
      });
      expect(tile(7).querySelectorAll(".folder-sheet-image")).toHaveLength(0);
      expect(tile(7).querySelectorAll(".folder-hole")).toHaveLength(6);
    },
  );

  it("marks a folder on a click without selecting it", async () => {
    // The mark is the ring. A folder in the selection would be a folder handed
    // to the inspector, the trash, and every edit (ADR-0043 §4).
    const { user } = show(12);
    await user.click(tile(7));

    expect(selection.selected()).toEqual([]);
    expect(selection.focused).toBe("folder-7");
    expect(tile(7).hasAttribute("data-focused")).toBe(true);
  });

  it("clears an asset selection when a folder is marked", async () => {
    const { user, assets } = show(12);
    await user.click(screen.getAllByRole("option")[3] as HTMLElement);
    expect(selection.selected()).toEqual([assets[1]?.id]);

    await user.click(tile(8));
    expect(selection.selected()).toEqual([]);
  });

  it("opens a folder on a double-click, and opens no preview", async () => {
    // Explorer's gesture, chosen by the user on 2026-09-13 over one-click:
    // a hand that learned it there will double-click whatever this build does,
    // and with the first click navigating the second lands on a new grid.
    const { user } = show(12);
    await user.dblClick(tile(7));

    expect(opened).toHaveBeenCalledWith(ICONS);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens the marked folder on Enter", async () => {
    const { user } = show(12);
    await user.click(tile(8));
    await user.keyboard("{Enter}");

    expect(opened).toHaveBeenCalledWith(LOGOS);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("leaves folders out of Ctrl+A and out of a sweep", async () => {
    const { user, assets } = show(12);
    await user.click(screen.getAllByRole("option")[5] as HTMLElement);
    await user.keyboard("{Control>}a{/Control}");
    expect(selection.selected()).toEqual(assets.map((asset) => asset.id));

    const grid = screen.getByRole("listbox");
    fireEvent.pointerDown(grid, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(grid, { pointerId: 1, clientX: 900, clientY: 10 });
    fireEvent.pointerUp(grid, { pointerId: 1, clientX: 900, clientY: 10 });
    // The sweep crossed both tiles on its way across the first row.
    expect(selection.selected().every((id) => !id.startsWith("folder-"))).toBe(true);
  });

  it("does nothing on Space over a folder", async () => {
    const { user } = show(12);
    await user.click(tile(7));
    await user.keyboard(" ");

    expect(selection.selected()).toEqual([]);
    expect(selection.focused).toBe("folder-7");
  });

  it("never starts an asset drag from a tile", () => {
    show(12);
    const setData = vi.fn();
    const event = createEvent.dragStart(tile(7), {
      dataTransfer: {
        setData,
        setDragImage: () => {},
        effectAllowed: "all",
      } as unknown as DataTransfer,
    });
    fireEvent(tile(7), event);

    expect(setData).not.toHaveBeenCalled();
  });

  it("takes a drop of assets onto a tile", () => {
    const dropped = vi.fn();
    const assets = [fakeAsset(0), fakeAsset(1)];
    render(
      <Grid
        assets={assets}
        view="icons"
        proportional={false}
        target={240}
        selection={selection}
        onMore={() => {}}
        folders={{
          rows: [ICONS],
          located: false,
          onOpen: opened,
          onNewFolder: () => {},
          onRename: () => {},
          onMoveFolder: () => {},
          onDelete: () => {},
          onDropAssets: dropped,
        }}
      />,
    );

    const ids = [assets[0]?.id];
    const dataTransfer = {
      types: [ASSET_DRAG_TYPE],
      getData: () => JSON.stringify(ids),
      dropEffect: "none",
      effectAllowed: "all",
    } as unknown as DataTransfer;
    // happy-dom leaves `ctrlKey` off a constructed `DragEvent`, and React reads
    // it off the native one — so the modifier the handler asks about has to be
    // put there by hand for the drop to be an ordinary, unmodified one.
    const drop = createEvent.drop(tile(7), { dataTransfer });
    Object.defineProperty(drop, "ctrlKey", { value: false });
    fireEvent(tile(7), drop);

    expect(dropped).toHaveBeenCalledWith(ICONS, ids, false);
  });
});
