import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASSET_DRAG_TYPE } from "../dnd.js";
import { fakeAsset } from "../testing/fake-engine.js";
import { Grid } from "./Grid.js";
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

  const show = (count: number, proportional = false) => {
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

  it("points the thumbnail at roost:// and never at a data URL", () => {
    // Invariant 12 and ADR-0008: bytes reach the window over the protocol, and
    // Chromium owns the decode and the cache.
    const { assets } = show(4);
    const image = document.querySelector<HTMLImageElement>(".cell-image");
    expect(image?.getAttribute("src")).toBe(`roost://thumb/${assets[0]?.hash}@256`);
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
    expect(selection.selected()).toEqual([assets[7]?.hash]);
  });

  it("selects with a click, adds with ctrl, and extends with shift", async () => {
    const { user, assets } = show(12);
    const cells = screen.getAllByRole("option");

    await user.click(cells[0] as HTMLElement);
    expect(selection.selected()).toEqual([assets[0]?.hash]);

    await user.keyboard("{Control>}");
    await user.click(cells[3] as HTMLElement);
    await user.keyboard("{/Control}");
    expect(selection.selected()).toEqual([assets[0]?.hash, assets[3]?.hash]);

    await user.keyboard("{Shift>}");
    await user.click(cells[5] as HTMLElement);
    await user.keyboard("{/Shift}");
    expect(selection.selected()).toEqual([3, 4, 5].map((i) => assets[i]?.hash));
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
    expect(selection.selected()).toEqual([assets[0]?.hash, assets[1]?.hash, assets[2]?.hash]);
  });

  it("takes a cell the sweep only touches, rather than one it encloses", () => {
    // `UI_SPEC.md` §6: enclosing is unusable in proportional icons, where a
    // cell is routinely taller than the sweep meant to catch it.
    const { assets } = show(40);
    drag([0, 0], [4, 4]);
    expect(selection.selected()).toEqual([assets[0]?.hash]);
  });

  it("adds to the selection when the drag starts with ctrl held", () => {
    const { assets } = show(40);
    fireEvent.pointerDown(screen.getAllByRole("option")[8] as HTMLElement, {
      button: 0,
      pointerId: 1,
    });
    expect(selection.selected()).toEqual([assets[8]?.hash]);

    drag([0, 0], [300, 10], { ctrlKey: true });
    expect(selection.selected()).toEqual([assets[0]?.hash, assets[1]?.hash, assets[8]?.hash]);
  });

  it("stays a click when the pointer barely moves, and still clears", () => {
    const { assets } = show(40);
    fireEvent.pointerDown(screen.getAllByRole("option")[8] as HTMLElement, {
      button: 0,
      pointerId: 1,
    });
    expect(selection.selected()).toEqual([assets[8]?.hash]);

    // Two pixels of travel is a shaky hand, not a sweep — and a press on the
    // background that never becomes a drag clears on release.
    drag([500, 500], [502, 501]);
    expect(selection.size).toBe(0);
  });

  it("does not haul the viewport back to the ring while a sweep is running", () => {
    // The ring does not move with a sweep, so without a guard every frame of
    // the drag would scroll the grid back to wherever focus was left.
    const { assets } = show(60);
    const far = assets[40]?.hash;
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
    expect(selection.focused).toBe(assets[1]?.hash);
    expect(selection.selected()).toEqual([assets[1]?.hash]);

    // Ctrl moves the ring alone (`UI_SPEC.md` §6).
    await user.keyboard("{Control>}{ArrowRight}{/Control}");
    expect(selection.focused).toBe(assets[2]?.hash);
    expect(selection.selected()).toEqual([assets[1]?.hash]);

    // Space toggles what the ring is on, leaving the ring where it is.
    await user.keyboard(" ");
    expect(selection.selected()).toEqual([assets[1]?.hash, assets[2]?.hash]);
    expect(selection.focused).toBe(assets[2]?.hash);
  });

  it("opens the focused asset on Enter", async () => {
    const { user, assets } = show(12);
    await user.click(screen.getAllByRole("option")[4] as HTMLElement);
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith(assets[4]?.hash);
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
      assets.slice(0, 3).map((asset) => asset.hash),
    );
    expect(image?.node.className).toBe("drag-ghost");
    // Anchored at its own centre, so it hangs under the pointer rather than
    // off to one side of it.
    expect([image?.x, image?.y]).toEqual([32, 32]);
    // Three of them, said on the ghost: a picture of one asset over a drag of
    // three is the drag saying something untrue.
    expect(image?.node.querySelector(".drag-ghost-count")?.textContent).toBe("3");
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
    expect(selection.selected()).toEqual([assets[1]?.hash]);
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
      assets.slice(0, 3).map((asset) => asset.hash),
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
      `cell-${assets[2]?.hash}`,
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
