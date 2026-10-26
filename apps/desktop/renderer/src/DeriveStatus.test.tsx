import type { WireDeriveStatus } from "@roost/contract";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DeriveStatus } from "./DeriveStatus.js";

const EMPTY: WireDeriveStatus = {
  paused: false,
  ready: 0,
  running: 0,
  blocked: 0,
  failed: 0,
  reasons: [],
  capabilities: [],
};

describe("what the status bar says about derived work", () => {
  it("says nothing when there is nothing to say", () => {
    render(<DeriveStatus status={{ ...EMPTY }} />);

    // A library whose queue is empty should not carry a status about a queue.
    expect(document.body.textContent).toBe("");
  });

  it("counts what is still to do while it is doing it", () => {
    render(<DeriveStatus status={{ ...EMPTY, ready: 40, running: 2 }} />);

    expect(screen.getByText("Deriving… 42 to go")).toBeDefined();
  });

  it("pauses from a × beside the count, and says what is left while paused", async () => {
    // ADR-0049. The × is its own button: the count was never a control.
    let paused = 0;
    let resumed = 0;
    const user = userEvent.setup();
    const { rerender } = render(
      <DeriveStatus
        status={{ ...EMPTY, ready: 1_238, running: 2 }}
        onPause={() => {
          paused += 1;
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Pause deriving" }));
    expect(paused).toBe(1);

    // Paused: the work is left, not being done, whatever is still finishing.
    rerender(
      <DeriveStatus
        status={{ ...EMPTY, paused: true, ready: 1_238, running: 2 }}
        onResume={() => {
          resumed += 1;
        }}
      />,
    );
    expect(screen.queryByText(/Deriving/)).toBeNull();
    expect(screen.getByText("Paused · 1,240 left")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(resumed).toBe(1);
  });

  it("says nothing about a pause with nothing left to do", () => {
    render(<DeriveStatus status={{ ...EMPTY, paused: true }} />);
    expect(document.body.textContent).toBe("");
  });

  it("says nothing about what failed or waits on a tool — the file says it", () => {
    // ADR-0050: *"pop up X could not be drawn tidak perlu"*. A failed or parked
    // file says so, with what to do, when it is opened; the bar is progress.
    render(
      <DeriveStatus
        status={{
          ...EMPTY,
          ready: 5,
          failed: 36,
          blocked: 8,
          reasons: [{ reason: "missing:libheif", count: 8 }],
          capabilities: [
            {
              name: "heif",
              available: false,
              version: null,
              detail: "install libheif for HEIC photographs",
              install: "sudo dnf install libheif-tools",
              installable: false,
              bundled: false,
            },
          ],
        }}
      />,
    );

    expect(document.body.textContent).toBe("Deriving… 5 to go");
  });

  it("says nothing at all once the queue is done, whatever failed", () => {
    render(<DeriveStatus status={{ ...EMPTY, failed: 3, blocked: 2 }} />);
    expect(document.body.textContent).toBe("");
  });
});
