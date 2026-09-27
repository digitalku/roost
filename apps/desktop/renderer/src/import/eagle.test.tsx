import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../App.js";
import { FakeEngine, fakeAsset, install } from "../testing/fake-engine.js";

/**
 * **Import from Eagle…**, driven through the whole window (ADR-0032).
 *
 * Through the window rather than against the dialog alone, because the part
 * worth testing is the sequence: a menu item, a chooser, a survey fetched from
 * a path, and only then a request that writes. Each of those is somewhere the
 * flow can stop, and three of them must write nothing when it does.
 */

const HOLIDAY = "/home/you/Holiday Photos.roost";
const EAGLE = "/home/you/Sample.library";

describe("importing an Eagle library", () => {
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

    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(await screen.findByRole("menuitem", { name: /Import from Eagle…/ }));
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

  it("surveys the library the chooser returned, and writes nothing yet", async () => {
    await open({ eagleDialog: EAGLE, eagleSurvey: { items: 14 } });

    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "eagle:survey")[0]).toMatchObject({
        path: EAGLE,
      }),
    );
    expect(engine.seen.some((r) => r.type === "eagle:import")).toBe(false);
  });

  it("says what the library holds, and what will not come across", async () => {
    await open({
      eagleDialog: EAGLE,
      eagleSurvey: { items: 14, bytes: 1024, folders: 2, tags: 4, comments: 6, subtitles: 1 },
    });

    await screen.findByText(/Eagle 4\.0\.0 · 14 items · 1\.0 KiB/);
    await screen.findByText(/4 tags · 2 folders · 6 comments · 1 subtitle/);
    // The loss that cannot be recovered once the Eagle library is gone, said at
    // the only moment it is certainly still there (ADR-0032 §7).
    await screen.findByText(/date added/);
  });

  /** A count of zero is a sentence about something the user does not use. */
  it("leaves out what the library does not have", async () => {
    await open({ eagleDialog: EAGLE, eagleSurvey: { items: 3, tags: 1 } });

    await screen.findByText(/Eagle 4\.0\.0 · 3 items/);
    expect(screen.queryByText(/0 comments/)).toBeNull();
    // Loosely written this matches "smart folders" in what is not carried
    // across, which is a different sentence about a different thing.
    expect(screen.queryByText(/\d+ folders?/)).toBeNull();
  });

  it("names the folders it will rename before anything is written", async () => {
    await open({
      eagleDialog: EAGLE,
      eagleSurvey: { items: 2, renamedFolders: [{ from: "Design/Icons", to: "Design-Icons" }] },
    });

    await screen.findByText(/Design\/Icons → Design-Icons/);
  });

  it("says how many items it will skip", async () => {
    await open({ eagleDialog: EAGLE, eagleSurvey: { items: 9, missing: 2, unreadable: 1 } });

    await screen.findByText(
      /2 items have no file · 1 item cannot be read\. They will be skipped\./,
    );
  });

  it("imports what the dialog was shown, once confirmed", async () => {
    const user = await open({
      eagleDialog: EAGLE,
      eagleSurvey: { items: 14 },
      eagleReport: { items: 14, assets: 14, imported: 15, folders: 2, comments: 6 },
    });

    await user.click(await screen.findByRole("button", { name: "Import" }));

    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "eagle:import")[0]).toMatchObject({
        path: EAGLE,
        // Managed, and not by accident: referenced would leave every asset
        // pointing into the Eagle library (ADR-0032 §5).
        take: "copy",
      }),
    );
    await screen.findByText(/14 from Eagle · 2 folders · 6 comments/);
  });

  /**
   * The one import that can count against a real total, because the survey
   * counted the items before the run began (ADR-0032).
   */
  it("counts up against the total the survey found", async () => {
    let finish = (): void => {};
    const reply = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const user = await open({
      eagleDialog: EAGLE,
      eagleSurvey: { items: 14 },
      importProgress: [
        {
          scanned: 3,
          imported: 3,
          duplicates: 0,
          failed: 0,
          thumbnails: 0,
          total: 14,
          counting: false,
          bytesDone: 0,
          bytesTotal: 0,
        },
      ],
      eagleReport: { items: 14, assets: 14 },
      hold: { "eagle:import": reply },
    });

    await user.click(await screen.findByRole("button", { name: "Import" }));
    // Items against the survey, and the percentage from them where Eagle gave
    // no sizes to count against.
    expect(await screen.findByText("Importing… 21% · 3 of 14")).toBeDefined();

    finish();
    await screen.findByText(/14 from Eagle/);
  });

  it("writes nothing when the dialog is cancelled", async () => {
    const user = await open({ eagleDialog: EAGLE, eagleSurvey: { items: 14 } });

    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.seen.some((r) => r.type === "eagle:import")).toBe(false);
  });

  it("does not survey at all when the chooser is cancelled", async () => {
    await open({ eagleDialog: null });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.seen.some((r) => r.type === "eagle:survey")).toBe(false);
  });

  /**
   * The failure this dialog is really for. Disabled rather than absent: a
   * button that vanishes leaves the dialog looking like it is still loading.
   */
  it("refuses to import a directory that is not an Eagle library", async () => {
    await open({ eagleDialog: "/home/you/Pictures", eagleSurvey: { items: 0 } });

    // `disabled` as a property rather than through jest-dom, which this
    // workspace does not install.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
  });
});
