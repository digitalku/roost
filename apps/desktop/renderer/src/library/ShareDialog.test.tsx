import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../App.js";
import { FakeEngine, install } from "../testing/fake-engine.js";

/** *Share on this network…* in the `☰` (ADR-0072 §3.1), against a fake main. */

const ROOT = "/home/you/Private.roost";

afterEach(cleanup);

async function openShare(options: { password?: string; sharing?: boolean } = {}) {
  const engine = new FakeEngine({
    openLibraryDialog: ROOT,
    existing: [
      {
        root: ROOT,
        name: "Private",
        ...(options.password === undefined ? {} : { password: options.password }),
      },
    ],
    remote: {
      sharing: options.sharing ?? false,
      devices: [{ id: "d1", name: "Pixel 9", pairedAt: 1_700_000_000, lastSeen: null }],
    },
  });
  install(engine);
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Open library…" }));
  if (options.password !== undefined) {
    await user.type(await screen.findByLabelText("Password"), `${options.password}{Enter}`);
  }
  await screen.findByRole("heading", { name: "Private" });
  await user.click(screen.getByRole("button", { name: "Menu" }));
  await user.click(await screen.findByRole("menuitem", { name: "Share on this network…" }));
  await screen.findByRole("heading", { name: "Share on this network" });
  return { engine, user };
}

describe("sharing the library with a phone", () => {
  it("offers a password first for a library without one", async () => {
    const { user } = await openShare();
    expect(await screen.findByText(/a library without one is not shared/)).toBeDefined();
    expect(screen.queryByRole("checkbox")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Set password…" }));
    expect(await screen.findByLabelText("New password")).toBeDefined();
  });

  it("ticks the box, and then says what to type into the phone", async () => {
    const { engine, user } = await openShare({ password: "secret" });
    const box = await screen.findByRole("checkbox", { name: /Share this library/ });
    expect(screen.queryByText("http://192.168.1.20:7387")).toBeNull();

    await user.click(box);

    expect(await screen.findByText("http://192.168.1.20:7387")).toBeDefined();
    expect(screen.getByText(/Plain HTTP/)).toBeDefined();
    expect(engine.seen).toContainEqual({ type: "remote:share", on: true });
  });

  it("lists the paired phones and unpairs one", async () => {
    const { engine, user } = await openShare({ password: "secret", sharing: true });
    expect(await screen.findByText("Pixel 9")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Unpair Pixel 9" }));

    await waitFor(() => expect(screen.queryByText("Pixel 9")).toBeNull());
    expect(screen.getByText("None yet.")).toBeDefined();
    expect(engine.seen).toContainEqual({ type: "remote:revoke", device: "d1" });
  });
});
