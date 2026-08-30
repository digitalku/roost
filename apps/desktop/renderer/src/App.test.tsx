import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { FakeEngine, fakeAsset, fakeDetail, install } from "./testing/fake-engine.js";

/**
 * The picker and the creator, driven the way a person drives them.
 *
 * The native dialogs are answered by the fake bridge rather than by GTK: a
 * folder chooser cannot be clicked by a script, and the code that opens one is
 * twenty lines in main. What this covers is everything after the dialog
 * returns, which is where the flow actually lives.
 */

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
      // The grid's first page and the navigation pane, both as soon as there
      // is a library: a grid with no rows has nothing to scroll, so nothing
      // else would ask for a page.
      "assets:page",
      // The derive queue, as soon as there is a library: an empty cell has to
      // be able to say whether it is waiting, parked, or simply undrawable.
      "derive:status",
      "library:sidebar",
      // The status bar's match count, asked once per query rather than once
      // per scroll.
      "assets:count",
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
    const { user } = start({ openLibraryDialog: "/home/you/Documents" });

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

  it("closes back to the picker", async () => {
    const engine = new FakeEngine({
      openLibraryDialog: "/home/you/Holiday Photos.roost",
      existing: [{ root: "/home/you/Holiday Photos.roost", name: "Holiday Photos" }],
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await user.click(await screen.findByRole("button", { name: "Close library" }));

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
    const hashes = screen.getAllByRole("option").map((cell) => cell.getAttribute("data-hash"));
    expect(new Set(hashes).size).toBe(12);
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
      expect((sent[0] as { hashes: readonly string[] }).hashes).toEqual([
        cells[2]?.getAttribute("data-hash"),
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

  it("says so when a library holds nothing, rather than showing an empty grid", async () => {
    await open(0);
    expect(await screen.findByText("Nothing in this library yet.")).toBeDefined();
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("the navigation pane, in the window", () => {
  const HOLIDAY = "/home/you/Holiday Photos.roost";

  beforeEach(() => {
    for (const [name, value] of [
      ["clientWidth", 1000],
      ["clientHeight", 800],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
    }
  });

  it("sends a row's own query to the grid, and shows what came back", async () => {
    // `UI_SPEC.md` §4.1 and §4.2: the row carries the RQL, clicking it replaces
    // the query, and there is no filter state the query string does not know
    // about. The fake engine refuses a query it was not taught, so this passes
    // only if the exact string the row carried is the one that was sent.
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 9 },
      assets: Array.from({ length: 9 }, (_, i) => fakeAsset(i)),
      byQuery: { 'tag:"brand assets"': [fakeAsset(100), fakeAsset(101)] },
      sidebar: {
        places: [{ id: "all", name: "All assets", query: "", count: null, depth: 0, group: null }],
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
          },
        ],
      },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(9));

    await user.click(await screen.findByRole("button", { name: "brand assets 2" }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(2));

    const pages = engine.seen.filter((request) => request.type === "assets:page");
    expect(pages.at(-1)).toMatchObject({ query: 'tag:"brand assets"' });
    expect(
      screen.getByRole("button", { name: "brand assets 2" }).getAttribute("aria-current"),
    ).toBe("true");
  });

  it("says nothing matched, rather than showing an empty library", async () => {
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 9 },
      assets: Array.from({ length: 9 }, (_, i) => fakeAsset(i)),
      byQuery: { "is:favorite": [] },
      sidebar: {
        places: [
          { id: "all", name: "All assets", query: "", count: null, depth: 0, group: null },
          {
            id: "favorites",
            name: "Favorites",
            query: "is:favorite",
            count: null,
            depth: 0,
            group: null,
          },
        ],
        folders: [],
        smartFolders: [],
        tags: [],
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
        places: [
          { id: "all", name: "All assets", query: "", count: null, depth: 0, group: null },
          {
            id: "favorites",
            name: "Favorites",
            query: "is:favorite",
            count: null,
            depth: 0,
            group: null,
          },
        ],
        folders: [],
        smartFolders: [],
        tags: [],
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

  it("opens on a double-click", async () => {
    const { user } = await open();
    await user.dblClick(screen.getAllByRole("option")[1] as HTMLElement);
    expect(await screen.findByRole("dialog")).toBeDefined();
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
      fakeAsset(2).hash,
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
    install(new FakeEngine(options));
    return { user: userEvent.setup(), ...render(<App />) };
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
    await screen.findByRole("button", { name: "Close library" });
    await user.click(screen.getByRole("button", { name: "Close library" }));

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
    expect(await screen.findByRole("button", { name: "Close library" })).toBeDefined();
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
