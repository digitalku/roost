import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOADING_DELAY_MS } from "../delay.js";
import { OpeningStatus, openingName } from "./OpeningStatus.js";

describe("the opening status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says nothing for an open that answers quickly", () => {
    // An ordinary open is a fifth of a second at a hundred thousand assets, and
    // a line that flashes up and away in that time reads as a flicker.
    const { container, rerender } = render(
      <OpeningStatus opening={{ name: "Holiday", fraction: undefined }} />,
    );
    act(() => {
      vi.advanceTimersByTime(LOADING_DELAY_MS - 1);
    });
    expect(container.textContent).toBe("");

    rerender(<OpeningStatus opening={undefined} />);
    act(() => {
      vi.advanceTimersByTime(LOADING_DELAY_MS);
    });
    expect(container.textContent).toBe("");
  });

  it("names the library once the open has taken long enough to say so", () => {
    render(<OpeningStatus opening={{ name: "Holiday", fraction: undefined }} />);
    act(() => {
      vi.advanceTimersByTime(LOADING_DELAY_MS);
    });
    expect(screen.getByRole("status").textContent).toBe("Opening Holiday…");
    // Nothing is being counted, so nothing pretends to move (`UI_SPEC.md` §0.6).
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("draws a bar with the fraction folded, when the open is folding", () => {
    const { rerender } = render(
      <OpeningStatus opening={{ name: "Holiday", fraction: undefined }} />,
    );
    act(() => {
      vi.advanceTimersByTime(LOADING_DELAY_MS);
    });
    rerender(<OpeningStatus opening={{ name: "Holiday", fraction: 0.584 }} />);

    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("58");
    expect(screen.getByText("58%")).toBeDefined();
    expect(screen.getByText("Reading the journal")).toBeDefined();
  });

  it("takes the bar away once the journal is read, rather than holding it at 100%", () => {
    const { rerender } = render(
      <OpeningStatus opening={{ name: "Holiday", fraction: undefined }} />,
    );
    act(() => {
      vi.advanceTimersByTime(LOADING_DELAY_MS);
    });
    rerender(<OpeningStatus opening={{ name: "Holiday", fraction: 1 }} />);

    // What follows the read has no count, and a full bar that waits is the one
    // thing `UI_SPEC.md` §0.6 forbids by name.
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Opening Holiday…Getting it ready");
  });

  it("starts the wait again for the next open", () => {
    const { container, rerender } = render(
      <OpeningStatus opening={{ name: "One", fraction: undefined }} />,
    );
    act(() => {
      vi.advanceTimersByTime(LOADING_DELAY_MS);
    });
    rerender(<OpeningStatus opening={undefined} />);
    rerender(<OpeningStatus opening={{ name: "Two", fraction: undefined }} />);
    expect(container.textContent).toBe("");
  });
});

describe("the name of a library being opened", () => {
  it("is the folder's name without the suffix", () => {
    expect(openingName("/home/you/Holiday.roost", ".roost")).toBe("Holiday");
    expect(openingName("/home/you/Holiday.roost/", ".roost")).toBe("Holiday");
    expect(openingName("D:\\Libraries\\Work.roost", ".roost")).toBe("Work");
  });

  it("is the folder's whole name when it has no suffix to take off", () => {
    // Opening is name-blind (ADR-0014), so a library may be called anything.
    expect(openingName("/media/drive/archive", ".roost")).toBe("archive");
    expect(openingName("/media/drive/.roost", ".roost")).toBe(".roost");
  });
});
