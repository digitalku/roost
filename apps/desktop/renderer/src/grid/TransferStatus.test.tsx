import type { WireRecentLibrary, WireTransferReport } from "@roost/contract";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { FakeEngine, fakeAsset, install } from "../testing/fake-engine.js";
import { percentOf, TransferStatus, useTransfer } from "./TransferStatus.js";

/**
 * A transfer while it runs, in the status bar (ADR-0054 §3.9).
 *
 * The reply is held for the length of each test, because a transfer in
 * progress *is* a request nobody has answered yet — that is the whole state
 * this component draws.
 */

const IDS = [0, 1].map((index) => fakeAsset(index).id);
const PHOTOS: WireRecentLibrary = {
  root: "/home/me/Photos.roost",
  name: "Photos",
  id: "photos",
  openedAt: 1_700_000_000,
  pinned: false,
  available: true,
};
const GIB = 1024 * 1024 * 1024;

describe("the transfer in the status bar", () => {
  let engine: FakeEngine;
  let notes: string[];
  let left: string[];
  let finish: () => void;

  afterEach(cleanup);

  function Harness(): React.JSX.Element {
    const transferring = useTransfer({
      onNote: (line) => notes.push(line),
      onProblem: () => {},
      onLeft: (ids) => left.push(...ids),
    });
    return (
      <>
        <button type="button" onClick={() => transferring.start(IDS, PHOTOS, "move")}>
          go
        </button>
        <TransferStatus transferring={transferring} />
      </>
    );
  }

  const show = (report: Partial<WireTransferReport> = {}) => {
    const reply = new Promise<void>((resolve) => {
      finish = resolve;
    });
    engine = new FakeEngine({
      assets: [fakeAsset(0), fakeAsset(1)],
      transferReport: report,
      hold: { "assets:transfer": reply },
    });
    install(engine);
    notes = [];
    left = [];
    render(<Harness />);
    return userEvent.setup();
  };

  const progress = (done: number, bytesDone: number): void => {
    act(() => {
      engine.emit({
        type: "transfer:progress",
        done,
        total: 2,
        bytesDone,
        bytesTotal: 2 * GIB,
      });
    });
  };

  it("says what it is doing before the first number arrives", async () => {
    const user = show();
    await user.click(screen.getByRole("button", { name: "go" }));

    expect(screen.getByText("Moving 2 assets to Photos…")).toBeDefined();
  });

  it("draws how far it has got, by bytes, and says it in numbers too", async () => {
    const user = show();
    await user.click(screen.getByRole("button", { name: "go" }));
    progress(0, GIB / 2);

    expect(screen.getByText("Moving to Photos… 25% · 512.0 MiB of 2.0 GiB · 0 of 2")).toBeDefined();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
  });

  it("says what came of it and lets the moved assets out of the selection", async () => {
    const user = show();
    await user.click(screen.getByRole("button", { name: "go" }));
    finish();

    await waitFor(() => expect(notes).toEqual(["Moved 2 assets to Photos"]));
    expect(left).toEqual(IDS);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("stops when asked, and says what arrived", async () => {
    const user = show({ added: 1, removed: 1, cancelled: true });
    await user.click(screen.getByRole("button", { name: "go" }));
    progress(1, GIB);

    await user.click(screen.getByRole("button", { name: "Stop moving" }));

    expect(engine.seen.filter((request) => request.type === "assets:transferCancel")).toHaveLength(
      1,
    );
    expect(screen.getByText(/Stopping…/)).toBeDefined();
    // Once is enough: the engine is already finishing the file in hand.
    expect(screen.queryByRole("button", { name: "Stop moving" })).toBeNull();

    finish();
    await waitFor(() =>
      expect(notes).toEqual(["Stopped · Moved 1 asset to Photos · the rest are still here"]),
    );
  });

  it("starts one at a time", async () => {
    const user = show();
    await user.click(screen.getByRole("button", { name: "go" }));
    await user.click(screen.getByRole("button", { name: "go" }));

    expect(engine.seen.filter((request) => request.type === "assets:transfer")).toHaveLength(1);
  });
});

describe("how far a transfer is, as a percentage", () => {
  it("goes by bytes, and by assets where there are none", () => {
    expect(percentOf(undefined)).toBe(0);
    expect(percentOf({ done: 0, total: 4, bytesDone: 1, bytesTotal: 3 })).toBe(33);
    expect(percentOf({ done: 1, total: 4, bytesDone: 0, bytesTotal: 0 })).toBe(25);
    expect(percentOf({ done: 0, total: 0, bytesDone: 0, bytesTotal: 0 })).toBe(0);
  });
});
