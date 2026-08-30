import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
