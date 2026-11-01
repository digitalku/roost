import type { WireDeriveStatus } from "@roost/contract";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DeriveStatus } from "./DeriveStatus.js";

const EMPTY: WireDeriveStatus = {
  checking: 0,
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

  it("counts what has no picture, and says why when pressed, with nothing to start", async () => {
    const user = userEvent.setup();
    render(<DeriveStatus status={{ ...EMPTY, ready: 1_238, running: 2 }} />);

    expect(screen.queryByRole("button", { name: /Pause|Resume/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "1,240 thumbnails not drawn yet" }));
    expect(await screen.findByText(/a little at a time as you use Roost/)).toBeDefined();
  });

  it("counts one thumbnail as one", () => {
    render(<DeriveStatus status={{ ...EMPTY, ready: 1 }} />);
    expect(screen.getByRole("button", { name: "1 thumbnail not drawn yet" })).toBeDefined();
  });

  it("says what a rebuild left to read, beside what has no picture", () => {
    render(<DeriveStatus status={{ ...EMPTY, ready: 4, checking: 1_000 }} />);
    expect(screen.getByText("Checking files… 1,000 to go")).toBeDefined();
    expect(screen.getByRole("button", { name: "4 thumbnails not drawn yet" })).toBeDefined();
  });
});
