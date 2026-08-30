import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAsset } from "../testing/fake-engine.js";
import { SelectionStore } from "./selection.js";

/**
 * What a selection change costs, counted in re-renders.
 *
 * `UI_SPEC.md` §6: "Selecting one item must not re-render ten thousand cells."
 * That is a claim about React, not about the DOM — React can re-render four
 * hundred components and write to none of them, so counting DOM mutations would
 * report success either way. The cell module is wrapped here so the count is
 * the real one.
 *
 * The wrapper is a plain function component, deliberately: it re-renders
 * whenever its parent does, which is exactly the regression this is watching
 * for. Selection state moved up into the grid — as ordinary React state, or as
 * a context, or as a `useSyncExternalStore` on the container — would pass every
 * other test in this directory and fail here.
 */

const rendered = vi.hoisted(() => ({ hashes: [] as string[] }));

vi.mock("./AssetCell.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./AssetCell.js")>();
  return {
    ...actual,
    AssetCell: (props: import("./AssetCell.js").AssetCellProps) => {
      rendered.hashes.push(props.hash);
      return createElement(actual.AssetCell, props);
    },
  };
});

const { Grid } = await import("./Grid.js");

describe("re-renders on a selection change", () => {
  let selection: SelectionStore;

  beforeEach(() => {
    for (const name of ["clientWidth", "clientHeight"] as const) {
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        value: name === "clientWidth" ? 1000 : 800,
      });
    }
    selection = new SelectionStore();
    rendered.hashes = [];
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      fn(0);
      return 0;
    });
  });

  it("re-renders two cells, whatever is on screen", async () => {
    const assets = Array.from({ length: 600 }, (_, i) => fakeAsset(i));
    render(
      <Grid
        assets={assets}
        view="icons"
        proportional={false}
        target={240}
        selection={selection}
        onMore={() => {}}
      />,
    );
    const user = userEvent.setup();
    const cells = screen.getAllByRole("option");
    // Enough on screen that a whole-grid re-render would be obvious.
    expect(cells.length).toBeGreaterThan(20);

    await user.click(cells[0] as HTMLElement);
    rendered.hashes = [];

    await user.click(cells[7] as HTMLElement);

    // One loses selection and focus, one gains both. Nothing else moved.
    expect(new Set(rendered.hashes).size).toBe(2);
    expect(rendered.hashes).toHaveLength(2);
  });

  it("re-renders nothing when the click changes nothing", async () => {
    const assets = Array.from({ length: 200 }, (_, i) => fakeAsset(i));
    render(
      <Grid
        assets={assets}
        view="icons"
        proportional={false}
        target={240}
        selection={selection}
        onMore={() => {}}
      />,
    );
    const user = userEvent.setup();
    const cells = screen.getAllByRole("option");

    await user.click(cells[3] as HTMLElement);
    rendered.hashes = [];
    await user.click(cells[3] as HTMLElement);

    expect(rendered.hashes).toEqual([]);
  });
});
