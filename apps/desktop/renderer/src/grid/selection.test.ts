import { describe, expect, it, vi } from "vitest";
import { FOCUSED, SELECTED, SelectionStore } from "./selection.js";

const HASHES = ["a", "b", "c", "d", "e"];

function stored(): SelectionStore {
  const store = new SelectionStore();
  store.setOrder(HASHES);
  return store;
}

/** Subscribes every hash and counts how many were notified. */
function watch(store: SelectionStore, hashes: readonly string[] = HASHES): () => number {
  const woken = new Set<string>();
  for (const hash of hashes) {
    store.subscribe(hash)(() => woken.add(hash));
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

  it("selects what is loaded, which is all it can honestly promise", () => {
    const store = stored();
    store.selectLoaded();
    expect(store.selected()).toEqual(HASHES);
    expect(store.size).toBe(5);
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
