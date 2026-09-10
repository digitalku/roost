import type { WireDeriveFailureGroup, WireDeriveFailures, WireDeriveStatus } from "@roost/contract";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DeriveStatus } from "./DeriveStatus.js";
import { FakeEngine, install } from "./testing/fake-engine.js";

/**
 * "36 could not be drawn", opened (`UI_SPEC.md` §3.13).
 *
 * The count came from the user's own library on 2026-09-10, and the complaint
 * was that it said nothing anybody could act on. What the list has to answer is
 * three questions: which files, what went wrong, and whether trying again would
 * change it.
 */

const EMPTY: WireDeriveStatus = {
  ready: 0,
  running: 0,
  blocked: 0,
  failed: 0,
  reasons: [],
  capabilities: [],
};

function group(over: Partial<WireDeriveFailureGroup> = {}): WireDeriveFailureGroup {
  return {
    reason: "Input file has corrupt header: VipsJpeg: premature end of JPEG image",
    count: 20,
    attempts: 1,
    samples: [
      { hash: "a".repeat(64), name: "IMG_0421.jpg", ext: "jpg" },
      { hash: "b".repeat(64), name: "scan-3.png", ext: "png" },
    ],
    ...over,
  };
}

async function open(
  failures: Partial<WireDeriveFailures>,
  retried: (string | undefined)[] = [],
): Promise<{ engine: FakeEngine; user: ReturnType<typeof userEvent.setup> }> {
  // The status bar's count and the list's total are the same number seen
  // twice, and a fixture where they disagree is not a state the engine has.
  const engine = new FakeEngine({ deriveFailures: { total: 36, ...failures } });
  install(engine);
  const user = userEvent.setup();
  render(
    <DeriveStatus status={{ ...EMPTY, failed: 36 }} onRetry={(reason) => retried.push(reason)} />,
  );
  await user.click(screen.getByRole("button", { name: /could not be drawn/ }));
  return { engine, user };
}

describe("what could not be drawn", () => {
  it("opens the list rather than retrying blindly", async () => {
    const retried: (string | undefined)[] = [];
    await open({ groups: [group()] }, retried);

    // The old button retried and said nothing about what it was retrying, which
    // for a folder of damaged files is the same answer a minute later.
    expect(retried).toEqual([]);
    expect(await screen.findByRole("heading", { name: "36 could not be drawn" })).toBeDefined();
  });

  it("says what went wrong in words, and keeps the backend's own underneath", async () => {
    await open({ groups: [group()] });

    expect(await screen.findByText("The file is damaged or incomplete")).toBeDefined();
    // Kept verbatim: a bug report needs the real words, and the sentence above
    // is this build's reading of them rather than evidence.
    expect(
      screen.getByText("Input file has corrupt header: VipsJpeg: premature end of JPEG image"),
    ).toBeDefined();
  });

  it("names the files, and says how many it did not name", async () => {
    await open({ groups: [group()] });

    expect(await screen.findByText("IMG_0421.jpg")).toBeDefined();
    expect(screen.getByText("scan-3.png")).toBeDefined();
    expect(screen.getByText("…and 18 more")).toBeDefined();
  });

  it("groups by fault, largest first, and opens the largest", async () => {
    await open({
      groups: [group(), group({ reason: "ffmpeg: … exited with 1", count: 6, samples: [] })],
    });

    // The first group is open because a dialog of closed rows answers nothing
    // without a click; the second is a summary until it is asked for.
    expect(await screen.findByText("IMG_0421.jpg")).toBeDefined();
    expect(screen.getByText("ffmpeg could not read this file")).toBeDefined();
  });

  it("warns that a group has been tried before, so Try again is a known quantity", async () => {
    await open({ groups: [group({ attempts: 3 })] });

    expect(await screen.findByText("Tried 3 times already.")).toBeDefined();
  });

  it("retries everything, once, from inside the list", async () => {
    const retried: (string | undefined)[] = [];
    const { user } = await open({ groups: [group()] }, retried);

    await user.click(await screen.findByRole("button", { name: "Try again" }));

    // Undefined, not a reason: the reason releases work parked on a capability,
    // and a failure is not parked on anything.
    expect(retried).toEqual([undefined]);
    expect(screen.queryByRole("heading", { name: "36 could not be drawn" })).toBeNull();
  });

  it("puts the list on the clipboard through main, not through the renderer", async () => {
    const { engine, user } = await open({ groups: [group()] });

    await user.click(await screen.findByRole("button", { name: "Copy list" }));

    // The renderer has no clipboard of its own (invariant 11), so this is a
    // request like any other — and what it copies is the backend's message,
    // which is what a bug report needs.
    expect(engine.copied).toContain("VipsJpeg: premature end of JPEG image");
    expect(engine.copied).toContain("IMG_0421.jpg");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeDefined();
  });

  it("says when it grouped only part of a very broken library", async () => {
    await open({ groups: [group()], total: 40_000, read: 2_000, hidden: 12 });

    expect(await screen.findByText("Grouped from the first 2,000 of 40,000.")).toBeDefined();
    expect(screen.getByText("…and 12 more, in reasons too varied to group.")).toBeDefined();
  });
});
