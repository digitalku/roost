import type { WireExportReport } from "@roost/contract";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEngine, fakeAsset, install } from "../testing/fake-engine.js";
import { AssetContextMenu, exportLine } from "./AssetContextMenu.js";

/**
 * The menu, driven the way a person drives it.
 *
 * What every test here is really checking is the thing that was a real bug on
 * 2026-08-30: an action must reach the whole selection, not one asset of it. So
 * the assertions count the hashes that were **sent**, never whether a request
 * of the right type happened — the broken version would pass that.
 */

const HASHES = [0, 1, 2].map((index) => fakeAsset(index).hash);

describe("the asset context menu", () => {
  let engine: FakeEngine;
  let exported: WireExportReport[];
  let problems: string[];

  const show = (hashes: readonly string[] = HASHES, options = {}) => {
    engine = new FakeEngine(options);
    install(engine);
    exported = [];
    problems = [];
    const view = render(
      <AssetContextMenu
        hashes={hashes}
        onExported={(report) => exported.push(report)}
        onProblem={(problem) => problems.push(problem.message)}
      >
        <div>the grid</div>
      </AssetContextMenu>,
    );
    return { user: userEvent.setup(), ...view };
  };

  /** Right-clicks the trigger and waits for the menu. */
  const open = async (): Promise<void> => {
    // Dispatched rather than driven through `userEvent`: Radix opens on a
    // `contextmenu` event, and happy-dom does not synthesise one from a right
    // click the way a browser does.
    const area = screen.getByText("the grid");
    area.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");
  };

  const disabled = (name: string): boolean =>
    screen.getByRole("menuitem", { name }).getAttribute("aria-disabled") === "true";

  const sentTo = (type: string): { hashes?: readonly string[]; hash?: string }[] =>
    engine.seen.filter((request) => request.type === type) as never;

  beforeEach(() => {
    vi.useRealTimers();
  });

  it("opens on a right-click", async () => {
    show();
    await open();
    expect(screen.getByRole("menuitem", { name: /Copy 3 paths/ })).toBeDefined();
  });

  it("copies every selected path, not the first one", async () => {
    const { user } = show();
    await open();
    await user.click(screen.getByRole("menuitem", { name: /Copy 3 paths/ }));

    await waitFor(() => expect(sentTo("asset:copyPath")).toHaveLength(1));
    expect(sentTo("asset:copyPath")[0]?.hashes).toEqual(HASHES);
  });

  it("names the count, so a menu over twelve does not read like a menu over one", async () => {
    show([HASHES[0] as string]);
    await open();
    expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Export…" })).toBeDefined();
  });

  it("asks where to export, then exports the selection there", async () => {
    const { user } = show(HASHES, { chooseLocationDialog: "/home/someone/Desktop" });
    await open();
    await user.click(screen.getByRole("menuitem", { name: /Export 3 assets/ }));

    await waitFor(() => expect(sentTo("assets:export")).toHaveLength(1));
    const request = sentTo("assets:export")[0] as { hashes: string[]; destination: string };
    expect(request.hashes).toEqual(HASHES);
    expect(request.destination).toBe("/home/someone/Desktop");
    expect(exported[0]?.exported).toBe(3);
  });

  it("exports nothing when the dialog is cancelled", async () => {
    // Cancelling is an outcome, not a failure: nothing is sent and nothing is
    // reported, so the status bar keeps saying whatever it said.
    const { user } = show(HASHES, { chooseLocationDialog: null });
    await open();
    await user.click(screen.getByRole("menuitem", { name: /Export 3 assets/ }));

    await waitFor(() => expect(sentTo("dialog:chooseLocation")).toHaveLength(1));
    expect(sentTo("assets:export")).toHaveLength(0);
    expect(exported).toHaveLength(0);
    expect(problems).toHaveLength(0);
  });

  it("refuses to open three assets at once", async () => {
    // Handing three files to the desktop's default handler is three
    // applications opening, which nobody meant by "open".
    show();
    await open();
    expect(disabled("Open")).toBe(true);
    expect(disabled("Show in file manager")).toBe(true);
    expect(disabled("Copy 3 paths")).toBe(false);
  });

  it("reveals the one asset it was opened over", async () => {
    const { user } = show([HASHES[0] as string]);
    await open();
    await user.click(screen.getByRole("menuitem", { name: "Show in file manager" }));

    await waitFor(() => expect(sentTo("asset:reveal")).toHaveLength(1));
    expect(sentTo("asset:reveal")[0]?.hash).toBe(HASHES[0]);
  });

  it("shows Move to trash, disabled, because trash is not decided yet", async () => {
    // ADR-0022. Present and disabled says the feature is coming; absent teaches
    // nothing — the same reasoning ADR-0018 used for Sort By.
    show();
    await open();
    expect(disabled("Move to trash Del")).toBe(true);
  });

  it("does not open at all over an empty selection", async () => {
    show([]);
    screen
      .getByText("the grid")
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("what the status bar says after an export", () => {
  it("says only what happened", () => {
    expect(exportLine({ exported: 3, renamed: 0, missing: 0, failed: 0 })).toBe("Exported 3");
  });

  it("says a rename happened, because the file is not called what they expect", () => {
    expect(exportLine({ exported: 3, renamed: 2, missing: 1, failed: 1 })).toBe(
      "Exported 3 · 2 renamed to avoid a collision · 1 not on this machine · 1 failed",
    );
  });
});
