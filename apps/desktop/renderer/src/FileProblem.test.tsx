import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FileProblem } from "./FileProblem.js";
import { FakeEngine, install } from "./testing/fake-engine.js";

const ID = "ZA23511MJFSW";

/** A file waiting on libheif, on a machine that can be told how to get it. */
function heifMissing(): ConstructorParameters<typeof FakeEngine>[0] {
  return {
    deriveStatus: {
      paused: false,
      ready: 0,
      running: 0,
      blocked: 8,
      failed: 0,
      reasons: [{ reason: "missing:libheif", count: 8 }],
      capabilities: [
        {
          name: "heif",
          available: false,
          version: null,
          detail: "install libheif for HEIC photographs",
          install: "sudo dnf install libheif-tools",
          installable: false,
        },
      ],
    },
  };
}

describe("why one file has no preview, and what to do about it", () => {
  it("says nothing for a file with a picture, or one nothing draws", () => {
    install(new FakeEngine());
    const { container, rerender } = render(<FileProblem detail={{ id: ID, undrawn: null }} />);
    expect(container.textContent).toBe("");

    // A `.zip` without a picture is not a problem (`UI_SPEC.md` §3.13).
    rerender(<FileProblem detail={{ id: ID, undrawn: "unsupported:zip" }} />);
    expect(container.textContent).toBe("");
  });

  it("gives a damaged file its steps, its own words, and the three buttons", async () => {
    // ADR-0050: the user's three — Try again for this file, Open externally,
    // Show in folder.
    const engine = new FakeEngine();
    install(engine);
    const user = userEvent.setup();
    const reason = "Input file has corrupt header: VipsJpeg: premature end of JPEG image";
    render(<FileProblem detail={{ id: ID, undrawn: reason }} />);

    expect(screen.getByText("The file is damaged or incomplete")).toBeDefined();
    expect(screen.getByText(/Get a fresh copy/)).toBeDefined();
    expect(screen.getByText(reason)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await user.click(screen.getByRole("button", { name: "Open externally" }));
    await user.click(screen.getByRole("button", { name: "Show in folder" }));

    expect(engine.seen.filter((r) => r.type !== "derive:status")).toEqual([
      { type: "derive:retryAsset", id: ID },
      { type: "asset:openExternally", id: ID },
      { type: "asset:reveal", id: ID },
    ]);
    // Pressed, and saying so, until the file's picture arrives.
    expect(screen.getByRole("button", { name: "Trying again…" })).toBeDefined();
  });

  it("carries the command for a file waiting on a tool, and retries every file waiting on it", async () => {
    // With the status bar no longer naming the tool, the file is where the
    // command lives — and installing it fixes all eight, so the button says so.
    const engine = new FakeEngine(heifMissing());
    install(engine);
    const user = userEvent.setup();
    render(<FileProblem detail={{ id: ID, undrawn: "missing:libheif" }} />);

    expect(await screen.findByText("sudo dnf install libheif-tools")).toBeDefined();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeDefined();
    const retry = await screen.findByRole("button", { name: "Try again (8 files)" });
    await user.click(retry);

    await waitFor(() =>
      expect(engine.seen).toContainEqual({ type: "derive:retry", reason: "missing:libheif" }),
    );
    expect(engine.seen.some((r) => r.type === "derive:retryAsset")).toBe(false);
  });

  it("leaves the line to whatever above it has already said it", () => {
    install(new FakeEngine());
    render(<FileProblem detail={{ id: ID, undrawn: "missing:file" }} heading={false} />);

    expect(screen.queryByText("The file is not in the library")).toBeNull();
    expect(screen.getByText(/Restore it from a backup/)).toBeDefined();
  });
});
