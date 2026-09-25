import type { SidebarFolderRow, WireSettings } from "@roost/contract";
import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { ASSET_DRAG_TYPE } from "./dnd.js";
import { sound } from "./preview/sound.js";
import { FakeEngine, fakeAsset, fakeDetail, install } from "./testing/fake-engine.js";

/**
 * The picker and the creator, driven the way a person drives them.
 *
 * The native dialogs are answered by the fake bridge rather than by GTK: a
 * folder chooser cannot be clicked by a script, and the code that opens one is
 * twenty lines in main. What this covers is everything after the dialog
 * returns, which is where the flow actually lives.
 */

/**
 * Close library lives in the toolbar's menu now (ADR-0028), so the tests that
 * used to click a bare button open the menu first. Written once: three tests
 * close a library, and three copies of two clicks is where one of them ends up
 * asserting the menu rather than the closing.
 */
async function closeLibrary(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: "Menu" }));
  await user.click(await screen.findByRole("menuitem", { name: "Close library" }));
}

describe("opening a library", () => {
  let engine: FakeEngine;

  const start = (options: ConstructorParameters<typeof FakeEngine>[0] = {}) => {
    engine = new FakeEngine(options);
    install(engine);
    return { user: userEvent.setup(), ...render(<App />) };
  };

  beforeEach(() => {
    // Nothing carried between tests: the bridge is installed fresh each time,
    // so a test cannot pass because of a library the previous one opened.
  });

  it("offers the two things a first run can do", async () => {
    start();
    expect(await screen.findByRole("button", { name: "Open library…" })).toBeDefined();
    expect(screen.getByRole("button", { name: "New library…" })).toBeDefined();
    expect(screen.getByText("No library open")).toBeDefined();
  });

  it("opens the library the dialog chose, and shows what is in it", async () => {
    const { user } = start({
      openLibraryDialog: "/home/you/Holiday Photos.roost",
      existing: [{ root: "/home/you/Holiday Photos.roost", name: "Holiday Photos" }],
      stats: { assets: 1234, tags: 7 },
    });

    await user.click(await screen.findByRole("button", { name: "Open library…" }));

    expect(await screen.findByRole("heading", { name: "Holiday Photos" })).toBeDefined();
    expect(screen.getByText("1,234 assets")).toBeDefined();
    expect(screen.getByText("/home/you/Holiday Photos.roost")).toBeDefined();
    // The dialog is asked first and the library second: the renderer never
    // invents a path.
    expect(engine.seen.map((request) => request.type)).toEqual([
      // The picker asks for its recent list before anything else: it is what
      // the first screen draws, and it needs no library.
      "recent:list",
      "library:current",
      "dialog:openLibrary",
      "library:open",
      "library:stats",
      // This library's preferences, asked for before anything is drawn from
      // them, because the **order** is one of them (ADR-0039 §7).
      "settings:read",
      // The derive queue, as soon as there is a library: an empty cell has to
      // be able to say whether it is waiting, parked, or simply undrawable.
      "derive:status",
      "library:sidebar",
      // The status bar's match count, asked once per query rather than once
      // per scroll.
      "assets:count",
      // What the filter bar draws (ADR-0035). The query is read by the engine
      // because the grammar has one implementation, and the bar is a view of
      // the query rather than a second piece of state.
      "query:split",
      // And the grid's first page **last**, because it is the one request that
      // depends on an answer: a page fetched before the order arrives is a
      // hundred rows fetched to be thrown away (ADR-0039 §7).
      "assets:page",
    ]);
  });

  it("leaves the screen alone when the dialog is cancelled", async () => {
    const { user } = start({ openLibraryDialog: null });

    await user.click(await screen.findByRole("button", { name: "Open library…" }));

    expect(screen.getByRole("heading", { name: "Roost" })).toBeDefined();
    // Cancelling is an outcome, not a failure, so nothing is reported.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(engine.seen.some((request) => request.type === "library:open")).toBe(false);
  });

  it("reports the engine's own code when the folder is not a library", async () => {
    const { user } = start({
      openLibraryDialog: "/home/you/Documents",
      plainDirectories: ["/home/you/Documents"],
    });

    await user.click(await screen.findByRole("button", { name: "Open library…" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("is not a Roost library");
    expect(alert.textContent).toContain("[not_a_library]");
  });
});

describe("creating a library", () => {
  const start = (options: ConstructorParameters<typeof FakeEngine>[0] = {}) => {
    const engine = new FakeEngine(options);
    install(engine);
    return { engine, user: userEvent.setup(), ...render(<App />) };
  };

  it("says what the folder will be called, as the name is typed", async () => {
    const { user } = start();

    await user.click(await screen.findByRole("button", { name: "New library…" }));
    // Before a name, the placeholder still shows the shape of the answer.
    expect(screen.getByText(`Name.roost`)).toBeDefined();

    await user.type(screen.getByLabelText("Name"), "Kerja");
    expect(screen.getByText("Kerja.roost")).toBeDefined();
  });

  it("will not save without both a name and a location", async () => {
    const { user } = start({ chooseLocationDialog: "/home/you/Pictures" });

    await user.click(await screen.findByRole("button", { name: "New library…" }));
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(true);

    await user.type(screen.getByLabelText("Name"), "Kerja");
    expect(save.hasAttribute("disabled")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
  });

  it("creates the library and opens it", async () => {
    const { engine, user } = start({ chooseLocationDialog: "/home/you/Pictures" });

    await user.click(await screen.findByRole("button", { name: "New library…" }));
    await user.type(screen.getByLabelText("Name"), "Holiday Photos");
    await user.click(screen.getByRole("button", { name: "Choose…" }));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(await screen.findByRole("heading", { name: "Holiday Photos" })).toBeDefined();
    // The location and the name travel apart; the engine is what joins them and
    // adds the suffix (ADR-0014).
    expect(engine.seen).toContainEqual({
      type: "library:create",
      parent: "/home/you/Pictures",
      name: "Holiday Photos",
    });
    expect(engine.has("/home/you/Pictures/Holiday Photos.roost")).toBe(true);
  });

  it("reports a name the engine refuses, without leaving the form", async () => {
    const { user } = start({ chooseLocationDialog: "/home/you/Pictures" });

    await user.click(await screen.findByRole("button", { name: "New library…" }));
    await user.type(screen.getByLabelText("Name"), "a/b");
    await user.click(screen.getByRole("button", { name: "Choose…" }));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("[invalid_library_name]");
    // Still on the form, with what was typed, so it can be corrected.
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "a/b");
  });

  it("goes back to the picker on cancel", async () => {
    const { user } = start();

    await user.click(await screen.findByRole("button", { name: "New library…" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Open library…" })).toBeDefined();
  });
});

describe("a library that is already open", () => {
  it("is found again when the page reloads, because the engine outlives it", async () => {
    const engine = new FakeEngine({
      openLibraryDialog: "/home/you/Holiday Photos.roost",
      existing: [{ root: "/home/you/Holiday Photos.roost", name: "Holiday Photos" }],
    });
    install(engine);
    const user = userEvent.setup();

    const first = render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await screen.findByRole("heading", { name: "Holiday Photos" });
    first.unmount();

    render(<App />);

    // No dialog, no open: the window asked what was already there.
    expect(await screen.findByRole("heading", { name: "Holiday Photos" })).toBeDefined();
  });

  it("re-reads the counts when the engine says something changed", async () => {
    const engine = new FakeEngine({
      openLibraryDialog: "/home/you/Holiday Photos.roost",
      existing: [{ root: "/home/you/Holiday Photos.roost", name: "Holiday Photos" }],
      stats: { assets: 3 },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await screen.findByText("3 assets");

    const before = engine.seen.filter((request) => request.type === "library:stats").length;
    engine.emit({ type: "library:changed" });

    // The counts are derived, so the only way to keep them true is to re-read
    // them — an event carrying them would be a second copy to keep in step.
    await waitFor(() => {
      const after = engine.seen.filter((request) => request.type === "library:stats").length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("gives a cell a new thumbnail address when its file changed underneath", async () => {
    // ADR-0047. An application that has never heard of Roost saved over the
    // file; the engine's watcher noticed and re-derived it. The thumbnail is
    // served `immutable` for a year, so an `<img>` whose `src` did not change
    // is one Chromium never asks about again — the address has to move.
    const engine = new FakeEngine({
      openLibraryDialog: "/home/you/Holiday Photos.roost",
      existing: [{ root: "/home/you/Holiday Photos.roost", name: "Holiday Photos" }],
      stats: { assets: 2 },
      assets: [fakeAsset(0), fakeAsset(1)],
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    const cell = await waitFor(() => {
      const found = document.querySelector<HTMLImageElement>(".cell-image");
      if (found === null) throw new Error("no cell yet");
      return found;
    });
    const before = cell.getAttribute("src") ?? "";
    const id = document.querySelector<HTMLElement>(".cell")?.dataset["id"] ?? "";
    expect(id).not.toBe("");

    const pages = engine.seen.filter((request) => request.type === "assets:page").length;
    engine.emit({
      type: "assets:derived",
      assets: [{ id, derivedAt: 1_799_999_999, undrawn: null }],
    });

    await waitFor(() => {
      const after =
        document.querySelector<HTMLImageElement>(".cell-image")?.getAttribute("src") ?? "";
      expect(after).not.toBe(before);
      expect(after).toContain("v=1799999999");
    });

    // Patched, not re-paged: a save somewhere else must not throw away the
    // scroll position or the pages below it.
    expect(engine.seen.filter((request) => request.type === "assets:page").length).toBe(pages);
  });

  it("says on the cell why its picture is missing, as the queue decides", async () => {
    // Reported 2026-09-24: a HEIC waiting on libheif was a grey square with
    // "HEIC" in it, exactly like one still in the queue (`UI_SPEC.md` §6.1).
    const engine = new FakeEngine({
      openLibraryDialog: "/home/you/Holiday Photos.roost",
      existing: [{ root: "/home/you/Holiday Photos.roost", name: "Holiday Photos" }],
      stats: { assets: 2 },
      assets: [fakeAsset(0, { ext: "heic", derivedAt: null }), fakeAsset(1)],
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    const cell = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".cell");
      if (found === null) throw new Error("no cell yet");
      return found;
    });
    const id = cell.dataset["id"] ?? "";
    const src = cell.querySelector(".cell-image")?.getAttribute("src");
    expect(cell.querySelector(".placeholder-badge")).toBeNull();

    // Parked, with nothing measured: a reason and no new cache key.
    engine.emit({
      type: "assets:derived",
      assets: [{ id, derivedAt: null, undrawn: "missing:libheif" }],
    });
    const badge = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[data-id="${id}"] .placeholder-badge`);
      if (found === null) throw new Error("no badge yet");
      return found;
    });
    expect(badge.textContent).toBe("Needs libheif");
    expect(badge.title).toBe("HEIC photographs need libheif");
    // `null` means "nothing written", not "forget the key".
    expect(document.querySelector(`[data-id="${id}"] .cell-image`)?.getAttribute("src")).toBe(src);

    // Installed, retried and drawn: the reason goes with the new picture.
    engine.emit({
      type: "assets:derived",
      assets: [{ id, derivedAt: 1_799_999_999, undrawn: null }],
    });
    await waitFor(() => {
      expect(document.querySelector(`[data-id="${id}"] .placeholder-badge`)).toBeNull();
    });
  });

  it("ignores a redraw for an asset it is not showing", async () => {
    const engine = new FakeEngine({
      openLibraryDialog: "/home/you/Holiday Photos.roost",
      existing: [{ root: "/home/you/Holiday Photos.roost", name: "Holiday Photos" }],
      stats: { assets: 2 },
      assets: [fakeAsset(0), fakeAsset(1)],
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => {
      expect(document.querySelector(".cell-image")).not.toBeNull();
    });
    const before = document.querySelector<HTMLImageElement>(".cell-image")?.getAttribute("src");

    engine.emit({
      type: "assets:derived",
      assets: [{ id: "ZZZZZZZZZZZZ", derivedAt: 1, undrawn: null }],
    });

    // A page this window has not reached will carry the new key when it
    // arrives; nothing here should move, and nothing should be fetched.
    await waitFor(() => {
      expect(document.querySelector<HTMLImageElement>(".cell-image")?.getAttribute("src")).toBe(
        before,
      );
    });
  });

  it("closes back to the picker", async () => {
    const engine = new FakeEngine({
      openLibraryDialog: "/home/you/Holiday Photos.roost",
      existing: [{ root: "/home/you/Holiday Photos.roost", name: "Holiday Photos" }],
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await closeLibrary(user);

    expect(await screen.findByRole("button", { name: "Open library…" })).toBeDefined();
    expect(screen.getByText("No library open")).toBeDefined();
  });
});

describe("the library view", () => {
  const HOLIDAY = "/home/you/Holiday Photos.roost";

  const open = async (assets: number) => {
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets },
      assets: Array.from({ length: assets }, (_, i) => fakeAsset(i)),
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await screen.findByRole("heading", { name: "Holiday Photos" });
    return { engine, user };
  };

  beforeEach(() => {
    // happy-dom does no layout, so a grid measured off the element would be
    // one column of nothing.
    for (const [name, value] of [
      ["clientWidth", 1000],
      ["clientHeight", 800],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
    }
  });

  it("shows the grid once a library is open", async () => {
    await open(12);
    expect(await screen.findByRole("listbox", { name: "Assets" })).toBeDefined();
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(12));
    // Every cell once. A grid that asked for the first page again after the
    // last one would show the same twelve rows three times over, which is what
    // it did before `paging.ts` learned to stop.
    const ids = screen.getAllByRole("option").map((cell) => cell.getAttribute("data-id"));
    expect(new Set(ids).size).toBe(12);
  });

  it("puts the context menu over the previewed asset, not over the selection", async () => {
    // `UI_SPEC.md` §3.3. Selecting three and opening one leaves three selected,
    // and "export…" while looking at one picture cannot sensibly mean the other
    // two — so the preview's menu is over the asset on screen.
    const { engine, user } = await open(12);
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(12));
    const cells = screen.getAllByRole("option");

    await user.click(cells[0] as HTMLElement);
    await user.keyboard("{Shift>}");
    await user.click(cells[2] as HTMLElement);
    await user.keyboard("{/Shift}");

    // `Enter` rather than a double-click: a double-click's own pointer-down
    // collapses the selection to the cell under it, so it could not tell the
    // two rules apart. `Enter` opens the focused asset and leaves three
    // selected, which is the case this test exists for.
    (screen.getByRole("listbox", { name: "Assets" }) as HTMLElement).focus();
    await user.keyboard("{Enter}");
    const pane = await screen.findByRole("dialog");

    pane.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");
    // "Copy path", singular: three selected, one on screen, one in the menu.
    await user.click(screen.getByRole("menuitem", { name: "Copy path" }));

    await waitFor(() => {
      const sent = engine.seen.filter((request) => request.type === "asset:copyPath");
      expect(sent).toHaveLength(1);
      expect((sent[0] as { ids: readonly string[] }).ids).toEqual([
        cells[2]?.getAttribute("data-id"),
      ]);
    });
  });

  it("asks for the next page as the scroll approaches the bottom, and then stops", async () => {
    const { engine } = await open(250);
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));

    const pages = (): number =>
      engine.seen.filter((request) => request.type === "assets:page").length;
    // One page for a screen of grid, and no speculative second: 250 rows are
    // several screens deep, and fetching them all up front is what keyset
    // paging exists to avoid.
    expect(pages()).toBe(1);

    const grid = screen.getByRole("listbox");
    // Measured off the canvas rather than guessed: a fixed offset lands
    // wherever the layout happens to put things, and a scroll past the end
    // shows nothing at all.
    const toBottom = (): void => {
      const canvas = grid.querySelector<HTMLElement>(".grid-canvas");
      const height = Number.parseInt(canvas?.style.height ?? "0", 10);
      Object.defineProperty(grid, "scrollTop", {
        configurable: true,
        value: Math.max(0, height - 800),
      });
      act(() => {
        grid.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
    };

    toBottom();
    await waitFor(() => expect(pages()).toBe(2));
    toBottom();
    // Three pages covers 250 rows; the third is short, which ends it.
    await waitFor(() => expect(pages()).toBe(3));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));

    toBottom();
    // A fourth request would mean the grid ignored the `next: null` it was sent.
    expect(pages()).toBe(3);
  });

  it("shows a rename in the grid, without re-paging it", async () => {
    // Reported from real use on 2026-09-07: renaming in the inspector left the
    // cell under it saying the old name until the view was left and come back
    // to. The grid re-pages only when a count moves (`App.tsx`, on `revision`)
    // and a rename moves neither — so the window has to put the new name on the
    // card it already holds. Re-paging instead would answer the complaint and
    // throw the scroll position away with it, which is why the second half of
    // this test matters as much as the first.
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 12 },
      assets: Array.from({ length: 12 }, (_, i) => fakeAsset(i)),
      // The panel needs a record to draw; the cards and this one agree on the
      // name, the way the engine's two reads of one row do.
      details: [fakeDetail(0)],
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(12));

    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    const field = (await screen.findByLabelText("Name")) as HTMLTextAreaElement;
    const pages = engine.seen.filter((request) => request.type === "assets:page").length;

    await user.clear(field);
    await user.type(field, "sunset{Enter}");

    // The cell's accessible name is the asset's name, so this is the grid
    // reading differently and not merely the panel.
    expect(await screen.findByRole("option", { name: "sunset.png" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "asset-0.png" })).toBeNull();
    expect(engine.seen.filter((request) => request.type === "assets:page").length).toBe(pages);
  });

  it("counts the selection in the status bar", async () => {
    const { user } = await open(12);
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(12));

    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    expect(await screen.findByText("12 assets · 1 selected")).toBeDefined();

    await user.keyboard("{Shift>}");
    await user.click(screen.getAllByRole("option")[4] as HTMLElement);
    await user.keyboard("{/Shift}");
    expect(await screen.findByText("12 assets · 5 selected")).toBeDefined();
  });

  it("drops the selection when Delete takes it off screen, and still says what happened", async () => {
    // Both halves were found by driving a real window, and neither shows in a
    // component test of the menu alone: the selection lives in `App`, the note
    // lives in `App`, and it was `App` that wiped one with the other.
    const { engine, user } = await open(12);
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(12));
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    expect(await screen.findByText("12 assets · 1 selected")).toBeDefined();

    await user.keyboard("{Delete}");

    await waitFor(() =>
      expect(engine.seen.some((request) => request.type === "assets:trash")).toBe(true),
    );
    // The asset is off screen, so a selection naming it is a selection of
    // something nobody can see — the inspector would go on editing it. The
    // total is the fake's own and is pinned, so what is asserted is the
    // disappearance of the selection clause rather than the count beside it.
    await waitFor(() => expect(screen.queryByText(/ · 1 selected/)).toBeNull());
    expect(screen.getByText("12 assets")).toBeDefined();

    // **Read after the clear has rendered, never with `findByText`.** The
    // status line survives the selection change the action itself caused, and
    // an unstamped note is wiped by the effect that drops a stale result — but
    // it is on screen for one commit first, which `findByText` resolves on and
    // then stops watching. Written that way the test passed with the fix
    // removed (`TODO.md` §4, lesson 9).
    expect(screen.getByText("Moved 1 asset to the trash")).toBeDefined();
  });

  it("keeps the selection after an export, which takes nothing off screen", async () => {
    // The other half of the rule: only actions that remove assets from the view
    // clear the selection, or exporting twelve would deselect them.
    const { user } = await open(12);
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(12));
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);

    const grid = screen.getByRole("listbox", { name: "Assets" });
    grid.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await user.click(await screen.findByRole("menuitem", { name: "Export…" }));

    expect(await screen.findByText("12 assets · 1 selected")).toBeDefined();
  });

  /** The first cell's box, as the layout set it. */
  const box = (): { width: number; height: number } => {
    const cell = screen.getAllByRole("option")[0] as HTMLElement;
    return {
      width: Number.parseInt(cell.style.width, 10),
      height: Number.parseInt(cell.style.height, 10),
    };
  };

  it("turns proportional icons into square ones without losing the rows", async () => {
    const { user } = await open(12);
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(12));

    // The fixture is 800x600, so a proportional cell is three-quarters of its
    // width plus the caption band — shorter than its width either way.
    const before = box();
    expect(before.height).toBeLessThan(before.width);

    await user.click(screen.getByRole("button", { name: "View" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /Match image/ }));

    expect(screen.getAllByRole("option")).toHaveLength(12);
    // Square now: the picture is the column's width, and the band is on top.
    const after = box();
    expect(after.height).toBeGreaterThan(after.width);
  });

  it("switches view from the menu, and again from the keyboard", async () => {
    const { user } = await open(12);
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(12));

    await user.click(screen.getByRole("button", { name: "View" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Details/ }));
    expect(screen.getByRole("listbox").getAttribute("data-view")).toBe("details");
    // One row per asset across the width, which is what makes it a table.
    const widths = new Set(
      screen.getAllByRole("option").map((cell) => (cell as HTMLElement).style.width),
    );
    expect(widths.size).toBe(1);

    // `Ctrl+2` from anywhere in the window, not only from the grid.
    await user.keyboard("{Control>}2{/Control}");
    expect(screen.getByRole("listbox").getAttribute("data-view")).toBe("compact");
  });

  it("leaves Ctrl+1 alone while somebody is typing a query", async () => {
    // A guard that only checked the modifier would be one shortcut away from
    // eating a keystroke meant for the field.
    const { user } = await open(12);
    await user.click(screen.getByRole("button", { name: "View" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Details/ }));
    expect(screen.getByRole("listbox").getAttribute("data-view")).toBe("details");

    await user.click(screen.getByLabelText("Search"));
    await user.keyboard("{Control>}1{/Control}");
    expect(screen.getByRole("listbox").getAttribute("data-view")).toBe("details");
  });

  it("hides the proportion checkbox in a view it says nothing about", async () => {
    // A control that does nothing is worse than an absent one (`UI_SPEC.md` §8).
    const { user } = await open(12);
    await user.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: /Match image/ })).toBeDefined();

    await user.click(screen.getByRole("menuitemradio", { name: /Compact/ }));
    await user.click(screen.getByRole("button", { name: "View" }));
    await waitFor(() =>
      expect(screen.queryByRole("menuitemcheckbox", { name: /Match image/ })).toBeNull(),
    );
  });

  it("zooms the cells, and the menu stays open to do it again", async () => {
    // A row of buttons rather than three items exists so that zooming twice
    // does not cost two trips through the menu.
    const { user } = await open(12);
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(12));
    const before = box().width;

    await user.click(screen.getByRole("button", { name: "View" }));
    await user.click(await screen.findByRole("menuitem", { name: "Zoom in" }));
    // Still open, which is the whole reason these are a row and not three items.
    expect(screen.getByRole("menu")).toBeDefined();

    // Radix hides the rest of the page from the accessibility tree while a menu
    // is open, so the grid can only be read once it is closed.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(box().width).toBeGreaterThan(before));

    await user.click(screen.getByRole("button", { name: "View" }));
    await user.click(await screen.findByRole("menuitem", { name: "Reset zoom" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(box().width).toBe(before));
  });

  /**
   * Opens the view menu and its Sort By submenu.
   *
   * The rows inside it are clicked with `fireEvent` rather than through
   * `userEvent`: a `radix-ui` submenu decides what a pointer did from the
   * sequence of pointer events, and happy-dom's sequence is not a browser's —
   * the same difference that made a second tick close the filter menu on
   * 2026-09-08. What a pointer really does to this menu is asserted against a
   * window instead, in `scripts/check-grid.mjs`.
   */
  const openSort = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
    await user.click(screen.getByRole("button", { name: "View" }));
    await user.click(await screen.findByRole("menuitem", { name: /Sort By/ }));
  };

  it("sorts the grid by what the menu was asked for, and remembers it", async () => {
    // ADR-0039. Two claims in one gesture: the grid re-pages in the new order,
    // and the order is written to the library rather than held by the window.
    const { engine, user } = await open(6);
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(6));
    const names = (): string[] =>
      screen.getAllByRole("option").map((cell) => cell.getAttribute("aria-label") ?? "");
    const first = names();

    await openSort(user);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Size" }));
    await user.keyboard("{Escape}");

    // Largest first, which is what Size means without being asked which way.
    await waitFor(() => expect(names()).toEqual([...first].reverse()));
    expect(engine.settings).toMatchObject({ sortKey: "size", sortDescending: true });

    // And the page was asked for in that order rather than sorted in the
    // window: the grid holds one screen of a listing it cannot see the rest of.
    const asked = engine.seen.filter((request) => request.type === "assets:page");
    expect(asked.at(-1)).toMatchObject({ sort: { key: "size", descending: true } });
  });

  it("turns the order round without changing the key", async () => {
    const { engine, user } = await open(6);
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(6));

    await openSort(user);
    // The words are the key's own — nobody wants "imported ascending".
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Oldest first" }));
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(engine.settings).toMatchObject({ sortKey: "added", sortDescending: false }),
    );
  });

  it("offers a shuffle rather than a direction, and rolls a new one on demand", async () => {
    // A shuffle has no direction: reversing one is another shuffle (ADR-0039).
    const { engine, user } = await open(6);
    await openSort(user);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Random" }));
    await user.keyboard("{Escape}");

    await openSort(user);
    expect(screen.queryByRole("menuitemradio", { name: "Newest first" })).toBeNull();
    const shuffle = await screen.findByRole("menuitem", { name: "Shuffle again" });

    const before = engine.settings.shuffleSeed;
    fireEvent.click(shuffle);
    await waitFor(() => expect(engine.settings.shuffleSeed).not.toBe(before));
    expect(engine.settings.sortKey).toBe("random");
  });

  it("opens in the order, view and zoom the library was left in", async () => {
    // The whole point of the preference being the library's (ADR-0039 §7): a
    // window that asked again on every open is one that forgot.
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 6 },
      assets: Array.from({ length: 6 }, (_, i) => fakeAsset(i)),
      settings: {
        showSubfolderContents: false,
        fitVideoToWindow: false,
        mediaVolume: 100,
        mediaMuted: false,
        sortKey: "name",
        sortDescending: false,
        shuffleSeed: 0,
        gridView: "details",
        matchImageProportions: false,
        showFolders: true,
        gridZoom: 400,
        showSidebar: true,
        showInspector: true,
        sidebarWidth: 240,
        inspectorWidth: 280,
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await screen.findByRole("heading", { name: "Holiday Photos" });

    await waitFor(() =>
      expect(screen.getByRole("listbox").getAttribute("data-view")).toBe("details"),
    );
    // The first page was asked for in the remembered order, not in the default
    // and then again — the read comes before the page for exactly this.
    const asked = engine.seen.filter((request) => request.type === "assets:page");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ sort: { key: "name", descending: false } });
  });

  it("takes a view it has never heard of as Icons", async () => {
    // The vocabulary is the window's, so a `settings.json` from a newer build
    // must not leave the grid drawing nothing.
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 3 },
      assets: Array.from({ length: 3 }, (_, i) => fakeAsset(i)),
      settings: {
        showSubfolderContents: false,
        fitVideoToWindow: false,
        mediaVolume: 100,
        mediaMuted: false,
        sortKey: "added",
        sortDescending: true,
        shuffleSeed: 0,
        gridView: "gallery",
        matchImageProportions: true,
        showFolders: true,
        gridZoom: 240,
        showSidebar: true,
        showInspector: true,
        sidebarWidth: 240,
        inspectorWidth: 280,
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await screen.findByRole("heading", { name: "Holiday Photos" });
    await waitFor(() =>
      expect(screen.getByRole("listbox").getAttribute("data-view")).toBe("icons"),
    );
  });

  it("has no Group By, because it never did anything", async () => {
    // Withdrawn on 2026-09-09 (ADR-0039 §8). It stood here as a disabled
    // promise from ADR-0018, and a menu item that has never done anything is
    // one nobody should read twice.
    const { user } = await open(3);
    await user.click(screen.getByRole("button", { name: "View" }));
    await screen.findByRole("menu");
    expect(screen.queryByText("Group By")).toBeNull();
  });

  it("says so when a library holds nothing, rather than showing an empty grid", async () => {
    await open(0);
    expect(await screen.findByText("Nothing in this library yet.")).toBeDefined();
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("making files in the window (ADR-0026 §4, §5)", () => {
  const HOLIDAY = "/home/you/Holiday Photos.roost";

  const open = async (options: ConstructorParameters<typeof FakeEngine>[0] = {}) => {
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 0 },
      assets: [],
      ...options,
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await screen.findByRole("heading", { name: "Holiday Photos" });
    return { engine, user };
  };

  /** Right-clicks the empty library, where the menu over nothing lives. */
  const openMenu = async (): Promise<void> => {
    const empty = await screen.findByText("Nothing in this library yet.");
    empty.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");
  };

  it("asks for a name and nothing else", async () => {
    const { engine, user } = await open();
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "New file…" }));

    // No `untitled`: a file called that is a file somebody has to rename, so
    // the dialog asks the question instead of inventing an answer.
    const name = await screen.findByLabelText("Name");
    expect((name as HTMLInputElement).value).toBe("");
    // One field. Asking for contents as well was tried on 2026-09-04 and
    // withdrawn the next day.
    expect(screen.queryByLabelText("Contents")).toBeNull();
    expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(true);

    await user.type(name, "notes.md");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(engine.seen.filter((request) => request.type === "asset:create")).toEqual([
        { type: "asset:create", name: "notes.md", text: "" },
      ]),
    );
  });

  /**
   * The second door onto the same dialog. Not a second kind of file — the only
   * difference is that the extension is already typed.
   */
  it("opens with the extension already there when the menu said text document", async () => {
    const { engine, user } = await open();
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(await screen.findByRole("menuitem", { name: "New text document…" }));

    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    expect(name.value).toBe(".txt");
    // The caret sits in front of it, so what is typed becomes the stem rather
    // than a suffix on an extension.
    expect(name.selectionStart).toBe(0);
    // And a prefill is not an answer: `.txt` alone would make a file called
    // `.txt`.
    expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(true);

    // The caret is stated rather than inherited: `type` clicks first, and a
    // click in a headless DOM lands at the end of the value. Where it really
    // starts is the assertion above; this is the typing that follows from it.
    await user.type(name, "shopping", { initialSelectionStart: 0, initialSelectionEnd: 0 });
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(engine.seen.filter((request) => request.type === "asset:create")).toEqual([
        { type: "asset:create", name: "shopping.txt", text: "" },
      ]),
    );
  });

  it("keeps pasted words as the new file's contents, without a field for them", async () => {
    const { engine, user } = await open({ clipboard: { kind: "text", text: "pasted words" } });
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Paste" }));

    // Pasting has already said what the words are, so the dialog only asks the
    // question it does not know the answer to.
    expect(await screen.findByText(/12 characters you pasted/)).toBeDefined();
    await user.type(screen.getByLabelText("Name"), "notes.txt");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(engine.seen.filter((request) => request.type === "asset:create")).toEqual([
        { type: "asset:create", name: "notes.txt", text: "pasted words" },
      ]),
    );
  });

  it("does not fetch a link, and says so", async () => {
    const { engine, user } = await open({
      clipboard: { kind: "url", url: "https://example.com/a.png" },
    });
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Paste" }));

    // Invariant 7 permits one network operation, and it is not one a Ctrl+V may
    // trigger.
    expect(await screen.findByText(/never fetches a link/)).toBeDefined();
    expect(engine.seen.some((request) => request.type === "import:paths")).toBe(false);
  });

  it("says when the clipboard had nothing on it", async () => {
    const { user } = await open();
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Paste" }));
    expect(await screen.findByText("Nothing on the clipboard")).toBeDefined();
  });
});

describe("the navigation pane, in the window", () => {
  const HOLIDAY = "/home/you/Holiday Photos.roost";

  /** An empty folder to drop things onto. */
  const LOGOS: SidebarFolderRow = {
    id: "folder:8",
    name: "Logos",
    query: 'folder:"Logos"',
    count: 0,
    depth: 0,
    group: null,
    stars: null,
    folder: 8,
    path: "Logos",
    descendants: 0,
  };

  /**
   * Drops `ids` on a folder row.
   *
   * Through `createEvent`, because React routes its own synthetic events and a
   * hand-dispatched `Event` never reaches `onDrop`.
   */
  function dropOn(row: string, ids: readonly string[]): void {
    const branch = screen.getByRole("button", { name: row }).closest(".sidebar-branch");
    if (!(branch instanceof HTMLElement)) throw new Error(`no branch for ${row}`);
    const dataTransfer = {
      types: [ASSET_DRAG_TYPE],
      getData: () => JSON.stringify(ids),
      dropEffect: "none",
      effectAllowed: "all",
    } as unknown as DataTransfer;
    fireEvent(branch, createEvent.drop(branch, { dataTransfer }));
  }

  /** One folder with something in it, which is what a delete has to ask about. */
  const DESIGN: SidebarFolderRow = {
    id: "folder:7",
    name: "Design",
    query: 'folder:"Design"',
    count: 2,
    descendants: 2,
    depth: 0,
    group: null,
    stars: null,
    folder: 7,
    path: "Design",
  };

  beforeEach(() => {
    for (const [name, value] of [
      ["clientWidth", 1000],
      ["clientHeight", 800],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
    }
  });

  it("makes a folder from the pane, and reveals what it made", async () => {
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 9 },
      assets: Array.from({ length: 9 }, (_, i) => fakeAsset(i)),
      sidebar: {
        ratings: [],
        places: [],
        folders: [DESIGN],
        smartFolders: [],
        tags: [],
        types: [],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(9));

    await user.click(screen.getByRole("button", { name: "New folder" }));
    await user.type(await screen.findByLabelText("Name"), "Logos");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(engine.seen.some((request) => request.type === "folder:create")).toBe(true),
    );
    const made = [...engine.seen].reverse().find((r) => r.type === "folder:create");
    expect(made).toMatchObject({ name: "Logos", parent: null });
    // The pane re-reads and the new folder is on screen, which is the whole
    // point of the window doing this rather than the CLI.
    expect(await screen.findByRole("button", { name: /Logos/ })).toBeDefined();
  });

  it("asks what a folder delete should do with the assets, and does that", async () => {
    // ADR-0033: one gesture, two outcomes, and the checkbox is which. Unticked
    // is the default, because the ticked answer is the one that touches assets.
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 9 },
      assets: Array.from({ length: 9 }, (_, i) => fakeAsset(i)),
      sidebar: {
        ratings: [],
        places: [],
        folders: [DESIGN],
        smartFolders: [],
        tags: [],
        types: [],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(9));

    const row = screen.getByRole("button", { name: "Design 2" });
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete folder…" }));

    const box = await screen.findByRole("checkbox", { name: /Also move 2 assets to the trash/ });
    expect((box as HTMLInputElement).checked).toBe(false);
    await user.click(box);
    await user.click(screen.getByRole("button", { name: "Delete folder" }));

    await waitFor(() =>
      expect(engine.seen.some((request) => request.type === "folder:delete")).toBe(true),
    );
    expect([...engine.seen].reverse().find((r) => r.type === "folder:delete")).toMatchObject({
      folder: 7,
      trashContents: true,
    });
    expect(
      await screen.findByText("Deleted Design, and moved 2 assets to the trash"),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: /Design/ })).toBeNull();
  });

  it("empties the trash from the sidebar row, once the dialog is answered", async () => {
    // Asked for 2026-09-08. The command was in the grid's menu only, so
    // reaching it meant standing in the Trash place first — and the row that
    // carries the count is where somebody looks for it.
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 9 },
      assets: Array.from({ length: 9 }, (_, i) => fakeAsset(i)),
      trashSize: 2,
      freedBytes: 3 * 1024 * 1024,
      sidebar: {
        ratings: [],
        places: [
          {
            id: "all",
            name: "All assets",
            query: "",
            count: null,
            depth: 0,
            group: null,
            stars: null,
          },
          {
            id: "trash",
            name: "Trash",
            query: "is:trashed",
            count: 2,
            depth: 0,
            group: null,
            stars: null,
          },
        ],
        folders: [],
        smartFolders: [],
        tags: [],
        types: [],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));

    const row = await screen.findByRole("button", { name: "Trash 2" });
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await user.click(await screen.findByRole("menuitem", { name: "Empty trash" }));

    // The dialog is the gate, not a notice beside a request that already went.
    await screen.findByRole("alertdialog");
    expect(engine.seen.some((request) => request.type === "assets:emptyTrash")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Empty trash" }));
    await waitFor(() =>
      expect(engine.seen.some((request) => request.type === "assets:emptyTrash")).toBe(true),
    );
    // The freed bytes are the half a person empties the trash for (ADR-0031).
    expect(await screen.findByText("Deleted 2 assets, freeing 3.0 MiB")).toBeDefined();
  });

  it("moves assets when they are dragged out of a folder, and adds when they are not", async () => {
    // `UI_SPEC.md` §4.3. The pane reports the drop; the window decides whether
    // it is a move, because a folder is a collection and there is nothing to
    // move *out of* unless one is on screen.
    const inDesign = [fakeAsset(0), fakeAsset(1)];
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 9 },
      assets: Array.from({ length: 9 }, (_, i) => fakeAsset(i)),
      byQuery: { 'folder:"Design"': inDesign },
      sidebar: {
        ratings: [],
        places: [],
        folders: [DESIGN, LOGOS],
        smartFolders: [],
        tags: [],
        types: [],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(9));

    // From "All assets" there is no folder to leave, so this is an add.
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    dropOn("Logos 0", [fakeAsset(0).id]);
    await waitFor(() =>
      expect(engine.seen.some((request) => request.type === "asset:folderAdd")).toBe(true),
    );
    expect(engine.seen.some((request) => request.type === "asset:folderRemove")).toBe(false);
    expect(await screen.findByText("Added 1 asset to Logos")).toBeDefined();

    // From inside Design there is, so the same gesture is a move.
    await user.click(screen.getByRole("button", { name: "Design 2" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(2));
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    dropOn("Logos 0", [inDesign[0]?.id ?? ""]);

    await waitFor(() =>
      expect(engine.seen.some((request) => request.type === "asset:folderRemove")).toBe(true),
    );
    expect([...engine.seen].reverse().find((r) => r.type === "asset:folderRemove")).toMatchObject({
      folder: DESIGN.folder,
    });
    // It left the view it was dragged out of, and the grid drops the row for
    // the same reason `Ctrl+Delete` does.
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(1));
    expect(screen.getByText("Moved 1 asset from Design to Logos")).toBeDefined();
  });

  it("takes the selection out of the folder on screen, and out of no other", async () => {
    // `UI_SPEC.md` §9. The folder is the one whose query is on screen, matched
    // on the string the engine sent — the renderer assembles no RQL — and the
    // shortcut does nothing at all outside one.
    const inDesign = [fakeAsset(0), fakeAsset(1)];
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 9 },
      assets: Array.from({ length: 9 }, (_, i) => fakeAsset(i)),
      byQuery: { 'folder:"Design"': inDesign },
      sidebar: {
        ratings: [],
        places: [],
        folders: [
          {
            id: "folder:7",
            name: "Design",
            query: 'folder:"Design"',
            count: 2,
            depth: 0,
            group: null,
            stars: null,
            folder: 7,
            path: "Design",
            descendants: 2,
          },
        ],
        smartFolders: [],
        tags: [],
        types: [],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(9));

    // Outside the folder the keystroke is inert: there is no folder to name,
    // and guessing at one would be a removal nobody asked for.
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    await user.keyboard("{Control>}{Delete}{/Control}");
    expect(engine.seen.some((request) => request.type === "asset:folderRemove")).toBe(false);

    await user.click(await screen.findByRole("button", { name: "Design 2" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(2));

    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    await user.keyboard("{Control>}{Delete}{/Control}");

    await waitFor(() =>
      expect(engine.seen.some((request) => request.type === "asset:folderRemove")).toBe(true),
    );
    const sent = [...engine.seen].reverse().find((r) => r.type === "asset:folderRemove");
    expect(sent).toMatchObject({ ids: [inDesign[0]?.id], folder: 7 });
    // Nothing was trashed: leaving a collection is not leaving the library.
    expect(engine.seen.some((request) => request.type === "assets:trash")).toBe(false);

    // Read after the clear renders, never with `findByText` (`TODO.md` §4).
    await waitFor(() => expect(screen.queryByText(/ · 1 selected/)).toBeNull());
    expect(screen.getByText("Removed 1 asset from Design")).toBeDefined();

    // The row leaves the grid. It does not re-page — an asset taken out of a
    // folder is still there and still live, so neither count the grid watches
    // moves — so the window drops the row itself. Found in a real window on
    // 2026-09-07, where the status bar said it was gone and the grid still
    // showed it (`scripts/check-folders.mjs`).
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(inDesign.length - 1));
  });

  it("sends a facet as values and pages with the query the engine spelled", async () => {
    // ADR-0035. The tag vocabulary moved from the pane to the filter bar, and
    // with it the rule that keeps the search field honest: the renderer sends
    // the tag's **name**, never a query, and the engine decides that a name
    // with a space in it needs quoting. The fake refuses a query it was not
    // taught, so this passes only if the string that came back is the one that
    // reached the grid.
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 9 },
      assets: Array.from({ length: 9 }, (_, i) => fakeAsset(i)),
      byQuery: { 'tag:"brand assets"': [fakeAsset(100), fakeAsset(101)] },
      sidebar: {
        ratings: [],
        places: [
          {
            id: "all",
            name: "All assets",
            query: "",
            count: null,
            depth: 0,
            group: null,
            stars: null,
          },
        ],
        folders: [],
        smartFolders: [],
        tags: [
          {
            id: "tag:brand",
            name: "brand assets",
            // Quoted by `@roost/library`, which is the point: the renderer
            // would not have known to.
            query: 'tag:"brand assets"',
            count: 2,
            depth: 0,
            group: null,
            stars: null,
          },
        ],
        types: [],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(9));

    await user.click(screen.getByRole("button", { name: /^Tags/ }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /brand assets/ }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(2));

    // What the renderer sent: a name, as data. No colon, no quote, no grammar.
    const joined = engine.seen.find((request) => request.type === "query:join");
    expect(joined).toMatchObject({ place: "", facets: { tags: ["brand assets"] } });

    // What the grid asked for: the string that came back, quoting and all.
    const pages = engine.seen.filter((request) => request.type === "assets:page");
    expect(pages.at(-1)).toMatchObject({ query: 'tag:"brand assets"' });

    // And the button says which tag, rather than only that something is on —
    // read back out of the query, not remembered from the click.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Tags/ }).textContent).toContain("brand assets"),
    );
  });

  it("remembers the tag rule the query cannot hold, and lets the query overrule it", async () => {
    // ADR-0035 §7.2, and the decision the user made on 2026-09-08. With one tag
    // chosen, `tag:a` is the same string under either rule — so the window
    // remembers, and the moment a second tag makes the rule expressible the
    // query wins.
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 9 },
      assets: Array.from({ length: 9 }, (_, i) => fakeAsset(i)),
      byQuery: {
        "tag:olahraga": [fakeAsset(0), fakeAsset(1), fakeAsset(2)],
        "tag:olahraga tag:traveling": [fakeAsset(0)],
        "(tag:olahraga OR tag:traveling)": [fakeAsset(0), fakeAsset(1), fakeAsset(2), fakeAsset(3)],
      },
      sidebar: {
        ratings: [],
        places: [],
        folders: [],
        smartFolders: [],
        tags: [
          {
            id: "tag:olahraga",
            name: "olahraga",
            query: "tag:olahraga",
            count: 3,
            depth: 0,
            group: null,
            stars: null,
          },
          {
            id: "tag:traveling",
            name: "traveling",
            query: "tag:traveling",
            count: 2,
            depth: 0,
            group: null,
            stars: null,
          },
        ],
        types: [],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(9));

    await user.click(screen.getByRole("button", { name: /^Tags/ }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /olahraga/ }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(3));

    // All, while only one tag is chosen: the query cannot say so and does not
    // change. Nothing on screen may forget it either.
    await user.click(screen.getByRole("button", { name: "Rule: All" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /traveling/ }));

    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(1));
    const pages = engine.seen.filter((request) => request.type === "assets:page");
    expect(pages.at(-1)).toMatchObject({ query: "tag:olahraga tag:traveling" });

    // And the query overrules the memory: typing the OR by hand moves the
    // toggle back, because the bar is a view of the query.
    await user.keyboard("{Escape}");
    const field = screen.getByRole("searchbox", { name: "Search" });
    await user.clear(field);
    await user.type(field, "(tag:olahraga OR tag:traveling){Enter}");
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(4));

    await user.click(screen.getByRole("button", { name: /^Tags/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Rule: Any" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
  });

  it("keeps the filters standing when a folder is picked", async () => {
    // ADR-0035 §6, the one rule this changed: a row replaces every conjunct the
    // bar does not own and leaves the ones it does. Before the bar, a row
    // replaced the whole query — so opening a folder threw away the filter
    // somebody had just set, which is the opposite of what a filter bar is for.
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 9 },
      assets: Array.from({ length: 9 }, (_, i) => fakeAsset(i)),
      byQuery: {
        "ext:png": [fakeAsset(0), fakeAsset(1), fakeAsset(2)],
        'folder:"Design" ext:png': [fakeAsset(0)],
      },
      sidebar: {
        ratings: [],
        places: [],
        folders: [
          {
            id: "folder:7",
            name: "Design",
            query: 'folder:"Design"',
            count: 2,
            depth: 0,
            group: null,
            stars: null,
            folder: 7,
            path: "Design",
            descendants: 2,
          },
        ],
        smartFolders: [],
        tags: [],
        types: [{ ext: "png", count: 3 }],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(9));

    await user.click(screen.getByRole("button", { name: /^Types/ }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /PNG/ }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(3));

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Design 2" }));

    // The folder became the place; the type filter is still on, and the grid
    // asked for both together.
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(1));
    const pages = engine.seen.filter((request) => request.type === "assets:page");
    expect(pages.at(-1)).toMatchObject({ query: 'folder:"Design" ext:png' });
    expect(screen.getByRole("button", { name: /^Types/ }).textContent).toContain("PNG");
  });

  it("says nothing matched, rather than showing an empty library", async () => {
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 9 },
      assets: Array.from({ length: 9 }, (_, i) => fakeAsset(i)),
      byQuery: { "is:favorite": [] },
      sidebar: {
        ratings: [],
        places: [
          {
            id: "all",
            name: "All assets",
            query: "",
            count: null,
            depth: 0,
            group: null,
            stars: null,
          },
          {
            id: "favorites",
            name: "Favorites",
            query: "is:favorite",
            count: null,
            depth: 0,
            group: null,
            stars: null,
          },
        ],
        folders: [],
        smartFolders: [],
        tags: [],
        types: [],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(9));

    await user.click(screen.getByRole("button", { name: "Favorites" }));
    // A library with nine assets and a filter that matches none of them is not
    // an empty library, and saying so would be a lie the user has to debug.
    expect(await screen.findByText("Nothing matches this query.")).toBeDefined();
  });

  it("drops the selection when the query changes", async () => {
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 9 },
      assets: Array.from({ length: 9 }, (_, i) => fakeAsset(i)),
      byQuery: { "is:favorite": [fakeAsset(50)] },
      sidebar: {
        ratings: [],
        places: [
          {
            id: "all",
            name: "All assets",
            query: "",
            count: null,
            depth: 0,
            group: null,
            stars: null,
          },
          {
            id: "favorites",
            name: "Favorites",
            query: "is:favorite",
            count: null,
            depth: 0,
            group: null,
            stars: null,
          },
        ],
        folders: [],
        smartFolders: [],
        tags: [],
        types: [],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(9));
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    expect(await screen.findByText("9 assets · 1 selected")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Favorites" }));
    // What was selected is no longer on screen, and a count that survives the
    // filter is a count of things nobody can see. The total becomes the match
    // count, because the grid is no longer showing the whole library.
    expect(await screen.findByText("1 asset")).toBeDefined();
  });
});

describe("Show subfolder contents, in the window (ADR-0036)", () => {
  const HOLIDAY = "/home/you/Holiday Photos.roost";

  const DESIGN: SidebarFolderRow = {
    id: "folder:7",
    name: "Design",
    query: "infolder:Design",
    count: 1,
    descendants: 4,
    depth: 0,
    group: null,
    stars: null,
    folder: 7,
    path: "Design",
  };

  const open = async () => {
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 4 },
      assets: Array.from({ length: 4 }, (_, i) => fakeAsset(i)),
      sidebar: {
        ratings: [],
        places: [],
        folders: [DESIGN],
        smartFolders: [],
        tags: [],
        types: [],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await screen.findByRole("heading", { name: "Holiday Photos" });
    return { engine, user };
  };

  const box = (): HTMLElement => screen.getByRole("checkbox", { name: "Show subfolder contents" });

  it("starts from the library's setting while no folder is on screen", async () => {
    await open();
    // Nothing to reflect: the query names no folder, so the checkbox says what
    // the **next** folder opened will show.
    expect(box()).toHaveProperty("checked", false);
  });

  it("writes the setting and rewrites the folder on screen, in that order", async () => {
    const { engine, user } = await open();
    await user.click(await screen.findByRole("button", { name: /^Design/ }));
    await waitFor(() =>
      expect(screen.getByRole("searchbox", { name: /Search/ })).toHaveProperty(
        "value",
        "infolder:Design",
      ),
    );

    await user.click(box());

    // Both halves. The setting decides the term the next folder row carries;
    // the query on screen is rewritten so the grid answers now rather than
    // after the next click.
    await waitFor(() =>
      expect(engine.seen.some((request) => request.type === "settings:write")).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByRole("searchbox", { name: /Search/ })).toHaveProperty(
        "value",
        "folder:Design",
      ),
    );
    expect(engine.settings).toMatchObject({
      showSubfolderContents: true,
      fitVideoToWindow: false,
    });
  });

  it("reflects the query rather than the setting once a folder is on screen", async () => {
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: /^Design/ }));
    // `infolder:` unticks it, and it was already unticked; type `folder:` by
    // hand and it ticks, which is the promise §4.2 makes about this bar.
    const field = screen.getByRole("searchbox", { name: /Search/ });
    await user.clear(field);
    await user.type(field, "folder:Design{Enter}");
    await waitFor(() => expect(box()).toHaveProperty("checked", true));
  });

  it("asks about the subtree when a folder is deleted, not about what is drawn", async () => {
    // The row shows 1 and holds 4. A question saying "also move 1 asset" while
    // trashing four would be the worst kind of wrong (ADR-0036).
    const { user } = await open();
    const row = await screen.findByRole("button", { name: /^Design/ });
    fireEvent.contextMenu(row);
    await user.click(await screen.findByRole("menuitem", { name: "Delete folder…" }));
    expect(await screen.findByText(/Also move 4 assets to the trash/)).toBeDefined();
  });
});

describe("folders in the grid, in the window (ADR-0043)", () => {
  const HOLIDAY = "/home/you/Holiday Photos.roost";

  const DESIGN: SidebarFolderRow = {
    id: "folder:7",
    name: "Design",
    query: "infolder:Design",
    count: 4,
    descendants: 6,
    depth: 0,
    group: null,
    stars: null,
    folder: 7,
    path: "Design",
  };

  /** A child of it, which is what the grid draws a tile for. */
  const ICONS: SidebarFolderRow = {
    id: "folder:9",
    name: "Icons",
    query: "infolder:Design/Icons",
    count: 2,
    descendants: 2,
    depth: 1,
    group: null,
    stars: null,
    folder: 9,
    path: "Design/Icons",
  };

  beforeEach(() => {
    for (const [name, value] of [
      ["clientWidth", 1000],
      ["clientHeight", 800],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
    }
  });

  const open = async () => {
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 4 },
      assets: Array.from({ length: 4 }, (_, i) => fakeAsset(i)),
      byQuery: {
        "infolder:Design": Array.from({ length: 4 }, (_, i) => fakeAsset(i)),
        "folder:Design": Array.from({ length: 6 }, (_, i) => fakeAsset(i)),
        "infolder:Design rating:5": [fakeAsset(0)],
        "infolder:Design/Icons": [fakeAsset(0), fakeAsset(1)],
      },
      sidebar: {
        ratings: [],
        places: [],
        folders: [DESIGN, ICONS],
        smartFolders: [],
        tags: [],
        types: [],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(4));
    return { engine, user };
  };

  const tiles = (): HTMLElement[] =>
    screen
      .getAllByRole("option")
      .filter((cell) => cell.getAttribute("data-id")?.startsWith("folder-") === true);

  const field = (): HTMLElement => screen.getByRole("searchbox", { name: /Search/ });

  it("draws none outside a folder, and the children inside one", async () => {
    const { user } = await open();
    // `All assets` is every asset, including the ones in no folder at all: a
    // row of folders across its top would promise a containment the library
    // does not have (ADR-0043 §3).
    expect(tiles()).toEqual([]);

    await user.click(await screen.findByRole("button", { name: /^Design/ }));
    await waitFor(() => expect(field()).toHaveProperty("value", "infolder:Design"));
    await waitFor(() => expect(tiles().length).toBe(1));
    expect(tiles()[0]?.getAttribute("aria-label")).toBe("Icons, folder, 2 assets");
  });

  it("draws the subfolders of a folder that holds nothing of its own", async () => {
    // Found 2026-09-25 while drawing covers: a folder of folders said "Nothing
    // matches this query" and drew none of the folders it holds.
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 2 },
      assets: [fakeAsset(0), fakeAsset(1)],
      byQuery: { "infolder:Design": [], "infolder:Design/Icons": [fakeAsset(0), fakeAsset(1)] },
      sidebar: {
        ratings: [],
        places: [],
        folders: [DESIGN, ICONS],
        smartFolders: [],
        tags: [],
        types: [],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await user.click(await screen.findByRole("button", { name: /^Design/ }));

    await waitFor(() => expect(tiles().length).toBe(1));
    expect(screen.queryByText(/Nothing matches/)).toBeNull();
  });

  it("draws none once the query is narrowed past the folder itself", async () => {
    // The tiles follow `openFolder`, which matches the query the **engine**
    // wrote for the row — so a filter over the folder takes them away, which is
    // right: a subfolder does not have five stars.
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: /^Design/ }));
    await waitFor(() => expect(tiles().length).toBe(1));

    await user.clear(field());
    await user.type(field(), "infolder:Design rating:5{Enter}");
    await waitFor(() => expect(tiles()).toEqual([]));
  });

  it("draws none while Show subfolder contents is on", async () => {
    // Everything beneath the folder is already in the grid, so a tile would
    // offer the same assets twice — and the view menu says so rather than
    // leaving a checkbox that does nothing (ADR-0043 §9).
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: /^Design/ }));
    await waitFor(() => expect(tiles().length).toBe(1));

    await user.click(screen.getByRole("checkbox", { name: "Show subfolder contents" }));
    await waitFor(() => expect(field()).toHaveProperty("value", "folder:Design"));
    await waitFor(() => expect(tiles()).toEqual([]));

    await user.click(screen.getByRole("button", { name: "View" }));
    const item = await screen.findByRole("menuitemcheckbox", { name: /Show folders/ });
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("descends on a double-click and comes back up on Alt+ArrowUp", async () => {
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: /^Design/ }));
    await waitFor(() => expect(tiles().length).toBe(1));

    await user.dblClick(tiles()[0] as HTMLElement);
    await waitFor(() => expect(field()).toHaveProperty("value", "infolder:Design/Icons"));

    // Not `Backspace`, which the user refused on 2026-09-13 as already spoken
    // for. Explorer binds this one to *up* and that one to *back* (ADR-0043 §8).
    fireEvent.keyDown(window, { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(field()).toHaveProperty("value", "infolder:Design"));

    // And once more, from a top-level folder, which leaves the folders for the
    // library itself.
    fireEvent.keyDown(window, { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(field()).toHaveProperty("value", ""));
  });
});

describe("back, forward and up, in the window (ADR-0044)", () => {
  const HOLIDAY = "/home/you/Holiday Photos.roost";

  const DESIGN: SidebarFolderRow = {
    id: "folder:7",
    name: "Design",
    query: "infolder:Design",
    count: 4,
    descendants: 6,
    depth: 0,
    group: null,
    stars: null,
    folder: 7,
    path: "Design",
  };

  const ICONS: SidebarFolderRow = {
    id: "folder:9",
    name: "Icons",
    query: "infolder:Design/Icons",
    count: 2,
    descendants: 2,
    depth: 1,
    group: null,
    stars: null,
    folder: 9,
    path: "Design/Icons",
  };

  beforeEach(() => {
    for (const [name, value] of [
      ["clientWidth", 1000],
      ["clientHeight", 800],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
    }
  });

  const open = async () => {
    const four = Array.from({ length: 4 }, (_, i) => fakeAsset(i));
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 4 },
      assets: four,
      byQuery: {
        "infolder:Design": four,
        "infolder:Design/Icons": [fakeAsset(0), fakeAsset(1)],
        "infolder:Design rating:5": [fakeAsset(0)],
        "rating:5": [fakeAsset(0)],
      },
      sidebar: {
        ratings: [],
        places: [],
        folders: [DESIGN, ICONS],
        smartFolders: [],
        tags: [],
        types: [],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(4));
    return { engine, user };
  };

  const field = (): HTMLElement => screen.getByRole("searchbox", { name: /Search/ });
  const nav = (name: string): HTMLElement => screen.getByRole("button", { name });

  it("starts with all three dead, and wakes them as the window moves", async () => {
    const { user } = await open();
    // A window that has been nowhere: three buttons that are drawn and cannot
    // act, rather than a row that grows as you use it (ADR-0044 §5).
    expect(nav("Back")).toHaveProperty("disabled", true);
    expect(nav("Forward")).toHaveProperty("disabled", true);
    expect(nav("Up")).toHaveProperty("disabled", true);

    await user.click(await screen.findByRole("button", { name: /^Design/ }));
    await waitFor(() => expect(nav("Back")).toHaveProperty("disabled", false));
    expect(nav("Up")).toHaveProperty("disabled", false);
    expect(nav("Forward")).toHaveProperty("disabled", true);
  });

  it("walks back and forward over the places it has been", async () => {
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: /^Design/ }));
    await waitFor(() => expect(field()).toHaveProperty("value", "infolder:Design"));

    await user.click(nav("Back"));
    await waitFor(() => expect(field()).toHaveProperty("value", ""));
    expect(nav("Forward")).toHaveProperty("disabled", false);

    await user.click(nav("Forward"));
    await waitFor(() => expect(field()).toHaveProperty("value", "infolder:Design"));
  });

  it("goes back on Backspace, which is history rather than hierarchy", async () => {
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: /^Design/ }));
    await waitFor(() => expect(field()).toHaveProperty("value", "infolder:Design"));

    fireEvent.keyDown(window, { key: "Backspace" });
    await waitFor(() => expect(field()).toHaveProperty("value", ""));
  });

  it("leaves a filter out of the history, and keeps the chip while walking", async () => {
    // The user's own answer on 2026-09-13: only a change of **place** is
    // somewhere you have been. Back is not an undo for the filter bar — and
    // travelling keeps the chips standing, exactly as clicking a folder does.
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: /^Design/ }));
    await waitFor(() => expect(field()).toHaveProperty("value", "infolder:Design"));

    await user.clear(field());
    await user.type(field(), "infolder:Design rating:5{Enter}");
    await waitFor(() => expect(field()).toHaveProperty("value", "infolder:Design rating:5"));

    await user.click(nav("Back"));
    await waitFor(() => expect(field()).toHaveProperty("value", "rating:5"));
  });

  it("drops what was ahead once somewhere new is chosen", async () => {
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: /^Design/ }));
    await waitFor(() => expect(field()).toHaveProperty("value", "infolder:Design"));
    await user.click(nav("Back"));
    await waitFor(() => expect(nav("Forward")).toHaveProperty("disabled", false));

    // A different **place** from the one that was ahead: the future that is not
    // being had any more goes, which is what a browser and a file manager both
    // do. A filter would not do this 2014 it is not a place, so it is not a
    // future either.
    await user.clear(field());
    await user.type(field(), "infolder:Design/Icons{Enter}");
    await waitFor(() => expect(nav("Forward")).toHaveProperty("disabled", true));
  });
});

describe("the preview, in the window", () => {
  const HOLIDAY = "/home/you/Holiday Photos.roost";

  beforeEach(() => {
    for (const [name, value] of [
      ["clientWidth", 1000],
      ["clientHeight", 800],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
    }
  });

  const open = async () => {
    const assets = Array.from({ length: 6 }, (_, i) => fakeAsset(i));
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: assets.length },
      assets,
      details: assets.map((_, i) => fakeDetail(i, { name: `asset-${i}.png` })),
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(6));
    return { engine, user, assets };
  };

  it("opens on Enter and closes on Escape, leaving the grid where it was", async () => {
    const { user } = await open();
    await user.click(screen.getAllByRole("option")[2] as HTMLElement);
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getAllByRole("option")).toHaveLength(6);
  });

  it("takes the grid's controls away while a file is open", async () => {
    // Every control in that head is the grid's — search, the view menu, the
    // import — and the grid is not on screen. The preview brings its own head.
    const { user } = await open();
    expect(screen.getByRole("searchbox")).toBeDefined();

    await user.click(screen.getAllByRole("option")[2] as HTMLElement);
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");

    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();

    // And back, with the query it was showing before — the field is unmounted,
    // not emptied.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("searchbox")).toBeDefined();
  });

  it("opens on a double-click", async () => {
    const { user } = await open();
    await user.dblClick(screen.getAllByRole("option")[1] as HTMLElement);
    expect(await screen.findByRole("dialog")).toBeDefined();
  });

  it("hands a file it cannot draw straight to the desktop", async () => {
    // `UI_SPEC.md` §6. A preview that can only offer "Open externally" is a
    // pane in the way of what the gesture meant, so the kind travels on the
    // card and the double-click skips it.
    const assets = [fakeAsset(0, { kind: "other", name: "notes.txt", ext: "txt" })];
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 1 },
      assets,
      details: [fakeDetail(0, { kind: "other", name: "notes.txt", ext: "txt" })],
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(1));

    await user.dblClick(screen.getAllByRole("option")[0] as HTMLElement);

    await waitFor(() =>
      expect(engine.seen.filter((request) => request.type === "asset:openExternally")).toEqual([
        { type: "asset:openExternally", id: assets[0]?.id },
      ]),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("changes the selection as it steps, so the inspector follows", async () => {
    // `UI_SPEC.md` §7. In `roost-old` stepping did not move the selection, and
    // a note could be written onto the wrong asset while the preview showed
    // another one.
    const { user } = await open();
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");

    expect(await screen.findByRole("img", { name: "asset-0.png" })).toBeDefined();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(await screen.findByRole("img", { name: "asset-2.png" })).toBeDefined();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The selection moved with it, which is what "stepping changes the
    // selection" has to mean once the preview is closed again.
    expect(screen.getByText("6 assets · 1 selected")).toBeDefined();
    expect(screen.getByRole("listbox").getAttribute("aria-activedescendant")).toContain(
      fakeAsset(2).id,
    );
  });

  it("stops at the ends rather than wrapping", async () => {
    const { user } = await open();
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    await user.keyboard("{Enter}");
    await screen.findByRole("img", { name: "asset-0.png" });

    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    // A wrap here is a jump of thousands of rows, which is not what an arrow
    // key means anywhere else.
    expect(await screen.findByRole("img", { name: "asset-0.png" })).toBeDefined();
  });

  it("closes when a sidebar row asks to look somewhere else", async () => {
    // Reported 2026-09-08. The pane stayed open over the folder that had just
    // been clicked, drawing an asset that is not in it — and the only way back
    // to the grid was Escape, because the preview's head replaces the grid's.
    const assets = Array.from({ length: 6 }, (_, i) => fakeAsset(i));
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: assets.length },
      assets,
      details: assets.map((_, i) => fakeDetail(i, { name: `asset-${i}.png` })),
      byQuery: { 'folder:"Design"': assets },
      sidebar: {
        ratings: [],
        places: [],
        folders: [
          {
            id: "folder:7",
            name: "Design",
            query: 'folder:"Design"',
            count: 2,
            descendants: 2,
            depth: 0,
            group: null,
            stars: null,
            folder: 7,
            path: "Design",
          },
        ],
        smartFolders: [],
        tags: [],
        types: [],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(6));

    await user.click(screen.getAllByRole("option")[2] as HTMLElement);
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: /Design/ }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The grid's head is back with it, and the field shows where the click went.
    expect(await screen.findByRole("searchbox")).toHaveProperty("value", 'folder:"Design"');
    // And the focus went with the query: a single click in the new result
    // selects, as it always does, rather than re-opening the pane that closed.
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(6));
    await user.click(screen.getAllByRole("option")[1] as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/**
 * The volume the library remembers (ADR-0024 §9).
 *
 * The window is what joins the two halves: the store hands a new element its
 * loudness (`PreviewPane.test.tsx` covers that end) and this writes whatever
 * the element changes back to `settings.json`.
 */
describe("the volume a library remembers", () => {
  const HOLIDAY = "/home/you/Holiday Photos.roost";

  const open = async (mediaVolume: number, mediaMuted: boolean) => {
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      settings: {
        showSubfolderContents: false,
        fitVideoToWindow: false,
        mediaVolume,
        mediaMuted,
        sortKey: "added",
        sortDescending: true,
        shuffleSeed: 0,
        gridView: "icons",
        matchImageProportions: true,
        showFolders: true,
        gridZoom: 240,
        showSidebar: true,
        showInspector: true,
        sidebarWidth: 240,
        inspectorWidth: 280,
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await screen.findByRole("button", { name: "Menu" });
    return engine;
  };

  const writes = (engine: FakeEngine): number =>
    engine.seen.filter((request) => request.type === "settings:write").length;

  afterEach(() => sound.remember({ volume: 100, muted: false }));

  it("hands the library's own loudness to the player, and writes what it changes", async () => {
    const engine = await open(25, true);
    await waitFor(() => expect(sound.current()).toEqual({ volume: 25, muted: true }));
    // Reading it wrote nothing: a seed that announced itself would write the
    // value it had just read, once per library opened.
    expect(writes(engine)).toBe(0);

    sound.changed({ volume: 60, muted: false });
    await waitFor(() =>
      expect(engine.settings).toMatchObject({ mediaVolume: 60, mediaMuted: false }),
    );
  });

  it("writes once at each end of a drag, not once per pixel of it", async () => {
    // A slider drag emits a `volumechange` per pixel. The first is written
    // straight away — so a mute pressed just before the window closes is kept —
    // and the last when the gesture settles; everything between is dropped.
    const engine = await open(100, false);
    for (const volume of [70, 69, 68, 67, 66]) sound.changed({ volume, muted: false });

    await waitFor(() => expect(engine.settings).toMatchObject({ mediaVolume: 70 }));
    expect(writes(engine)).toBe(1);

    await waitFor(() => expect(engine.settings).toMatchObject({ mediaVolume: 66 }), {
      timeout: 2000,
    });
    expect(writes(engine)).toBe(2);
  });

  it("gives the next library its own, and forgets the last one's", async () => {
    const engine = await open(15, false);
    await waitFor(() => expect(sound.current()).toEqual({ volume: 15, muted: false }));

    const user = userEvent.setup();
    await closeLibrary(user);
    // A closed library takes its volume with it: what the picker hands the next
    // player is where a media element starts on its own.
    await waitFor(() => expect(sound.current()).toEqual({ volume: 100, muted: false }));
    expect(engine.settings.mediaVolume).toBe(15);
  });
});

/**
 * The picker's recent list, end to end through the fake bridge.
 *
 * `RecentList.test.tsx` covers the component in isolation; this covers the
 * wiring — that opening records, that closing brings the list back with the
 * library on it, and that a row is a way back in without touching a dialog.
 */
describe("the recent list on the picker", () => {
  const start = (options: ConstructorParameters<typeof FakeEngine>[0] = {}) => {
    const engine = new FakeEngine(options);
    install(engine);
    return { engine, user: userEvent.setup(), ...render(<App />) };
  };

  const HOLIDAY = "/home/you/Holiday Photos.roost";

  it("says nothing on a first run", async () => {
    start();
    await screen.findByRole("button", { name: "Open library…" });
    expect(screen.queryByText("Recent")).toBeNull();
  });

  it("lists a library that was opened, once it is closed again", async () => {
    const { user } = start({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
    });

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await screen.findByRole("button", { name: "Menu" });
    await closeLibrary(user);

    // Back on the picker, with the library it just left at the top — which is
    // the case that matters most, because it is where somebody lands after
    // switching away by accident.
    expect(await screen.findByText("Recent")).toBeDefined();
    expect(screen.getByRole("button", { name: "Open Holiday Photos" })).toBeDefined();
  });

  it("opens from a row, without a dialog", async () => {
    const { user } = start({
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      recent: [
        {
          root: HOLIDAY,
          name: "Holiday Photos",
          id: "abc",
          openedAt: Math.floor(Date.now() / 1000) - 3600,
          pinned: false,
          available: true,
        },
      ],
      stats: { assets: 1234 },
    });

    await user.click(await screen.findByRole("button", { name: "Open Holiday Photos" }));
    expect(await screen.findByRole("button", { name: "Menu" })).toBeDefined();
  });

  it("asks the shell to quit, from the menu that replaced the menu bar", async () => {
    // The window has no menu bar (ADR-0028), so Quit has to come from
    // somewhere. It is a typed request like everything else the renderer can
    // ask for — the reply is never seen, because the process is on its way out.
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await user.click(await screen.findByRole("button", { name: "Menu" }));
    await user.click(await screen.findByRole("menuitem", { name: /Quit/ }));

    expect(engine.seen.some((request) => request.type === "app:quit")).toBe(true);
  });

  it("offers to resume a paused queue from the menu while work is left", async () => {
    // ADR-0049 §3: the ☰ is where somebody goes looking for commands, so the
    // reminder is there as well as in the status bar.
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      deriveStatus: {
        paused: true,
        ready: 1_240,
        running: 0,
        blocked: 0,
        failed: 0,
        reasons: [],
        capabilities: [],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    expect(await screen.findByText("Paused · 1,240 left")).toBeDefined();
    await user.click(await screen.findByRole("button", { name: "Menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Resume deriving (1,240 left)" }));

    expect(engine.seen.some((request) => request.type === "derive:resume")).toBe(true);
  });

  it("asks again when a missing row is clicked, and opens once the drive is back", async () => {
    // The case this exists for: the list was read while the drive was
    // unplugged, so the row is struck through and says "Missing" — and the
    // person's next move is to plug the drive in and click it. The mark is a
    // `stat` from a moment ago, not a fact about the library.
    const { engine, user } = start({
      recent: [
        {
          root: HOLIDAY,
          name: "Holiday Photos",
          id: "abc",
          openedAt: Math.floor(Date.now() / 1000) - 86_400,
          pinned: false,
          available: false,
        },
      ],
      stats: { assets: 1234 },
    });

    const row = await screen.findByRole("button", { name: "Try Holiday Photos again" });
    await user.click(row);

    // Still not there: the reason says so, and the row is re-read rather than
    // left looking as though the click had worked.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("[library_not_found]");
    expect(await screen.findByText("Missing")).toBeDefined();

    engine.attach({ root: HOLIDAY, name: "Holiday Photos" });
    await user.click(screen.getByRole("button", { name: "Try Holiday Photos again" }));

    expect(await screen.findByRole("button", { name: "Menu" })).toBeDefined();
  });

  it("takes a row off the list when it is forgotten", async () => {
    const { user } = start({
      recent: [
        {
          root: HOLIDAY,
          name: "Holiday Photos",
          id: "abc",
          openedAt: Math.floor(Date.now() / 1000),
          pinned: false,
          available: true,
        },
      ],
    });

    await user.click(await screen.findByRole("button", { name: "Forget Holiday Photos" }));
    await waitFor(() => expect(screen.queryByText("Recent")).toBeNull());
  });
});

describe("showing and hiding the side panes", () => {
  const HOLIDAY = "/home/you/Holiday Photos.roost";

  const open = async (settings?: Partial<WireSettings>) => {
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 3 },
      assets: Array.from({ length: 3 }, (_, i) => fakeAsset(i)),
      ...(settings === undefined
        ? {}
        : {
            settings: {
              showSubfolderContents: false,
              fitVideoToWindow: false,
              mediaVolume: 100,
              mediaMuted: false,
              sortKey: "added",
              sortDescending: true,
              shuffleSeed: 0,
              gridView: "icons",
              matchImageProportions: true,
              showFolders: true,
              gridZoom: 240,
              showSidebar: true,
              showInspector: true,
              sidebarWidth: 240,
              inspectorWidth: 280,
              ...settings,
            },
          }),
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await screen.findByRole("button", { name: "Menu" });
    // The grid's first page lands after the preferences do (ADR-0039 §6), so a
    // test that clicks a cell has to wait for one.
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(3));
    return { engine, user };
  };

  const toggle = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) => {
    await user.click(await screen.findByRole("button", { name: "Menu" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name }));
  };

  it("takes the sidebar away and keeps the menu that brings it back", async () => {
    // The reason this pair needed any thought at all: the `☰` is drawn at the
    // head of the sidebar, so a toggle that only hid the column would hide
    // itself (ADR-0028 §6). It moves to the content head instead.
    const { engine, user } = await open();
    expect(screen.getByRole("navigation", { name: "Library" })).toBeDefined();

    await toggle(user, /Show sidebar/);

    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Library" })).toBeNull());
    // Still exactly one, and still reachable: the way back is not a shortcut
    // somebody has to know.
    expect(screen.getAllByRole("button", { name: "Menu" })).toHaveLength(1);
    await waitFor(() => expect(engine.settings.showSidebar).toBe(false));

    await toggle(user, /Show sidebar/);
    expect(await screen.findByRole("navigation", { name: "Library" })).toBeDefined();
    await waitFor(() => expect(engine.settings.showSidebar).toBe(true));
  });

  it("takes the inspector away and stops it asking about the selection", async () => {
    const { engine, user } = await open();
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeDefined();

    await toggle(user, /Show inspector/);

    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull(),
    );
    await waitFor(() => expect(engine.settings.showInspector).toBe(false));

    // Unmounted rather than hidden, so a click in the grid costs no request:
    // a panel nobody can see has no business asking the engine about it. The
    // count while it was open is what makes the second half mean anything.
    const details = () => engine.seen.filter((request) => request.type === "asset:detail").length;
    const before = details();
    await user.click(screen.getAllByRole("option")[1] as HTMLElement);
    await new Promise((settle) => setTimeout(settle, 20));
    expect(details()).toBe(before);
  });

  it("asks for a detail while the inspector is open, which is what the last test denies", async () => {
    // The control for it. Without this the assertion above would pass just as
    // well on a window that never asked for a detail at all.
    const { engine, user } = await open();
    await user.click(screen.getAllByRole("option")[1] as HTMLElement);
    await waitFor(() =>
      expect(engine.seen.some((request) => request.type === "asset:detail")).toBe(true),
    );
  });

  it("opens with the panes the library was left with", async () => {
    // The same rule as the view and the order (ADR-0019): a window that asked
    // again on every open is one that forgot.
    await open({ showSidebar: false, showInspector: false });
    expect(screen.queryByRole("navigation", { name: "Library" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull();
    expect(await screen.findByRole("button", { name: "Menu" })).toBeDefined();
  });

  it("keeps the ☰ on screen with a file open and no sidebar behind it", async () => {
    // Found by the user on 2026-09-13, in a real window: the preview replaces
    // the content head with its own bar, so with the sidebar hidden there was
    // no head left holding the button — and no way back to the sidebar but a
    // key nothing on screen names.
    const { user } = await open({ showSidebar: false });
    await user.click(screen.getAllByRole("option")[1] as HTMLElement);
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");

    const menu = screen.getAllByRole("button", { name: "Menu" });
    expect(menu).toHaveLength(1);
    expect(menu[0]?.closest(".preview-bar")).not.toBeNull();

    // And it does what it is there for, with the file still open.
    await toggle(user, /Show sidebar/);
    expect(await screen.findByRole("navigation", { name: "Library" })).toBeDefined();
    expect(screen.getByRole("dialog")).toBeDefined();
    // One button, back in the sidebar's head rather than drawn in both.
    const moved = screen.getAllByRole("button", { name: "Menu" });
    expect(moved).toHaveLength(1);
    expect(moved[0]?.closest(".bar-sidebar")).not.toBeNull();
  });

  it("answers F9 and F4 with the menu shut", async () => {
    // The accelerators the menu draws are bound on the window, not by it
    // (`UI_SPEC.md` §9) — a label beside an item is not a binding.
    const { engine } = await open();
    fireEvent.keyDown(window, { key: "F9" });
    await waitFor(() => expect(engine.settings.showSidebar).toBe(false));
    fireEvent.keyDown(window, { key: "F4" });
    await waitFor(() => expect(engine.settings.showInspector).toBe(false));
    fireEvent.keyDown(window, { key: "F9" });
    await waitFor(() => expect(engine.settings.showSidebar).toBe(true));
  });
});
