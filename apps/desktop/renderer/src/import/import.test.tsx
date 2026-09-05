import { render, screen, waitFor } from "@testing-library/react";
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

    await user.dblClick(screen.getAllByRole("option")[0] as HTMLElement);
    await screen.findByRole("dialog");

    // The overlay says what will happen, since it cannot say what is held.
    fire("dragenter", [droppedFile("/films/holiday.srt")]);
    expect(await screen.findByText(/a subtitle joins this video/)).toBeDefined();

    fire("drop", [droppedFile("/films/holiday.srt"), droppedFile("/photos/one.png")]);

    await waitFor(() => {
      const sent = engine.seen.find((request) => request.type === "asset:addSubtitle");
      expect(sent).toMatchObject({ hash: film.hash });
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
        mode: "managed",
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
    await open({
      importProgress: [
        { scanned: 100, imported: 98, duplicates: 2, failed: 0, thumbnails: 0 },
        { scanned: 400, imported: 396, duplicates: 4, failed: 0, thumbnails: 0 },
      ],
      importReport: { scanned: 500, imported: 495, duplicates: 4, partialCollisions: 1 },
    });

    fire("drop", [droppedFile("/photos")]);

    // The outcome, not a toast: an import of five hundred files is a state the
    // window is in, and `duplicates` is the ordinary case rather than a warning.
    expect(await screen.findByText(/495 imported/)).toBeDefined();
    expect(screen.getByText(/4 already here/)).toBeDefined();
    expect(screen.getByText(/1 failed/)).toBeDefined();
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

  it("imports what the dialog chose", async () => {
    const user = await open({ importDialog: ["/photos/holiday"] });
    await user.click(screen.getByRole("button", { name: "Import…" }));

    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "import:paths")[0]).toMatchObject({
        paths: ["/photos/holiday"],
      }),
    );
  });

  it("does nothing when the dialog is cancelled", async () => {
    const user = await open({ importDialog: null });
    await user.click(screen.getByRole("button", { name: "Import…" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.seen.some((r) => r.type === "import:paths")).toBe(false);
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
