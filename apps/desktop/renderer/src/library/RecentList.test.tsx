import type { WireRecentLibrary } from "@roost/contract";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecentList, whenOpened } from "./RecentList.js";

/**
 * The recent list, driven the way a person drives it.
 *
 * The clock is injected rather than stubbed globally: relative times are the
 * part of this with edge cases in it, and a test that moved the whole process's
 * clock to assert one string would be testing `Date` instead.
 */

const NOW = 1_800_000_000;

function entry(over: Partial<WireRecentLibrary> = {}): WireRecentLibrary {
  return {
    root: "/home/you/Holiday.roost",
    name: "Holiday",
    id: "abc",
    openedAt: NOW - 120,
    pinned: false,
    available: true,
    ...over,
  };
}

describe("the recent list", () => {
  const show = (entries: readonly WireRecentLibrary[], busy = false) => {
    const onOpen = vi.fn();
    const onForget = vi.fn();
    const onPin = vi.fn();
    const view = render(
      <RecentList
        entries={entries}
        busy={busy}
        onOpen={onOpen}
        onForget={onForget}
        onPin={onPin}
        now={NOW}
      />,
    );
    return { user: userEvent.setup(), onOpen, onForget, onPin, ...view };
  };

  it("draws nothing at all when there is nothing to draw", () => {
    // An empty heading over an empty box says the feature is broken rather
    // than unused (`UI_SPEC.md` §8).
    const { container } = show([]);
    expect(container.textContent).toBe("");
  });

  it("shows the name, the path, and when it was last opened", () => {
    const { container } = show([entry()]);
    expect(screen.getByText("Holiday")).toBeDefined();
    expect(screen.getByText("2 min ago")).toBeDefined();
    expect(container.querySelector(".recent-path")?.textContent).toContain(
      "/home/you/Holiday.roost",
    );
  });

  it("keeps the path in logical order under the right-to-left truncation", () => {
    // `.recent-path` is laid out `direction: rtl` so a long path loses its
    // uninteresting start rather than its meaningful end. Without the
    // left-to-right mark that also moves a leading `/` to the far end, and the
    // path rendered as `home/you/Holiday.roost/` — seen in a real window, where
    // this was caught, because happy-dom does no bidi and cannot see it.
    const { container } = show([entry()]);
    expect(container.querySelector(".recent-path")?.textContent?.[0]).toBe("\u200e");
  });

  it("opens the library that was clicked", async () => {
    const { user, onOpen } = show([entry()]);
    await user.click(screen.getByRole("button", { name: "Open Holiday" }));
    expect(onOpen).toHaveBeenCalledWith("/home/you/Holiday.roost");
  });

  it("shows a library that has gone, marked and unopenable", async () => {
    // Hiding it would read as the application having forgotten. It stays, says
    // "Missing", and refuses to be opened.
    const { user, onOpen, onForget } = show([entry({ available: false })]);

    expect(screen.getByText("Missing")).toBeDefined();
    const open = screen.getByRole("button", { name: "Open Holiday" });
    expect(open.hasAttribute("disabled")).toBe(true);
    await user.click(open);
    expect(onOpen).not.toHaveBeenCalled();

    // But it can still be taken off the list, which is the whole reason for
    // showing it rather than dropping it.
    await user.click(screen.getByRole("button", { name: "Forget Holiday" }));
    expect(onForget).toHaveBeenCalledWith("/home/you/Holiday.roost");
  });

  it("pins and unpins, and says which state the control is in", async () => {
    const { user, onPin, rerender } = show([entry()]);
    const pin = screen.getByRole("button", { name: "Pin Holiday" });
    expect(pin.getAttribute("aria-pressed")).toBe("false");

    await user.click(pin);
    expect(onPin).toHaveBeenCalledWith("/home/you/Holiday.roost", true);

    rerender(
      <RecentList
        entries={[entry({ pinned: true })]}
        busy={false}
        onOpen={vi.fn()}
        onForget={vi.fn()}
        onPin={onPin}
        now={NOW}
      />,
    );
    expect(screen.getByRole("button", { name: "Unpin Holiday" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("refuses to open anything while the window is busy", async () => {
    const { user, onOpen } = show([entry()], true);
    await user.click(screen.getByRole("button", { name: "Open Holiday" }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("how long ago a library was opened", () => {
  const at = (ago: number) => whenOpened(NOW - ago, NOW);

  it("says what a person would say", () => {
    expect(at(0)).toBe("Just now");
    expect(at(59)).toBe("Just now");
    expect(at(60)).toBe("1 min ago");
    expect(at(59 * 60)).toBe("59 min ago");
    expect(at(60 * 60)).toBe("An hour ago");
    expect(at(3 * 60 * 60)).toBe("3 hours ago");
    expect(at(25 * 60 * 60)).toBe("Yesterday");
    expect(at(3 * 24 * 60 * 60)).toBe("3 days ago");
  });

  it("becomes a date past a week, rather than arithmetic to do in your head", () => {
    // "23 days ago" makes the reader work out when that was.
    const said = at(23 * 24 * 60 * 60);
    expect(said).not.toMatch(/ago/);
    expect(said).toMatch(/\d{4}/);
  });
});
