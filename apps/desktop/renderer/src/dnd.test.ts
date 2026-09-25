import { afterEach, describe, expect, it } from "vitest";
import {
  ASSET_DRAG_TYPE,
  carriesAssets,
  DRAG_OUT_BUDGET,
  dragGoesOut,
  draggedAssets,
  dragOutEnded,
  dragOutStarted,
  dropEffectFor,
  isOwnDrag,
} from "./dnd.js";

/** A `DataTransfer` carrying these types, and this data for the types that have any. */
const transfer = (types: readonly string[], data: Record<string, string> = {}): DataTransfer =>
  ({ types, getData: (type: string) => data[type] ?? "" }) as unknown as DataTransfer;

const MB = 1024 * 1024;

describe("whether a drag goes out of the window (ADR-0034 §4)", () => {
  it("always goes out where a copy costs nothing", () => {
    expect(dragGoesOut("free", [50_000 * MB, null])).toEqual({ out: true });
  });

  it("goes out up to the budget where every byte is copied", () => {
    expect(dragGoesOut("copies", [DRAG_OUT_BUDGET - 1, 1])).toEqual({ out: true });
  });

  it("stays inside past it, and says how much it would have copied", () => {
    expect(dragGoesOut("copies", [DRAG_OUT_BUDGET, 1])).toEqual({
      out: false,
      bytes: DRAG_OUT_BUDGET + 1,
    });
  });

  it("stays inside when a size is not known yet, since it may be any size", () => {
    expect(dragGoesOut("copies", [1, null])).toEqual({ out: false, bytes: null });
    expect(dragGoesOut("copies", [1, undefined])).toEqual({ out: false, bytes: null });
  });
});

describe("a drag of the window's own that went out as files", () => {
  afterEach(() => dragOutEnded());

  it("is the assets the window asked to drag, not the files it carries", () => {
    // The files are staged copies and name nothing in the library.
    dragOutStarted(["AAAAAAAAAAAA", "BBBBBBBBBBBB"]);
    const files = transfer(["Files"]);

    expect(isOwnDrag(files)).toBe(true);
    expect(carriesAssets(files)).toBe(true);
    expect(draggedAssets(files)).toEqual(["AAAAAAAAAAAA", "BBBBBBBBBBBB"]);
  });

  it("is over once main says so, and files are the desktop's again", () => {
    dragOutStarted(["AAAAAAAAAAAA"]);
    dragOutEnded();
    const files = transfer(["Files"]);

    expect(isOwnDrag(files)).toBe(false);
    expect(carriesAssets(files)).toBe(false);
    expect(draggedAssets(files)).toEqual([]);
  });

  it("offers only a copy, which is all a native drag allows", () => {
    // `move` against a drag that allows `copy` is a drop the browser refuses.
    // Whether a folder drop moves is decided by what is on screen instead.
    expect(dropEffectFor(transfer(["Files"]), false)).toBe("copy");
    expect(dropEffectFor(transfer([ASSET_DRAG_TYPE]), false)).toBe("move");
    expect(dropEffectFor(transfer([ASSET_DRAG_TYPE]), true)).toBe("copy");
  });

  it("leaves a drag inside the window reading its own payload", () => {
    dragOutStarted(["AAAAAAAAAAAA"]);
    const inside = transfer([ASSET_DRAG_TYPE], { [ASSET_DRAG_TYPE]: '["CCCCCCCCCCCC"]' });

    expect(draggedAssets(inside)).toEqual(["CCCCCCCCCCCC"]);
  });
});
