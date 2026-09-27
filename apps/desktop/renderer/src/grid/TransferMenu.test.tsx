import type { WireRecentLibrary } from "@roost/contract";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { FakeEngine, fakeAsset, install } from "../testing/fake-engine.js";
import { AssetContextMenu } from "./AssetContextMenu.js";
import { destinations, transferLine } from "./TransferMenu.js";

/**
 * Moving and copying into another library from the grid's menu (ADR-0054).
 *
 * As in the rest of the menu's tests, what is asserted is what was **sent** —
 * the ids, the library and which of the two gestures — because a menu that sent
 * the right request type with the wrong library is the failure worth catching.
 */

const HERE = "/home/me/Current.roost";
const PHOTOS = "/home/me/Photos.roost";
const ARCHIVE = "/media/drive/Archive.roost";
const GONE = "/media/unplugged/Old.roost";
const IDS = [0, 1].map((index) => fakeAsset(index).id);

function recent(root: string, name: string, pinned = false): WireRecentLibrary {
  return { root, name, id: name, openedAt: 1_700_000_000, pinned, available: true };
}

const LIST = [
  recent(HERE, "Current"),
  recent(PHOTOS, "Photos"),
  recent(ARCHIVE, "Archive", true),
  recent(GONE, "Old"),
];

describe("moving and copying into another library", () => {
  let picked: { ids: readonly string[]; target: string; take: string }[];

  afterEach(cleanup);

  const show = ({
    libraryRoot = HERE,
    busy = false,
    recentList = LIST,
  }: {
    libraryRoot?: string | null;
    busy?: boolean;
    recentList?: WireRecentLibrary[];
  } = {}) => {
    install(
      new FakeEngine({
        assets: [fakeAsset(0), fakeAsset(1)],
        // The unplugged drive is in the list and not on this fake's disk.
        existing: [
          { root: HERE, name: "Current" },
          { root: PHOTOS, name: "Photos" },
          { root: ARCHIVE, name: "Archive" },
        ],
        recent: recentList,
      }),
    );
    picked = [];
    render(
      <AssetContextMenu
        ids={IDS}
        inTrash={false}
        onNote={() => {}}
        onProblem={() => {}}
        onConfirm={() => {}}
        onGone={() => {}}
        {...(libraryRoot === null ? {} : { libraryRoot })}
        onTransfer={(ids, target, take) => picked.push({ ids, target: target.root, take })}
        transferring={busy}
      >
        <div tabIndex={-1}>the grid</div>
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

  /** Opens one of the two submenus and waits for the list to arrive. */
  const submenu = async (
    user: ReturnType<typeof userEvent.setup>,
    label: string,
  ): Promise<string[]> => {
    await user.click(screen.getByRole("menuitem", { name: label }));
    const menus = await screen.findAllByRole("menu");
    const sub = menus[menus.length - 1] as HTMLElement;
    await waitFor(() => expect(sub.textContent).not.toContain("Reading"));
    return [...sub.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? "");
  };

  /**
   * Clicks a library in the open submenu.
   *
   * A click event rather than `user.click`: moving the pointer there leaves the
   * trigger, and with no layout to measure a grace area in, Radix closes the
   * submenu before the click lands.
   */
  const choose = (name: string): void => {
    fireEvent.click(screen.getByRole("menuitem", { name }));
  };

  it("offers the recent libraries that are there, pinned first, and never this one", async () => {
    const user = show();
    await open();

    expect(await submenu(user, "Move to library")).toEqual(["Archive", "Photos"]);
  });

  it("moves the whole selection to the library chosen", async () => {
    const user = show();
    await open();
    await submenu(user, "Move to library");
    choose("Photos");

    expect(picked).toEqual([{ ids: IDS, target: PHOTOS, take: "move" }]);
  });

  it("copies to the library chosen", async () => {
    const user = show();
    await open();
    await submenu(user, "Copy to library");
    choose("Archive");

    expect(picked).toEqual([{ ids: IDS, target: ARCHIVE, take: "copy" }]);
  });

  it("says where the list comes from when there is nothing to offer", async () => {
    const user = show({ recentList: [recent(HERE, "Current")] });
    await open();

    expect(await submenu(user, "Copy to library")).toEqual(["No other library in the recent list"]);
  });

  it("offers neither while a transfer is running", async () => {
    show({ busy: true });
    await open();

    for (const name of ["Move to library", "Copy to library"]) {
      expect(screen.getByRole("menuitem", { name }).getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("is not offered where there is no library root, as over the preview", async () => {
    show({ libraryRoot: null });
    await open();

    expect(screen.queryByRole("menuitem", { name: "Move to library" })).toBeNull();
  });
});

describe("which libraries a transfer offers", () => {
  it("drops the open one and the unavailable, and puts the pinned first", () => {
    const list = [
      recent(HERE, "Current", true),
      recent(PHOTOS, "Photos"),
      { ...recent(GONE, "Old", true), available: false },
      recent(ARCHIVE, "Archive", true),
    ];
    expect(destinations(list, HERE).map((library) => library.name)).toEqual(["Archive", "Photos"]);
  });
});

describe("what the status bar says after a transfer", () => {
  const report = {
    added: 3,
    merged: 0,
    preserved: 0,
    removed: 3,
    folders: 0,
    subtitles: 0,
    bytes: 0,
    missing: 0,
    failed: 0,
    cancelled: false,
  };

  it("says only what happened", () => {
    expect(transferLine(report, "move", "Photos")).toBe("Moved 3 assets to Photos");
  });

  it("counts a merge as arrived, and says it was one", () => {
    expect(transferLine({ ...report, added: 1, merged: 2 }, "copy", "Photos")).toBe(
      "Copied 3 assets to Photos · 2 already there, merged",
    );
  });

  it("says a stopped move stopped, and where the rest are", () => {
    expect(
      transferLine({ ...report, added: 2, removed: 2, cancelled: true }, "move", "Photos"),
    ).toBe("Stopped · Moved 2 assets to Photos · the rest are still here");
  });

  it("says what stayed behind, and why", () => {
    expect(
      transferLine({ ...report, added: 0, removed: 0, missing: 1, failed: 2 }, "move", "Photos"),
    ).toBe("Nothing was moved to Photos · 1 not on this machine, left here · 2 failed, left here");
  });
});
