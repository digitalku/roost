import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playhead } from "../preview/playhead.js";
import { FakeEngine, fakeAsset, install } from "../testing/fake-engine.js";
import { AssetContextMenu, exportLine } from "./AssetContextMenu.js";
import type { ConfirmRequest } from "./trash-actions.js";

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
  let notes: string[];
  let problems: string[];
  let confirmations: ConfirmRequest[];
  let gone: number;
  let opened: string[];

  const show = (
    hashes: readonly string[] = HASHES,
    options = {},
    { inTrash = false, drawable }: { inTrash?: boolean; drawable?: boolean } = {},
  ) => {
    engine = new FakeEngine(options);
    install(engine);
    notes = [];
    problems = [];
    confirmations = [];
    gone = 0;
    opened = [];
    const view = render(
      <AssetContextMenu
        hashes={hashes}
        inTrash={inTrash}
        onNote={(line) => notes.push(line)}
        onProblem={(problem) => problems.push(problem.message)}
        onConfirm={(request) => confirmations.push(request)}
        onGone={() => {
          gone += 1;
        }}
        onOpenHere={(hash) => opened.push(hash)}
        {...(drawable === undefined ? {} : { drawable })}
      >
        <div data-testid="surface" tabIndex={-1}>
          the grid
        </div>
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
    expect(notes[0]).toBe("Exported 3");
    // An export takes nothing out of the view, so the selection stays. This is
    // the half that makes `onGone` a different callback from `onNote`.
    expect(gone).toBe(0);
  });

  it("exports nothing when the dialog is cancelled", async () => {
    // Cancelling is an outcome, not a failure: nothing is sent and nothing is
    // reported, so the status bar keeps saying whatever it said.
    const { user } = show(HASHES, { chooseLocationDialog: null });
    await open();
    await user.click(screen.getByRole("menuitem", { name: /Export 3 assets/ }));

    await waitFor(() => expect(sentTo("dialog:chooseLocation")).toHaveLength(1));
    expect(sentTo("assets:export")).toHaveLength(0);
    expect(notes).toHaveLength(0);
    expect(problems).toHaveLength(0);
  });

  it("puts what a double-click does at the top, and offers the other way below", async () => {
    // The menu and the gesture must agree (`UI_SPEC.md` §3.3): a first row that
    // is not what a double-click does teaches the wrong thing.
    const labels = (): string[] =>
      screen
        .getAllByRole("menuitem")
        .slice(0, 2)
        .map((item) => item.textContent ?? "");

    show([HASHES[0] as string], {}, { drawable: true });
    await open();
    expect(labels()).toEqual(["Open", "Open externally"]);
    expect(disabled("Open")).toBe(false);

    cleanup();
    show([HASHES[0] as string], {}, { drawable: false });
    await open();
    expect(labels()).toEqual(["Open externally", "Open"]);
    // Nothing to open here, so the row says so rather than opening a pane whose
    // only offer is the row above it.
    expect(disabled("Open")).toBe(true);
  });

  it("opens in Roost rather than in the desktop when asked here", async () => {
    const { user } = show([HASHES[0] as string], {}, { drawable: true });
    await open();
    await user.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(opened).toEqual([HASHES[0]]);
    expect(sentTo("asset:openExternally")).toHaveLength(0);
  });

  it("refuses to open three assets at once", async () => {
    // Handing three files to the desktop's default handler is three
    // applications opening, which nobody meant by "open".
    show();
    await open();
    expect(disabled("Open externally")).toBe(true);
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

  it("moves the whole selection to the trash, and asks nothing first", async () => {
    // Trashing is reversible (ADR-0022), so a confirmation would be a dialog
    // that teaches people to dismiss dialogs. The count is what is asserted,
    // because the version that sent one hash would pass a test that only
    // checked a request happened.
    const { user } = show();
    await open();
    await user.click(screen.getByRole("menuitem", { name: /Move 3 assets to trash/ }));

    await waitFor(() => expect(sentTo("assets:trash")).toHaveLength(1));
    expect(sentTo("assets:trash")[0]?.hashes).toEqual(HASHES);
    expect(confirmations).toHaveLength(0);
    expect(notes[0]).toBe("Moved 3 assets to the trash");
    // The selection named assets that are no longer on screen, so it has to go
    // with them — otherwise the inspector goes on editing a trashed asset.
    // Found by driving a real window, which is also the only place it shows.
    expect(gone).toBe(1);
  });

  it("offers restoring and permanent deletion only inside the trash", async () => {
    show();
    await open();
    expect(screen.queryByRole("menuitem", { name: "Restore 3 assets" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete permanently" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Empty trash" })).toBeNull();
  });

  it("swaps trashing for restoring once the Trash place is on screen", async () => {
    const { user } = show(HASHES, {}, { inTrash: true });
    await open();
    // The reversible spelling is gone: the two are never offered together, or
    // "delete" would mean two things in one menu.
    expect(screen.queryByRole("menuitem", { name: /Move 3 assets to trash/ })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Restore 3 assets" }));

    await waitFor(() => expect(sentTo("assets:restore")).toHaveLength(1));
    expect(sentTo("assets:restore")[0]?.hashes).toEqual(HASHES);
    await waitFor(() => expect(gone).toBe(1));
  });

  it("confirms before removing anything permanently, and sends nothing until it is", async () => {
    const { user } = show(HASHES, {}, { inTrash: true });
    await open();
    await user.click(screen.getByRole("menuitem", { name: "Delete permanently" }));

    await waitFor(() => expect(confirmations).toHaveLength(1));
    // Nothing has been sent yet. The dialog is the gate, not a notification
    // shown beside a request that already went.
    expect(sentTo("assets:remove")).toHaveLength(0);
    expect(confirmations[0]?.confirmLabel).toBe("Delete");

    confirmations[0]?.run();
    await waitFor(() => expect(sentTo("assets:remove")).toHaveLength(1));
    expect(sentTo("assets:remove")[0]?.hashes).toEqual(HASHES);
  });

  it("confirms before emptying the trash, and reports what the engine removed", async () => {
    // The count comes back from the engine: emptying is over what the trash
    // holds, which is not the selection the renderer sent.
    const { user } = show(
      HASHES,
      { trashSize: 12, freedBytes: 3 * 1024 * 1024 },
      { inTrash: true },
    );
    await open();
    await user.click(screen.getByRole("menuitem", { name: "Empty trash" }));

    await waitFor(() => expect(confirmations).toHaveLength(1));
    expect(sentTo("assets:emptyTrash")).toHaveLength(0);

    confirmations[0]?.run();
    await waitFor(() => expect(notes).toHaveLength(1));
    // The freed bytes are the half a person empties the trash for (ADR-0031).
    expect(notes[0]).toBe("Deleted 12 assets, freeing 3.0 MiB");
  });

  /*
   * There is no test here for focus returning to what the menu was opened over,
   * and that is deliberate. The fix is `onCloseAutoFocus` in the component:
   * Radix hands focus back to the trigger, which is a wrapper with no
   * `tabindex`, so in a real browser `.focus()` on it does nothing and focus
   * lands on the body — with the grid's roving ring and the preview's stepping
   * both dead until something is clicked. happy-dom does not model focusability
   * at all, so a test written for it passed with the fix **and** with the fix
   * removed. A test that cannot fail is worse than no test (`TODO.md` §4,
   * lesson 9), so this is a real-window claim and is listed as one.
   */

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

describe("choosing which frame a video's thumbnail comes from", () => {
  let engine: FakeEngine;
  let notes: string[];
  let detach: (() => void) | undefined;

  const show = (hashes: readonly string[] = [HASHES[0] as string]) => {
    engine = new FakeEngine({});
    install(engine);
    notes = [];
    render(
      <AssetContextMenu
        hashes={hashes}
        inTrash={false}
        onNote={(line) => notes.push(line)}
        onProblem={() => undefined}
        onConfirm={() => undefined}
        onGone={() => undefined}
      >
        <div data-testid="surface" tabIndex={-1}>
          the preview
        </div>
      </AssetContextMenu>,
    );
    return userEvent.setup();
  };

  const open = async (): Promise<void> => {
    screen
      .getByTestId("surface")
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");
  };

  /** A `<video>` on screen, standing in for an open preview. */
  const playing = (at: number): HTMLVideoElement => {
    const video = document.createElement("video");
    video.currentTime = at;
    // happy-dom's video element has no `requestVideoFrameCallback`, and the
    // menu decides "has frames" by asking for exactly that — so the feature
    // test has to be given something to find.
    Object.defineProperty(video, "requestVideoFrameCallback", {
      value: () => 0,
      configurable: true,
    });
    detach = playhead.attach(video);
    return video;
  };

  afterEach(() => {
    detach?.();
    detach = undefined;
  });

  it("is not offered when there is no player on screen", async () => {
    // Over the grid the menu is about files, and a right-click there has no
    // frame to point at.
    show();
    await open();
    expect(screen.queryByRole("menuitem", { name: "Set this frame as the thumbnail" })).toBeNull();
  });

  it("is not offered over audio, which has no frames", async () => {
    const audio = document.createElement("audio");
    detach = playhead.attach(audio);
    show();
    await open();
    expect(screen.queryByRole("menuitem", { name: "Set this frame as the thumbnail" })).toBeNull();
  });

  it("sends the moment the player is at", async () => {
    playing(91.5);
    const user = show();
    await open();

    await user.click(screen.getByRole("menuitem", { name: "Set this frame as the thumbnail" }));

    await waitFor(() =>
      expect(engine.seen.filter((request) => request.type === "asset:poster")).toEqual([
        { type: "asset:poster", hash: HASHES[0], atMs: 91_500 },
      ]),
    );
    // The cell changes when the derive lands, so the status bar is what says
    // the gesture worked.
    expect(notes).toEqual(["Thumbnail set to the frame at 1:31.5"]);
  });

  it("goes back to the default frame with an absent moment", async () => {
    playing(91.5);
    const user = show();
    await open();

    await user.click(screen.getByRole("menuitem", { name: "Use the default frame" }));

    await waitFor(() =>
      expect(engine.seen.filter((request) => request.type === "asset:poster")).toEqual([
        { type: "asset:poster", hash: HASHES[0], atMs: null },
      ]),
    );
    expect(notes).toEqual(["Thumbnail back to the default frame"]);
  });

  it("is not offered over several assets, because one frame is one asset's", async () => {
    playing(91.5);
    show(HASHES);
    await open();
    expect(screen.queryByRole("menuitem", { name: "Set this frame as the thumbnail" })).toBeNull();
  });
});

describe("the menu over the grid's empty space", () => {
  let pasted: number;
  let asked: number;

  const show = (hashes: readonly string[]) => {
    install(new FakeEngine({}));
    pasted = 0;
    asked = 0;
    render(
      <AssetContextMenu
        hashes={hashes}
        inTrash={false}
        onNote={() => {}}
        onProblem={() => {}}
        onConfirm={() => {}}
        onGone={() => {}}
        onPaste={() => {
          pasted += 1;
        }}
        onNewFile={() => {
          asked += 1;
        }}
      >
        <div data-testid="surface" tabIndex={-1}>
          the grid
        </div>
      </AssetContextMenu>,
    );
    return userEvent.setup();
  };

  const open = async (): Promise<void> => {
    screen
      .getByText("the grid")
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");
  };

  it("offers the two ways to make an asset, and none of the ways to act on one", async () => {
    // An empty selection *is* the empty space: right-clicking a cell selects it
    // first, so a menu with nothing to act on can only have been opened over
    // the background.
    show([]);
    await open();

    expect(screen.getByRole("menuitem", { name: "Paste" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "New file…" })).toBeDefined();
    // Nothing that acts on a selection, because there is none to act on.
    expect(screen.queryByRole("menuitem", { name: "Open externally" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Copy/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /trash/ })).toBeNull();
  });

  it("asks for the file rather than naming one itself", async () => {
    // A file called `untitled` is a file somebody has to rename, so the menu
    // opens a dialog that asks for the name instead of inventing one.
    const user = show([]);
    await open();
    await user.click(screen.getByRole("menuitem", { name: "New file…" }));
    expect(asked).toBe(1);
  });

  it("asks for a paste rather than reading the clipboard itself", async () => {
    // The renderer has no ambient authority (invariant 11): the clipboard is
    // read in main, and this is a request for that to happen.
    const user = show([]);
    await open();
    await user.click(screen.getByRole("menuitem", { name: "Paste" }));
    expect(pasted).toBe(1);
  });

  it("stays out of the way where there is an asset under the pointer", async () => {
    const user = show(HASHES);
    await open();
    expect(screen.queryByRole("menuitem", { name: "Paste" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Copy 3 paths/ })).toBeDefined();
    void user;
  });
});
