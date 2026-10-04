import type { ImportProgress, SidebarFolderRow } from "@roost/contract";
import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../App.js";
import { droppedFile, FakeEngine, fakeAsset, fakeDetail, install } from "../testing/fake-engine.js";

/**
 * Import, driven through the whole window.
 *
 * The drop is the part worth driving here rather than in isolation: it involves
 * four window-level listeners, a depth counter, and the preload's
 * `pathForFile` — none of which a component test of the overlay alone would
 * exercise together.
 */

const HOLIDAY = "/home/you/Holiday Photos.roost";

/** One progress event, over a run of 500 files and 4 MiB that is past counting. */
function progress(overrides: Partial<ImportProgress> = {}): ImportProgress {
  return {
    scanned: 500,
    imported: 0,
    duplicates: 0,
    failed: 0,
    thumbnails: 0,
    total: 500,
    counting: false,
    bytesDone: 0,
    bytesTotal: 4_194_304,
    ...overrides,
  };
}

/** A folder in the pane, so an import has somewhere to land (ADR-0037). */
const DESIGN: SidebarFolderRow = {
  id: "folder:7",
  name: "Design",
  query: 'folder:"Design"',
  count: 2,
  depth: 0,
  group: null,
  stars: null,
  folder: 7,
  path: "Design",
};

const WITH_DESIGN = {
  sidebar: {
    ratings: [],
    places: [],
    folders: [DESIGN],
    smartFolders: [],
    tags: [],
    types: [],
  },
} as const;

/** A `DataTransfer` happy-dom will carry, since it constructs none of its own. */
function transfer(files: readonly File[]): DataTransfer {
  return {
    types: files.length === 0 ? [] : ["Files"],
    files: files as unknown as FileList,
  } as unknown as DataTransfer;
}

function fire(type: string, files: readonly File[]): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer(files) });
  window.dispatchEvent(event);
}

describe("importing", () => {
  let engine: FakeEngine;

  const open = async (options: ConstructorParameters<typeof FakeEngine>[0] = {}) => {
    engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 1 },
      assets: [fakeAsset(0)],
      ...options,
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await screen.findByRole("heading", { name: "Holiday Photos" });
    return user;
  };

  beforeEach(() => {
    for (const [name, value] of [
      ["clientWidth", 1000],
      ["clientHeight", 800],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
    }
  });

  it("gives a dropped subtitle to the film on screen, and imports the rest", async () => {
    // ADR-0025. The rule is *what is open*, not where the pointer is: Chromium
    // reports no filename during a drag, so a target that lit up only over the
    // video would be an affordance arriving after the decision.
    const film = fakeAsset(0, { name: "holiday.mp4", ext: "mp4", kind: "video" });
    const user = await open({
      assets: [film],
      details: [fakeDetail(0, { ext: "mp4", kind: "video" })],
    });

    // Awaited rather than read: the grid pages once the library has answered
    // with the order it is in (ADR-0039 §7), which is a round trip after the
    // library itself.
    await user.dblClick(await screen.findByRole("option", { name: "holiday.mp4" }));
    await screen.findByRole("dialog");

    // The overlay says what will happen, since it cannot say what is held.
    fire("dragenter", [droppedFile("/films/holiday.srt")]);
    expect(await screen.findByText(/a subtitle joins this video/)).toBeDefined();

    fire("drop", [droppedFile("/films/holiday.srt"), droppedFile("/photos/one.png")]);

    await waitFor(() => {
      const sent = engine.seen.find((request) => request.type === "asset:addSubtitle");
      expect(sent).toMatchObject({ id: film.id });
    });
    // The picture was declined by the engine and went where it was always
    // going: nothing is dropped on the floor.
    await waitFor(() =>
      expect(engine.seen.some((request) => request.type === "import:paths")).toBe(true),
    );
  });

  it("imports a drop when the preview is closed, whatever it holds", async () => {
    const user = await open({ assets: [fakeAsset(0)] });
    fire("drop", [droppedFile("/films/holiday.srt")]);

    await waitFor(() =>
      expect(engine.seen.some((request) => request.type === "import:paths")).toBe(true),
    );
    expect(engine.seen.some((request) => request.type === "asset:addSubtitle")).toBe(false);
    expect(user).toBeDefined();
  });

  it("says the window is a drop target only while something is over it", async () => {
    await open();
    expect(screen.queryByText("Drop to import")).toBeNull();

    fire("dragenter", [droppedFile("/photos/one.png")]);
    expect(await screen.findByText("Drop to import")).toBeDefined();

    fire("dragleave", [droppedFile("/photos/one.png")]);
    await waitFor(() => expect(screen.queryByText("Drop to import")).toBeNull());
  });

  it("does not flicker as the pointer crosses a child element", async () => {
    // `dragleave` fires on every crossing into a child, so a boolean would
    // blink the overlay off and on as the pointer moves across the grid.
    await open();
    const file = droppedFile("/photos/one.png");

    fire("dragenter", [file]);
    fire("dragenter", [file]);
    fire("dragleave", [file]);
    expect(await screen.findByText("Drop to import")).toBeDefined();

    fire("dragleave", [file]);
    await waitFor(() => expect(screen.queryByText("Drop to import")).toBeNull());
  });

  it("ignores a drag that is not carrying files", async () => {
    await open();
    fire("dragenter", []);
    expect(screen.queryByText("Drop to import")).toBeNull();
  });

  it("imports the paths the preload gave for the dropped files", async () => {
    await open();
    fire("drop", [droppedFile("/photos/one.png"), droppedFile("/photos/two.jpg")]);

    await waitFor(() => {
      const imports = engine.seen.filter((request) => request.type === "import:paths");
      expect(imports).toHaveLength(1);
      // The renderer never derives a path; it asks the preload, because a
      // dropped `File` has carried none since Electron 32.
      expect(imports[0]).toMatchObject({
        paths: ["/photos/one.png", "/photos/two.jpg"],
        take: "copy",
      });
    });
    await waitFor(() => expect(screen.queryByText("Drop to import")).toBeNull());
  });

  it("drops something that is not a file on disk without importing it", async () => {
    // A URL or text dragged from another application: `pathForFile` answers
    // with an empty string, and that is not an import.
    await open();
    fire("drop", [new File([], "from-the-web.png")]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.seen.some((request) => request.type === "import:paths")).toBe(false);
  });

  it("shows progress while it runs and the outcome when it stops", async () => {
    // The reply is held open, or there is no "while it runs" to look at: every
    // fake request otherwise resolves in the microtask that started it, and the
    // running line is mounted and unmounted before a render happens.
    let finish = (): void => {};
    const reply = new Promise<void>((resolve) => {
      finish = resolve;
    });

    await open({
      importProgress: [
        progress({ scanned: 500, imported: 98, duplicates: 2, bytesDone: 1_048_576 }),
        progress({ scanned: 500, imported: 396, duplicates: 4, bytesDone: 3_145_728 }),
      ],
      importReport: { scanned: 500, imported: 495, duplicates: 4, copied: 495 },
      hold: { "import:paths": reply },
    });

    fire("drop", [droppedFile("/photos")]);

    // **Done over found**, not the walk's own queue: `scanned` jumps by a batch
    // of five hundred before any of those files is hashed, so a line reading
    // "500 scanned" would say five hundred are finished when none are. The
    // percentage is the bytes', which is what moves during one large file.
    expect(
      await screen.findByText("Importing… 75% · 3.0 MiB of 4.0 MiB · 400 of 500"),
    ).toBeDefined();
    expect(
      screen.getByRole("progressbar", { name: "Importing" }).getAttribute("aria-valuenow"),
    ).toBe("75");

    finish();

    // The outcome, not a toast: an import of five hundred files is a state the
    // window is in, and `duplicates` is the ordinary case rather than a warning.
    expect(await screen.findByText(/495 imported/)).toBeDefined();
    expect(screen.getByText(/4 already here/)).toBeDefined();
    // RL-26: what happened to the files themselves is said out loud, because a
    // move is not undoable by looking at the library afterwards.
    expect(screen.getByText(/495 imported/)).toBeDefined();
  });

  it("says it is counting before anything is read", async () => {
    // ADR-0055 §3.1: the sources are walked once to be counted, so the bar has
    // a total from its first byte. There is no bar yet, and × already works.
    await open({
      importProgress: [
        progress({
          scanned: 1200,
          counting: true,
          total: 1200,
          bytesDone: 0,
          bytesTotal: 5_242_880,
        }),
      ],
      hold: { "import:paths": new Promise<void>(() => {}) },
    });

    fire("drop", [droppedFile("/photos")]);

    expect(await screen.findByText("Counting… 1,200 files · 5.0 MiB")).toBeDefined();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop importing" })).toBeDefined();
  });

  it("stops with ×, and says what arrived", async () => {
    // ADR-0055 §3.3: what has arrived stays, and the run says it was stopped
    // rather than reading like one that finished.
    let finish = (): void => {};
    const reply = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const user = await open({
      importProgress: [progress({ imported: 10 })],
      importReport: { cancelled: true, scanned: 500, imported: 12 },
      hold: { "import:paths": reply },
    });

    fire("drop", [droppedFile("/photos")]);
    await user.click(await screen.findByRole("button", { name: "Stop importing" }));

    expect(engine.seen.filter((request) => request.type === "import:cancel")).toHaveLength(1);
    expect(screen.getByText("Stopping… what has arrived stays")).toBeDefined();
    // Pressed once: a second press would ask the engine to stop what it is
    // already stopping.
    expect(screen.queryByRole("button", { name: "Stop importing" })).toBeNull();

    finish();
    expect(await screen.findByText("Import stopped · 12 imported")).toBeDefined();
  });

  it("offers no × once the files are in and the pictures are being drawn", async () => {
    // Those are the derive queue's, and its own × pauses them (ADR-0049).
    await open({
      importProgress: [progress({ imported: 500, thumbnails: 20 })],
      hold: { "import:paths": new Promise<void>(() => {}) },
    });

    fire("drop", [droppedFile("/photos")]);

    expect(await screen.findByText("Thumbnails… 20 of 500")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Stop importing" })).toBeNull();
  });

  it("re-reads everything derived once the import finishes", async () => {
    await open();
    const before = engine.seen.filter((r) => r.type === "library:sidebar").length;

    fire("drop", [droppedFile("/photos/one.png")]);

    // The counts, the sidebar, the match count, and the grid's pages are all
    // wrong the moment an import lands.
    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "library:sidebar").length).toBeGreaterThan(
        before,
      ),
    );
  });

  it("imports into the folder the window is showing", async () => {
    // ADR-0037: the folder is read when the run starts, and it is the one the
    // grid is drawing — found by matching the query, never written by the
    // renderer.
    const user = await open(WITH_DESIGN);
    await user.click(screen.getByRole("button", { name: /Design/ }));

    fire("drop", [droppedFile("/photos/one.png")]);

    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "import:paths")[0]).toMatchObject({ folder: 7 }),
    );
  });

  it("imports into no folder when none is open", async () => {
    // The library's root is a destination rather than a missing answer, so the
    // request says `null` rather than leaving the field out.
    await open(WITH_DESIGN);
    fire("drop", [droppedFile("/photos/one.png")]);

    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "import:paths")[0]).toMatchObject({
        folder: null,
      }),
    );
  });

  it("asks about the files that were already here, and files them when told to", async () => {
    const user = await open({
      ...WITH_DESIGN,
      importReport: { imported: 1, duplicates: 2, duplicateNames: ["one.png", "two.png"] },
      filed: { filed: 2, expired: false },
    });
    await user.click(screen.getByRole("button", { name: /Design/ }));

    fire("drop", [droppedFile("/photos/one.png")]);

    // After the run, not before it: a duplicate is only discovered by hashing,
    // and for a duplicate the run wrote nothing.
    expect(await screen.findByText("2 files were already in this library")).toBeDefined();
    expect(screen.getByText("one.png")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Add to Design" }));

    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "import:fileDuplicates")[0]).toMatchObject({
        folder: 7,
      }),
    );
    // The ids never crossed: the engine kept the list the run reported.
    expect(await screen.findByText(/Added 2 assets to Design/)).toBeDefined();
  });

  it("writes nothing when the duplicates are ignored", async () => {
    const user = await open({
      ...WITH_DESIGN,
      importReport: { imported: 0, duplicates: 1, duplicateNames: ["one.png"] },
    });
    await user.click(screen.getByRole("button", { name: /Design/ }));
    fire("drop", [droppedFile("/photos/one.png")]);

    await user.click(await screen.findByRole("button", { name: "Ignore all" }));

    await waitFor(() =>
      expect(screen.queryByText("1 file was already in this library")).toBeNull(),
    );
    expect(engine.seen.some((r) => r.type === "import:fileDuplicates")).toBe(false);
  });

  it("still says what was already here when there is no folder to offer", async () => {
    // Worth drawing with one button: a grid that did not grow looks like an
    // import that failed until something says otherwise.
    await open({ importReport: { imported: 0, duplicates: 1, duplicateNames: ["one.png"] } });
    fire("drop", [droppedFile("/photos/one.png")]);

    expect(await screen.findByText("1 file was already in this library")).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Add to / })).toBeNull();
  });

  it("files duplicates from a directory in their own folders, with no folder open (ADR-0058)", async () => {
    // A re-imported tree's duplicates belong in the tree, and the engine knows
    // which folder each one's directory became.
    const user = await open({
      importReport: {
        imported: 1,
        duplicates: 2,
        duplicateNames: ["one.png", "two.png"],
        duplicatesPlaced: true,
        folders: 3,
      },
      filed: { filed: 2, expired: false },
    });
    fire("drop", [droppedFile("/photos/Trip")]);

    expect(await screen.findByText(/3 folders made/)).toBeDefined();
    await user.click(await screen.findByRole("button", { name: "Add to their folders" }));
    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "import:fileDuplicates")[0]).toMatchObject({
        folder: null,
      }),
    );
    expect(await screen.findByText(/Added 2 assets to their folders/)).toBeDefined();
  });

  /** Opens the Add menu and picks one of its items. */
  const add = async (user: ReturnType<typeof userEvent.setup>, item: RegExp): Promise<void> => {
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(await screen.findByRole("menuitem", { name: item }));
  };

  it("imports what the dialog chose", async () => {
    const user = await open({ importDialog: ["/photos/holiday"] });
    await add(user, /Import files…/);

    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "import:paths")[0]).toMatchObject({
        paths: ["/photos/holiday"],
      }),
    );
  });

  /**
   * The two items are two dialogs, not one filtered, which is the whole reason
   * the menu exists — so the request has to carry which was asked for.
   */
  it("asks for a directory chooser when the folder item is picked", async () => {
    const user = await open({ importDialog: ["/photos/holiday"] });
    await add(user, /Import folder…/);

    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "dialog:chooseImport")[0]).toMatchObject({
        what: "folders",
      }),
    );
  });

  it("does nothing when the dialog is cancelled", async () => {
    const user = await open({ importDialog: null });
    await add(user, /Import files…/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.seen.some((r) => r.type === "import:paths")).toBe(false);
  });

  /** The accelerators the menu prints, which have to be real to be printed. */
  it("imports from Ctrl+I, and folders from Ctrl+Shift+I", async () => {
    const user = await open({ importDialog: ["/photos/holiday"] });

    await user.keyboard("{Control>}i{/Control}");
    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "dialog:chooseImport")[0]).toMatchObject({
        what: "files",
      }),
    );

    await user.keyboard("{Control>}{Shift>}I{/Shift}{/Control}");
    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "dialog:chooseImport")[1]).toMatchObject({
        what: "folders",
      }),
    );
  });
});

describe("what the grid does when an import lands", () => {
  beforeEach(() => {
    for (const [name, value] of [
      ["clientWidth", 1000],
      ["clientHeight", 800],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
    }
  });

  it("fills an empty library that was still saying it was empty", async () => {
    // The case that had to be driven through a real window to find: an empty
    // listing that becomes empty again leaves the row count at zero, so an
    // effect watching that count never re-runs — and a freshly imported library
    // went on saying "Nothing in this library yet."
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      assets: [],
      importAdds: Array.from({ length: 4 }, (_, i) => fakeAsset(i)),
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    expect(await screen.findByText("Nothing in this library yet.")).toBeDefined();

    fire("drop", [droppedFile("/photos/one.png")]);

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(4));
    expect(screen.queryByText("Nothing in this library yet.")).toBeNull();
    expect(screen.getByText("4 assets")).toBeDefined();
  });

  it("keeps the grid's pages when an edit leaves the count alone", async () => {
    // The other half of the same rule: a rating or a note must not re-page the
    // grid from row one and throw the scroll position away.
    const engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      assets: Array.from({ length: 4 }, (_, i) => fakeAsset(i)),
      details: [fakeDetail(0)],
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(4));

    const before = engine.seen.filter((r) => r.type === "assets:page").length;
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    await user.click(await screen.findByRole("button", { name: "4 stars" }));

    await waitFor(() => expect(engine.seen.some((r) => r.type === "asset:rate")).toBe(true));
    expect(engine.seen.filter((r) => r.type === "assets:page")).toHaveLength(before);
  });
});

/**
 * A drag out of the grid (ADR-0034 §4), driven through the whole window.
 *
 * It goes out as files, and files are what an import is too, so the whole of
 * what can go wrong is the window mistaking its own drag for one from the
 * desktop: offering to import copies of the selection over the grid, or a
 * folder row refusing it because it carries nothing of Roost's own.
 */
describe("dragging out of the grid", () => {
  let engine: FakeEngine;
  /** Lets the drag end, which main answers only when the hand lets go. */
  let letGo: () => void = () => {};

  const open = async (options: ConstructorParameters<typeof FakeEngine>[0] = {}) => {
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    engine = new FakeEngine({
      openLibraryDialog: HOLIDAY,
      existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
      stats: { assets: 1 },
      assets: [fakeAsset(0)],
      hold: { "asset:dragOut": held },
      ...WITH_DESIGN,
      ...options,
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await screen.findByRole("heading", { name: "Holiday Photos" });
    // The cost is asked for as the library opens, and the drag reads it.
    await waitFor(() =>
      expect(engine.seen.some((request) => request.type === "handoff:cost")).toBe(true),
    );
    return user;
  };

  const startDrag = async (user: ReturnType<typeof userEvent.setup>): Promise<Event> => {
    const cell = await screen.findByRole("option", { name: "asset-0.png" });
    await user.click(cell);
    const dataTransfer = {
      types: [],
      setData: () => {},
      getData: () => "",
      setDragImage: () => {},
      effectAllowed: "none",
    } as unknown as DataTransfer;
    const event = createEvent.dragStart(cell, { dataTransfer });
    fireEvent(cell, event);
    return event;
  };

  const sent = (type: string) => engine.seen.filter((request) => request.type === type);

  it("asks main for a native drag of the selection", async () => {
    const user = await open();
    const event = await startDrag(user);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(sent("asset:dragOut")).toHaveLength(1));
    expect(sent("asset:dragOut")[0]).toMatchObject({ ids: [fakeAsset(0).id] });
    letGo();
  });

  it("does not offer to import its own drag when it is let go over the grid", async () => {
    const user = await open();
    await startDrag(user);
    await waitFor(() => expect(sent("asset:dragOut")).toHaveLength(1));

    const staged = droppedFile(`${HOLIDAY}/staging/asset-0.png`);
    fire("dragenter", [staged]);
    expect(screen.queryByText(/Drop to import/)).toBeNull();
    fire("drop", [staged]);

    letGo();
    await waitFor(() => expect(sent("asset:dragOut")).toHaveLength(1));
    expect(sent("import:paths")).toHaveLength(0);
  });

  it("files its own drag into a folder row, by the ids it asked to drag", async () => {
    const user = await open();
    await startDrag(user);
    await waitFor(() => expect(sent("asset:dragOut")).toHaveLength(1));

    // What a native drag carries back into the window that started it:
    // `Files` and nothing of Roost's own (measured on KDE Wayland).
    const branch = screen.getByRole("button", { name: /^Design/ }).closest(".sidebar-branch");
    if (!(branch instanceof HTMLElement)) throw new Error("no branch for Design");
    const dataTransfer = {
      types: ["Files"],
      files: [droppedFile(`${HOLIDAY}/staging/asset-0.png`)],
      getData: () => "",
      dropEffect: "none",
      effectAllowed: "copy",
    } as unknown as DataTransfer;
    const over = createEvent.dragOver(branch, { dataTransfer });
    fireEvent(branch, over);
    // `copy`, which is all a native drag allows; `move` would be refused.
    // Read off the event: `createEvent` copies the mock into a `DataTransfer`
    // of its own, and that copy is what the handler wrote to.
    expect((over as DragEvent).dataTransfer?.dropEffect).toBe("copy");
    fireEvent(branch, createEvent.drop(branch, { dataTransfer }));

    await waitFor(() => expect(sent("asset:folderAdd")).toHaveLength(1));
    expect(sent("asset:folderAdd")[0]).toMatchObject({ ids: [fakeAsset(0).id], folder: 7 });
    letGo();
  });

  it("keeps a large drag inside the window where every byte is copied, and says why", async () => {
    const user = await open({
      handoffCost: "copies",
      assets: [fakeAsset(0, { size: 900 * 1024 * 1024 })],
    });
    const event = await startDrag(user);

    expect(event.defaultPrevented).toBe(false);
    expect(await screen.findByText(/Dragging within Roost only/)).toBeDefined();
    expect(sent("asset:dragOut")).toHaveLength(0);
  });

  it("lets the same drag out where the library hands out its own files", async () => {
    // ADR-0034 §8: nothing is copied, so there is no size to wait for. Read
    // from the settings rather than sent: main asks the engine itself.
    const engine = new FakeEngine();
    const user = await open({
      handoffCost: "copies",
      assets: [fakeAsset(0, { size: 900 * 1024 * 1024 })],
      settings: { ...engine.settings, handOutByName: false },
    });
    const event = await startDrag(user);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(sent("asset:dragOut")).toHaveLength(1));
    expect(screen.queryByText(/Dragging within Roost only/)).toBeNull();
    letGo();
  });
});
