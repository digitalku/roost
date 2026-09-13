import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { INSPECTOR, PaneResizer, SIDEBAR } from "./PaneResizer.js";

/**
 * The seam, driven by everything but a pointer.
 *
 * A drag is a real gesture against a real layout — `scripts/check-panes.mjs`
 * does that against a running window, where the pointer capture and the widths
 * it produces actually exist. What is worth asserting here is the arithmetic
 * either side of it: which way each pane grows, where it stops, and that a
 * gesture writes the property the columns are sized from.
 *
 * The seam is **focused rather than clicked** below. happy-dom has no
 * `setPointerCapture`, so a click here would fail on the one line of this
 * component that only a browser can run — and a pointer gesture is not what
 * these four are about.
 */

/** The resizer with somewhere to write to, which is what `App` gives it. */
function Harness({
  side,
  width,
  onCommit,
}: {
  readonly side: "before" | "after";
  readonly width: number;
  readonly onCommit: (width: number) => void;
}): React.JSX.Element {
  const surface = useRef<HTMLDivElement>(null);
  const bounds = side === "before" ? SIDEBAR : INSPECTOR;
  return (
    <div ref={surface} data-testid="surface">
      <PaneResizer
        pane={side === "before" ? "Sidebar" : "Inspector"}
        token={side === "before" ? "--sidebar-width" : "--inspector-width"}
        side={side}
        width={width}
        min={bounds.min}
        max={bounds.max}
        fallback={bounds.fallback}
        surface={surface}
        onCommit={onCommit}
      />
    </div>
  );
}

describe("the seam between two columns", () => {
  it("says what it is and how wide the pane is", () => {
    render(<Harness side="before" width={300} onCommit={vi.fn()} />);
    const seam = screen.getByRole("separator", { name: "Sidebar width" });
    expect(seam.getAttribute("aria-valuenow")).toBe("300");
    expect(seam.getAttribute("aria-valuemin")).toBe(String(SIDEBAR.min));
    expect(seam.getAttribute("aria-valuemax")).toBe(String(SIDEBAR.max));
  });

  it("moves the pane with the arrow keys, not the seam", async () => {
    // The two point opposite ways: the sidebar grows to the right and the
    // inspector to the left, so one key would widen one and narrow the other
    // if the sign came from the seam rather than from the column.
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const { unmount } = render(<Harness side="before" width={300} onCommit={onCommit} />);
    screen.getByRole("separator").focus();
    await user.keyboard("{ArrowRight}");
    expect(onCommit).toHaveBeenLastCalledWith(316);
    // From where the last press left it, not from the width it was given: a
    // held-down arrow has to keep going, and the prop is a round trip behind
    // while the commit is in flight. The component reads what is drawn.
    await user.keyboard("{ArrowRight}");
    expect(onCommit).toHaveBeenLastCalledWith(332);
    await user.keyboard("{ArrowLeft}");
    expect(onCommit).toHaveBeenLastCalledWith(316);
    unmount();

    onCommit.mockClear();
    render(<Harness side="after" width={300} onCommit={onCommit} />);
    screen.getByRole("separator").focus();
    await user.keyboard("{ArrowLeft}");
    expect(onCommit).toHaveBeenLastCalledWith(316);
  });

  it("stops at the bounds rather than reporting a width nothing can draw", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness side="before" width={SIDEBAR.max} onCommit={onCommit} />);
    screen.getByRole("separator").focus();
    await user.keyboard("{ArrowRight}");
    expect(onCommit).toHaveBeenLastCalledWith(SIDEBAR.max);
  });

  it("goes back to the width the library started at on a double-click", async () => {
    // What a file manager does with a seam, and the way out of a column
    // somebody has dragged into a corner.
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness side="before" width={SIDEBAR.max} onCommit={onCommit} />);
    await user.dblClick(screen.getByRole("separator"));
    expect(onCommit).toHaveBeenLastCalledWith(SIDEBAR.fallback);
    // And the columns are already drawn at it: the property is written before
    // the engine is told, because the engine's answer is a round trip away.
    expect(screen.getByTestId("surface").style.getPropertyValue("--sidebar-width")).toBe(
      `${SIDEBAR.fallback}px`,
    );
  });
});
