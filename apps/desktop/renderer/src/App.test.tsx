import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { FakeEngine, install } from "./testing/fake-engine.js";

/**
 * The picker and the creator, driven the way a person drives them.
 *
 * The native dialogs are answered by the fake bridge rather than by GTK: a
 * folder chooser cannot be clicked by a script, and the code that opens one is
 * twenty lines in main. What this covers is everything after the dialog
 * returns, which is where the flow actually lives.
 */

describe("opening a library", () => {
  let engine: FakeEngine;

  const start = (options: ConstructorParameters<typeof FakeEngine>[0] = {}) => {
    engine = new FakeEngine(options);
    install(engine);
    return { user: userEvent.setup(), ...render(<App />) };
  };

  beforeEach(() => {
    // Nothing carried between tests: the bridge is installed fresh each time,
    // so a test cannot pass because of a library the previous one opened.
  });

  it("offers the two things a first run can do", async () => {
    start();
    expect(await screen.findByRole("button", { name: "Open library…" })).toBeDefined();
    expect(screen.getByRole("button", { name: "New library…" })).toBeDefined();
    expect(screen.getByText("No library open")).toBeDefined();
  });

  it("opens the library the dialog chose, and shows what is in it", async () => {
    const { user } = start({
      openLibraryDialog: "/home/you/Holiday Photos.roost",
      existing: [{ root: "/home/you/Holiday Photos.roost", name: "Holiday Photos" }],
      stats: { assets: 1234, tags: 7 },
    });

    await user.click(await screen.findByRole("button", { name: "Open library…" }));

    expect(await screen.findByRole("heading", { name: "Holiday Photos" })).toBeDefined();
    expect(screen.getByText("1,234")).toBeDefined();
    expect(screen.getByText("/home/you/Holiday Photos.roost")).toBeDefined();
    // The dialog is asked first and the library second: the renderer never
    // invents a path.
    expect(engine.seen.map((request) => request.type)).toEqual([
      "library:current",
      "dialog:openLibrary",
      "library:open",
      "library:stats",
    ]);
  });

  it("leaves the screen alone when the dialog is cancelled", async () => {
    const { user } = start({ openLibraryDialog: null });

    await user.click(await screen.findByRole("button", { name: "Open library…" }));

    expect(screen.getByRole("heading", { name: "Roost" })).toBeDefined();
    // Cancelling is an outcome, not a failure, so nothing is reported.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(engine.seen.some((request) => request.type === "library:open")).toBe(false);
  });

  it("reports the engine's own code when the folder is not a library", async () => {
    const { user } = start({ openLibraryDialog: "/home/you/Documents" });

    await user.click(await screen.findByRole("button", { name: "Open library…" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("is not a Roost library");
    expect(alert.textContent).toContain("[not_a_library]");
  });
});

describe("creating a library", () => {
  const start = (options: ConstructorParameters<typeof FakeEngine>[0] = {}) => {
    const engine = new FakeEngine(options);
    install(engine);
    return { engine, user: userEvent.setup(), ...render(<App />) };
  };

  it("says what the folder will be called, as the name is typed", async () => {
    const { user } = start();

    await user.click(await screen.findByRole("button", { name: "New library…" }));
    // Before a name, the placeholder still shows the shape of the answer.
    expect(screen.getByText(`Name.roost`)).toBeDefined();

    await user.type(screen.getByLabelText("Name"), "Kerja");
    expect(screen.getByText("Kerja.roost")).toBeDefined();
  });

  it("will not save without both a name and a location", async () => {
    const { user } = start({ chooseLocationDialog: "/home/you/Pictures" });

    await user.click(await screen.findByRole("button", { name: "New library…" }));
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(true);

    await user.type(screen.getByLabelText("Name"), "Kerja");
    expect(save.hasAttribute("disabled")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
  });

  it("creates the library and opens it", async () => {
    const { engine, user } = start({ chooseLocationDialog: "/home/you/Pictures" });

    await user.click(await screen.findByRole("button", { name: "New library…" }));
    await user.type(screen.getByLabelText("Name"), "Holiday Photos");
    await user.click(screen.getByRole("button", { name: "Choose…" }));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(await screen.findByRole("heading", { name: "Holiday Photos" })).toBeDefined();
    // The location and the name travel apart; the engine is what joins them and
    // adds the suffix (ADR-0014).
    expect(engine.seen).toContainEqual({
      type: "library:create",
      parent: "/home/you/Pictures",
      name: "Holiday Photos",
    });
    expect(engine.has("/home/you/Pictures/Holiday Photos.roost")).toBe(true);
  });

  it("reports a name the engine refuses, without leaving the form", async () => {
    const { user } = start({ chooseLocationDialog: "/home/you/Pictures" });

    await user.click(await screen.findByRole("button", { name: "New library…" }));
    await user.type(screen.getByLabelText("Name"), "a/b");
    await user.click(screen.getByRole("button", { name: "Choose…" }));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("[invalid_library_name]");
    // Still on the form, with what was typed, so it can be corrected.
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "a/b");
  });

  it("goes back to the picker on cancel", async () => {
    const { user } = start();

    await user.click(await screen.findByRole("button", { name: "New library…" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Open library…" })).toBeDefined();
  });
});

describe("a library that is already open", () => {
  it("is found again when the page reloads, because the engine outlives it", async () => {
    const engine = new FakeEngine({
      openLibraryDialog: "/home/you/Holiday Photos.roost",
      existing: [{ root: "/home/you/Holiday Photos.roost", name: "Holiday Photos" }],
    });
    install(engine);
    const user = userEvent.setup();

    const first = render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await screen.findByRole("heading", { name: "Holiday Photos" });
    first.unmount();

    render(<App />);

    // No dialog, no open: the window asked what was already there.
    expect(await screen.findByRole("heading", { name: "Holiday Photos" })).toBeDefined();
  });

  it("re-reads the counts when the engine says something changed", async () => {
    const engine = new FakeEngine({
      openLibraryDialog: "/home/you/Holiday Photos.roost",
      existing: [{ root: "/home/you/Holiday Photos.roost", name: "Holiday Photos" }],
      stats: { assets: 3 },
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await screen.findByText("3");

    const before = engine.seen.filter((request) => request.type === "library:stats").length;
    engine.emit({ type: "library:changed" });

    // The counts are derived, so the only way to keep them true is to re-read
    // them — an event carrying them would be a second copy to keep in step.
    await waitFor(() => {
      const after = engine.seen.filter((request) => request.type === "library:stats").length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("closes back to the picker", async () => {
    const engine = new FakeEngine({
      openLibraryDialog: "/home/you/Holiday Photos.roost",
      existing: [{ root: "/home/you/Holiday Photos.roost", name: "Holiday Photos" }],
    });
    install(engine);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await user.click(await screen.findByRole("button", { name: "Close library" }));

    expect(await screen.findByRole("button", { name: "Open library…" })).toBeDefined();
    expect(screen.getByText("No library open")).toBeDefined();
  });
});
