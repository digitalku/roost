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

  it("names the tool to install, and offers to try again", async () => {
    // The one case a person can act on, so the one that gets a button.
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
            },
          ],
        }}
        onRetry={(reason) => retried.push(reason)}
      />,
    );

    const button = screen.getByRole("button");
    expect(button.textContent).toContain("install ffmpeg");

    await userEvent.setup().click(button);
    // Only what is parked on that reason: releasing everything would also retry
    // the formats this build genuinely cannot draw.
    expect(retried).toEqual(["missing:ffmpeg"]);
  });

  it("reports work that is parked on nothing anyone can install, without a button", () => {
    show({ blocked: 3, reasons: [{ reason: "unsupported:zip", count: 3 }] });

    expect(screen.getByText("3 without a preview")).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers the list for work that failed, not a blind retry", () => {
    // What the button opens is tested in `DeriveFailures.test.tsx`; what
    // matters here is that the status bar carries the count and a way in.
    show({ failed: 2 });

    expect(screen.getByRole("button").textContent).toContain("2 could not be drawn");
    expect(screen.getByRole("button").title).toBe("See what failed, and why");
  });
});
