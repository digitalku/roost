import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import { FakeEngine, install } from "./testing/fake-engine.js";

/**
 * "Reclaim space…" in the ☰ menu (ADR-0031).
 *
 * Three outcomes, and the window has to tell them apart: there is nothing to
 * reclaim, there is something but the index cannot be trusted, or there is
 * something and a size to approve. The middle one is the one worth a test — a
 * refusal that looked like "nothing to do" would leave somebody deleting by
 * hand to get their disk back.
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
  return { engine, user };
};

const reclaim = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  await user.click(await screen.findByRole("button", { name: "Menu" }));
  await user.click(await screen.findByRole("menuitem", { name: "Reclaim space…" }));
};

describe("reclaiming space", () => {
  it("says so, and asks nothing, when there is nothing to reclaim", async () => {
    const { engine, user } = await open({ reclaimable: { objects: 0, bytes: 0, blocked: null } });
    await reclaim(user);

    await waitFor(() =>
      expect(screen.getByText("Nothing to reclaim — every file here belongs to an asset")),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(engine.seen.filter((request) => request.type === "library:reclaim")).toHaveLength(0);
  });

  it("refuses with the reason when the index and the store disagree", async () => {
    // The same rule as `roost doctor --reclaim`: an orphan is only an orphan
    // relative to the index, so a disagreeing index is not a basis for
    // deleting anything.
    const { engine, user } = await open({
      reclaimable: {
        objects: 4,
        bytes: 1024,
        blocked: "2 asset(s) point at bytes that are not there",
      },
    });
    await reclaim(user);

    await waitFor(() =>
      expect(
        screen.getByText(
          "Cannot reclaim: 2 asset(s) point at bytes that are not there. Rebuild the library first",
        ),
      ),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(engine.seen.filter((request) => request.type === "library:reclaim")).toHaveLength(0);
  });

  it("shows the size, waits for a yes, and reports what came back", async () => {
    const { engine, user } = await open({
      reclaimable: { objects: 12, bytes: 3 * 1024 * 1024, blocked: null },
    });
    await reclaim(user);

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Reclaim 3.0 MiB?");
    expect(dialog.textContent).toContain("12 files under files/");
    // Nothing is deleted on the way to the question.
    expect(engine.seen.filter((request) => request.type === "library:reclaim")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Reclaim" }));

    await waitFor(() =>
      expect(engine.seen.filter((request) => request.type === "library:reclaim")).toHaveLength(1),
    );
    expect(await screen.findByText("Reclaimed 3.0 MiB")).toBeDefined();
  });
});
