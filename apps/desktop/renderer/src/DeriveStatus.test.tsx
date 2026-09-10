import type { WireDeriveStatus } from "@roost/contract";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DeriveStatus } from "./DeriveStatus.js";

const EMPTY: WireDeriveStatus = {
  ready: 0,
  running: 0,
  blocked: 0,
  failed: 0,
  reasons: [],
  capabilities: [],
};

function show(status: Partial<WireDeriveStatus>): ReturnType<typeof userEvent.setup> {
  const retried: (string | undefined)[] = [];
  render(<DeriveStatus status={{ ...EMPTY, ...status }} onRetry={(r) => retried.push(r)} />);
  return userEvent.setup();
}

describe("what the status bar says about derived work", () => {
  it("says nothing when there is nothing to say", () => {
    render(<DeriveStatus status={{ ...EMPTY }} onRetry={() => undefined} />);

    // A library whose queue is empty should not carry a status about a queue.
    expect(document.body.textContent).toBe("");
  });

  it("counts what is still to do while it is doing it", () => {
    show({ ready: 40, running: 2 });

    expect(screen.getByText("Deriving… 42 to go")).toBeDefined();
  });

  it("names the tool to install rather than a count, when something can be installed", () => {
    // The one case a person can act on, so it is the one the line is spent on.
    // It opens the list rather than retrying: the command to type is in there,
    // beside the group it would release (`UI_SPEC.md` §3.13).
    const retried: (string | undefined)[] = [];
    render(
      <DeriveStatus
        status={{
          ...EMPTY,
          blocked: 12,
          reasons: [{ reason: "missing:ffmpeg", count: 12 }],
          capabilities: [
            {
              name: "media",
              available: false,
              version: null,
              detail: "install ffmpeg for video and audio previews",
              install: "sudo dnf swap ffmpeg-free ffmpeg --allowerasing",
            },
          ],
        }}
        onRetry={(reason) => retried.push(reason)}
      />,
    );

    const button = screen.getByRole("button");
    expect(button.textContent).toContain("install ffmpeg");
    // What the click does — open the list rather than retry — is asserted in
    // `DeriveFailures.test.tsx`, which has an engine to answer it.
    expect(retried).toEqual([]);
  });

  it("names the backend the parked work is actually waiting for", () => {
    // Two backends can be missing at once now (ADR-0040), and the reason names
    // a *tool* while the capability names a *backend*. Pairing them by position
    // would offer to install ffmpeg for a photograph.
    render(
      <DeriveStatus
        status={{
          ...EMPTY,
          blocked: 4,
          reasons: [{ reason: "missing:libheif", count: 4 }],
          capabilities: [
            {
              name: "media",
              available: false,
              version: null,
              detail: "install ffmpeg for video and audio previews",
              install: "sudo dnf swap ffmpeg-free ffmpeg --allowerasing",
            },
            {
              name: "heif",
              available: false,
              version: null,
              detail: "install libheif for HEIC photographs",
              install: "sudo dnf install libheif-tools libheif-freeworld",
            },
          ],
        }}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByRole("button").textContent).toContain("install libheif");
  });

  it("counts work parked on nothing anyone can install, and still opens the list", () => {
    // No tool to name, so the line is a number — but the number is the whole
    // question, and the answer is a click away rather than a hover away. This
    // is the state the user's own library was in on 2026-09-10: nineteen files
    // with no preview and no way to learn which.
    show({ blocked: 3, reasons: [{ reason: "unsupported:zip", count: 3 }] });

    const button = screen.getByRole("button");
    expect(button.textContent).toBe("3 without a preview");
    expect(button.title).toBe("See what has no preview, and why");
  });

  it("offers the list for work that failed, not a blind retry", () => {
    // What the button opens is tested in `DeriveFailures.test.tsx`; what
    // matters here is that the status bar carries the count and a way in.
    show({ failed: 2 });

    expect(screen.getByRole("button").textContent).toContain("2 could not be drawn");
    expect(screen.getByRole("button").title).toBe("See what failed, and why");
  });
});
