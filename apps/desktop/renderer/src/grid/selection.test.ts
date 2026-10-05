import { describe, expect, it, vi } from "vitest";
import { FOCUSED, SELECTED, SelectionStore } from "./selection.js";

const HASHES = ["a", "b", "c", "d", "e"];

function stored(): SelectionStore {
  const store = new SelectionStore();
  store.setOrder(HASHES);
  return store;
}

/** Subscribes every id and counts how many were notified. */
function watch(store: SelectionStore, ids: readonly string[] = HASHES): () => number {
  const woken = new Set<string>();
  for (const id of ids) {
    store.subscribe(id)(() => woken.add(id));
  }
  return () => woken.size;
}

describe("selecting in the grid", () => {
  it("replaces the selection on a click and anchors there", () => {
    const store = stored();
    store.click("b");
    expect(store.selected()).toEqual(["b"]);
    store.click("d");
    expect(store.selected()).toEqual(["d"]);
  });

  it("lets go of assets that left, and keeps what else is selected", () => {
    // A move answers minutes after it started (ADR-0054 §3.9), and the
    // selection by then may be mostly something else.
    const store = stored();
    store.toggle("a");
    store.toggle("c");
    store.toggle("e");
    const woken = watch(store);

    store.deselect(["a", "c", "z"]);

    expect(store.selected()).toEqual(["e"]);
    expect(woken()).toBe(2);
    const revision = store.revision();
    store.deselect(["b"]);
    expect(store.revision()).toBe(revision);
  });

  it("adds and removes on a toggle", () => {
    const store = stored();
    store.toggle("b");
    store.toggle("d");
    expect(store.selected()).toEqual(["b", "d"]);
    store.toggle("b");
    expect(store.selected()).toEqual(["d"]);
  });

  it("extends from the anchor, in either direction", () => {
    const store = stored();
    store.click("b");
    store.extendTo("d");
    expect(store.selected()).toEqual(["b", "c", "d"]);

    // The anchor stays put, so a second shift-click re-measures from the same
    // place rather than from the last one.
    store.extendTo("a");
    expect(store.selected()).toEqual(["a", "b"]);
  });

  it("returns the selection in result order, not the order it was clicked", () => {
    const store = stored();
    store.toggle("d");
    store.toggle("a");
    store.toggle("c");
    expect(store.selected()).toEqual(["a", "c", "d"]);
  });

  it("keeps focus and selection apart", () => {
    const store = stored();
    store.click("b");
    store.focus("d");
    // Moving focus with Ctrl held does not change the selection (`UI_SPEC.md`).
    expect(store.selected()).toEqual(["b"]);
    expect(store.focused).toBe("d");

    store.toggleFocused();
    expect(store.selected()).toEqual(["b", "d"]);
    expect(store.focused).toBe("d");
  });

  it("keeps the ring on a clear and drops it on a reset", () => {
    // Two gestures, two meanings. Clicking the grid's background empties the
    // selection and the cell is still there; a new query takes the cell away,
    // and a ring pointing at it opens an asset that is not in the result.
    const store = stored();
    store.click("b");
    store.clear();
    expect(store.selected()).toEqual([]);
    expect(store.focused).toBe("b");

    store.reset();
    expect(store.focused).toBeUndefined();
  });

  it("hands the ring to the asset that takes a gone one's place", () => {
    // Reported 2026-10-05: trashing an asset sent the grid back to the top,
    // because the ring stayed on an asset that was no longer there.
    const store = stored();
    store.click("b");
    store.extendTo("c");
    store.leave(["b", "c"]);
    expect(store.selected()).toEqual([]);
    expect(store.focused).toBe("d");

    // The last one has nothing after it, so the one before takes its place.
    store.click("e");
    store.leave(["e"]);
    expect(store.focused).toBe("d");

    // A ring on something that stayed is left where it is.
    store.click("a");
    store.leave(["d"]);
    expect(store.focused).toBe("a");

    store.leave(HASHES);
    expect(store.focused).toBeUndefined();
  });

  it("wakes the cell that was carrying the ring when it is reset", () => {
    const store = stored();
    store.click("b");
    const woken = watch(store);
    store.reset();
    expect(woken()).toBe(1);
  });

  it("selects what is loaded, which is all it can honestly promise", () => {
    const store = stored();
    store.selectLoaded();
    expect(store.selected()).toEqual(HASHES);
    expect(store.size).toBe(5);
  });

  it("replaces the selection with what a sweep is holding", () => {
    const store = stored();
    store.click("e");
    store.sweep(["b", "c"]);
    expect(store.selected()).toEqual(["b", "c"]);
  });

  it("adds to what was already selected when the sweep is additive", () => {
    const store = stored();
    store.click("e");
    store.sweep(["b"], new Set(["e"]));
    expect(store.selected()).toEqual(["b", "e"]);
  });

  it("leaves focus and the anchor where a sweep found them", () => {
    const store = stored();
    store.click("e");
    store.sweep(["a", "b"]);
    // The ring stays put: moving it per frame would drag the viewport along
    // with it, because the grid scrolls focus back into view.
    expect(store.focused).toBe("e");
    // And so does the anchor, so a Shift-click after a sweep still measures
    // from the last cell that was actually clicked.
    store.extendTo("c");
    expect(store.selected()).toEqual(["c", "d", "e"]);
  });

  it("keeps a selection whose rows a later page pushed out of the order", () => {
    // A page can arrive while a selection is held. Dropping it would make
    // scrolling lose the user's work.
    const store = stored();
    store.toggle("b");
    store.setOrder([...HASHES, "f", "g"]);
    expect(store.selected()).toEqual(["b"]);
  });

  it("reports each cell's state as one primitive", () => {
    // `useSyncExternalStore` compares snapshots by identity: a fresh object per
    // read would re-render every cell on every read.
    const store = stored();
    store.click("b");
    expect(store.stateOf("b")).toBe(SELECTED | FOCUSED);
    expect(store.stateOf("c")).toBe(0);
    expect(store.stateOf("b")).toBe(store.stateOf("b"));
  });
});

describe("what a selection change wakes", () => {
  it("wakes only the cells whose state changed", () => {
    // The reason this store exists at all (`UI_SPEC.md` §6): selecting one item
    // must not re-render ten thousand cells.
    const store = stored();
    store.click("a");

    const woken = watch(store);
    store.click("d");
    // `a` loses selection and focus, `d` gains both. Nothing else moved.
    expect(woken()).toBe(2);
  });

  it("wakes only the cells a sweep crossed", () => {
    const store = stored();
    const woken = watch(store);
    store.sweep(["b", "c"]);
    expect(woken()).toBe(2);
  });

  it("wakes nothing when the click changes nothing", () => {
    const store = stored();
    store.click("c");
    const woken = watch(store);
    store.click("c");
    expect(woken()).toBe(0);
  });

  it("stops waking a cell that unsubscribed", () => {
    const store = stored();
    const notify = vi.fn();
    const unsubscribe = store.subscribe("a")(notify);
    store.click("a");
    expect(notify).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.click("b");
    store.click("a");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("bumps the revision even when no visible cell changed", () => {
    // A cell scrolled out of view has no listener, so the status bar cannot
    // learn the count from the cells.
    const store = stored();
    const notify = vi.fn();
    store.subscribeRevision(notify);
    const before = store.revision();
    store.click("e");
    expect(store.revision()).not.toBe(before);
    expect(notify).toHaveBeenCalled();
  });

  it("changes the revision when the count does not", () => {
    // One deselected and another selected in the same gesture leaves the count
    // equal and the selection different. A count as the snapshot would miss it.
    const store = stored();
    store.click("a");
    const before = store.revision();
    store.click("b");
    expect(store.size).toBe(1);
    expect(store.revision()).not.toBe(before);
  });
});
