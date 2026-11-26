import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../App.js";
import { FakeEngine, install } from "../testing/fake-engine.js";

/**
 * A library's password in the window (ADR-0071): asked for by the picker, and
 * set, changed and removed from the `☰`.
 */

const ROOT = "/home/you/Private.roost";

afterEach(cleanup);

function start(password?: string) {
  const engine = new FakeEngine({
    openLibraryDialog: ROOT,
    existing: [{ root: ROOT, name: "Private", ...(password === undefined ? {} : { password }) }],
  });
  install(engine);
  return { engine, user: userEvent.setup(), ...render(<App />) };
}

const opens = (engine: FakeEngine) =>
  engine.seen.filter((request) => request.type === "library:open");

describe("opening a library with a password", () => {
  it("asks for it, says so when it is wrong, and opens with the right one", async () => {
    const { engine, user } = start("secret");
    await user.click(await screen.findByRole("button", { name: "Open library…" }));

    expect(await screen.findByRole("heading", { name: "Private has a password" })).toBeDefined();
    // Asking is not a failure: nothing in the picker says something went wrong.
    expect(screen.queryByRole("alert")).toBeNull();

    const field = screen.getByLabelText("Password");
    await user.type(field, "guess{Enter}");
    expect(await screen.findByText("That is not the password.")).toBeDefined();
    // Emptied, so the second try does not start with the mistake in it.
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");

    await user.type(screen.getByLabelText("Password"), "secret");
    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(await screen.findByRole("heading", { name: "Private" })).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opens(engine).map((request) => request.password)).toEqual([
      undefined,
      "guess",
      "secret",
    ]);
  });

  it("goes back to the picker on Cancel, with nothing to report", async () => {
    const { user } = start("secret");
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await screen.findByRole("heading", { name: "Private has a password" });

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Open library…" })).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens a library without one as it always did", async () => {
    const { engine, user } = start();
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    expect(await screen.findByRole("heading", { name: "Private" })).toBeDefined();
    expect(opens(engine)).toEqual([{ type: "library:open", path: ROOT }]);
  });
});

describe("the password in the menu", () => {
  const menu = async (user: ReturnType<typeof userEvent.setup>): Promise<string[]> => {
    await user.click(await screen.findByRole("button", { name: "Menu" }));
    await screen.findByRole("menu");
    return screen.getAllByRole("menuitem").map((item) => item.textContent ?? "");
  };

  it("sets one, typed twice, and then offers to change or remove it", async () => {
    const { engine, user } = start();
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await screen.findByRole("heading", { name: "Private" });

    const items = await menu(user);
    expect(items).toContain("Set password…");
    expect(items).not.toContain("Remove password…");
    await user.click(screen.getByRole("menuitem", { name: "Set password…" }));

    expect(await screen.findByText(/It does not encrypt anything/)).toBeDefined();
    await user.type(screen.getByLabelText("New password"), "secret");
    await user.type(screen.getByLabelText("Type it again"), "secrex");
    expect(screen.getByText("The two do not match.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);

    await user.clear(screen.getByLabelText("Type it again"));
    await user.type(screen.getByLabelText("Type it again"), "secret");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Set a password on the library")).toBeDefined();
    expect(engine.seen).toContainEqual({ type: "library:setPassword", next: "secret" });

    const after = await menu(user);
    expect(after).toContain("Change password…");
    expect(after).toContain("Remove password…");
    expect(after).not.toContain("Set password…");
  });

  it("asks for the current password before removing it, and keeps the dialog on a wrong one", async () => {
    const { engine, user } = start("secret");
    await user.click(await screen.findByRole("button", { name: "Open library…" }));
    await user.type(await screen.findByLabelText("Password"), "secret{Enter}");
    await screen.findByRole("heading", { name: "Private" });

    await menu(user);
    await user.click(screen.getByRole("menuitem", { name: "Remove password…" }));
    await user.type(await screen.findByLabelText("Current password"), "guess");
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(await screen.findByText("That is not the password.")).toBeDefined();
    expect(screen.getByRole("dialog")).toBeDefined();

    await user.type(screen.getByLabelText("Current password"), "secret");
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(await screen.findByText("Removed the password")).toBeDefined();
    expect(engine.seen).toContainEqual({
      type: "library:setPassword",
      current: "secret",
      next: null,
    });
    expect(await menu(user)).toContain("Set password…");
  });
});
