import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import { FakeEngine, install } from "./testing/fake-engine.js";

/**
 * About Roost (`UI_SPEC.md` §3.12, ADR-0038 §5.1).
 *
 * What is worth holding here is not that a dialog opens. It is that the two
 * things a proprietary build owes somebody are actually reachable from the
 * window: which build this is, and the licences of the code it ships. Both
 * were the point of the ADR, and both are easy to lose to a later tidy-up.
 */

const HOLIDAY = "/home/you/Holiday Photos.roost";

const open = async (options: ConstructorParameters<typeof FakeEngine>[0] = {}) => {
  const engine = new FakeEngine({
    openLibraryDialog: HOLIDAY,
    existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
    stats: { assets: 3 },
    ...options,
  });
  install(engine);
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Open library…" }));
  await screen.findByRole("heading", { name: "Holiday Photos" });
  await user.click(await screen.findByRole("button", { name: "Menu" }));
  await user.click(await screen.findByRole("menuitem", { name: "About Roost…" }));
  return { engine, user };
};

describe("about", () => {
  it("names the build it is running in, commit included", async () => {
    await open();

    // One line, and every part of it: the commit is what identifies a build
    // between releases, and the runtime versions are what a rendering bug is
    // reported against (ADR-0038 §5.1).
    await waitFor(() =>
      expect(
        screen.getByText("Version 1.0.0 · abc1234 · Electron 43.4.1 · Chromium 150.0.7871.224"),
      ).toBeTruthy(),
    );
  });

  it("calls a build with no version of its own a development build", async () => {
    // What every unpackaged run is, and the bug this replaced: `app.getVersion()`
    // answers with *Electron's* version when the app is not packaged, so the
    // dialog claimed to be Roost 43.4.1 the first time it was opened in a real
    // window. Main sends `null` now, and the line leans on the commit.
    await open({ about: { version: null } });

    await waitFor(() =>
      expect(
        screen.getByText("Development build · abc1234 · Electron 43.4.1 · Chromium 150.0.7871.224"),
      ).toBeTruthy(),
    );
  });

  it("says who owns it and how to reach them", async () => {
    await open();

    expect(screen.getByText(/© 2026 Digitalku/)).toBeTruthy();
    expect(screen.getByText("roostsupport@digitalku.com")).toBeTruthy();
  });

  it("hands the homepage to the desktop rather than navigating to it", async () => {
    const { engine, user } = await open();
    await user.click(screen.getByRole("button", { name: "roost.digitalku.com" }));

    // The scheme is added here and the label goes without one: the renderer may
    // not leave its own origin (invariant 11), so this is a request to main.
    expect(engine.seen.filter((request) => request.type === "link:open")).toEqual([
      { type: "link:open", url: "https://roost.digitalku.com" },
    ]);
  });

  it("carries the third-party licences in the window, not behind a link", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Third-party licences" }));

    // The three that oblige more than attribution (ADR-0038 §4). If the notices
    // are ever trimmed to a list of names, this is what notices.
    const notices = screen.getByLabelText("Third-party licences").textContent ?? "";
    expect(notices).toContain("MPL-2.0");
    expect(notices).toContain("LGPL-3.0");
    expect(notices).toContain("Apache-2.0");
  });

  it("goes back to the dialog it came from", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Third-party licences" }));
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.queryByLabelText("Third-party licences")).toBeNull();
    expect(screen.getByText(/© 2026 Digitalku/)).toBeTruthy();
  });
});
