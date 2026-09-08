import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import { FakeEngine, install } from "./testing/fake-engine.js";

/**
 * The credit under the picker (`UI_SPEC.md` §3.12, ADR-0038 §5.2).
 *
 * It exists for the state this test opens in: no library, so no `☰`, so no
 * **About Roost…** — which without this line would mean no support address at
 * the moment somebody most needs one.
 */

describe("the picker's credit", () => {
  const picker = async () => {
    const engine = new FakeEngine({});
    install(engine);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: "Open library…" });
    return { engine, user };
  };

  it("says who owns this and how to reach them before any library is open", async () => {
    await picker();

    expect(screen.getByText("© 2026 Digitalku")).toBeTruthy();
    expect(screen.getByText("roostsupport@digitalku.com")).toBeTruthy();
  });

  it("hands the homepage to the desktop", async () => {
    const { engine, user } = await picker();
    await user.click(screen.getByRole("button", { name: "roost.digitalku.com" }));

    expect(engine.seen.filter((request) => request.type === "link:open")).toEqual([
      { type: "link:open", url: "https://roost.digitalku.com" },
    ]);
  });
});
