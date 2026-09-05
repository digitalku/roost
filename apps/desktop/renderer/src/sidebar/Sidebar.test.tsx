import type { SidebarRow, WireSidebar } from "@roost/contract";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Sidebar } from "./Sidebar.js";

function row(over: Partial<SidebarRow> & { name: string; query: string }): SidebarRow {
  return { id: over.id ?? over.name, count: null, depth: 0, group: null, ...over };
}

const SIDEBAR: WireSidebar = {
  places: [
    row({ name: "All assets", query: "" }),
    row({ name: "Favorites", query: "is:favorite" }),
  ],
  ratings: [
    row({ id: "rating-5", name: "5 stars", query: "rating:5", count: 3 }),
    row({ id: "rating-4", name: "4 stars", query: "rating:4", count: 0 }),
  ],
  folders: [
    row({ id: "folder:1", name: "Design", query: 'folder:"Design"', count: 412, depth: 0 }),
    row({ id: "folder:2", name: "Icons", query: 'folder:"Design/Icons"', count: 40, depth: 1 }),
  ],
  smartFolders: [row({ id: "smart:1", name: "Recent PNGs", query: "ext:png" })],
  tags: [
    row({ id: "tag:wood", name: "wood", query: "tag:wood", count: 88, group: "Materials" }),
    row({ id: "tag:metal", name: "metal", query: "tag:metal", count: 41, group: "Materials" }),
    row({ id: "tag:wip", name: "wip", query: "tag:wip", count: 12, group: null }),
  ],
};

describe("the navigation pane", () => {
  it("draws every section it was given, in order", () => {
    render(<Sidebar sidebar={SIDEBAR} query="" onPick={() => {}} />);
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Places",
      "Rating",
      "Folders",
      "Smart folders",
      "Tags · Materials",
      "Tags",
    ]);
  });

  it("counts a rating with none, rather than hiding the row", () => {
    // A row that appears and vanishes with state nothing on screen shows is a
    // row people misread, so every star is drawn and an empty one says `0`.
    render(<Sidebar sidebar={SIDEBAR} query="" onPick={() => {}} />);
    expect(screen.getByRole("button", { name: /5 stars/ }).textContent).toContain("3");
    expect(screen.getByRole("button", { name: /4 stars/ }).textContent).toContain("0");
  });

  it("puts ungrouped tags last, whatever order they arrived in", () => {
    // `UI_SPEC.md` §4.1. The ungrouped pile is the one that needs work, and it
    // reads as a pile rather than as a group with no name.
    const shuffled: WireSidebar = {
      ...SIDEBAR,
      tags: [SIDEBAR.tags[2] as SidebarRow, ...SIDEBAR.tags.slice(0, 2)],
    };
    render(<Sidebar sidebar={shuffled} query="" onPick={() => {}} />);
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings.indexOf("Tags")).toBeGreaterThan(headings.indexOf("Tags · Materials"));
  });

  it("hands over the query it was given, never one it built", async () => {
    // The decision that keeps the search field honest (`UI_SPEC.md` §4.1): the
    // renderer has no `quoteValue` and no business having one.
    const picked: string[] = [];
    render(<Sidebar sidebar={SIDEBAR} query="" onPick={(q) => picked.push(q)} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Icons/ }));
    await user.click(screen.getByRole("button", { name: /wood/ }));
    await user.click(screen.getByRole("button", { name: /All assets/ }));

    expect(picked).toEqual(['folder:"Design/Icons"', "tag:wood", ""]);
  });

  it("shows only the counts it received", () => {
    render(<Sidebar sidebar={SIDEBAR} query="" onPick={() => {}} />);
    expect(screen.getByRole("button", { name: "Design 412" })).toBeDefined();
    // A place carries no count, and the renderer does not invent one: it never
    // counts anything it did not receive.
    expect(screen.getByRole("button", { name: "All assets" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Recent PNGs" })).toBeDefined();
  });

  it("carries the depth the engine gave it, without knowing the tree", () => {
    render(<Sidebar sidebar={SIDEBAR} query="" onPick={() => {}} />);
    const nested = screen.getByRole("button", { name: /Icons/ });
    const top = screen.getByRole("button", { name: /Design/ });
    // The indent is an attribute the stylesheet reads, so the spacing token
    // stays the one source of it — and so a test can assert the depth rather
    // than a pixel value.
    expect(nested.getAttribute("data-depth")).toBe("1");
    expect(top.getAttribute("data-depth")).toBeNull();
  });

  it("marks the row whose query is on screen", () => {
    render(<Sidebar sidebar={SIDEBAR} query="tag:wood" onPick={() => {}} />);
    expect(screen.getByRole("button", { name: /wood/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /metal/ }).getAttribute("aria-current")).toBeNull();
  });

  it("draws no heading for a section that is empty", () => {
    // A library with no smart folders should not have to look at a heading
    // explaining that.
    render(
      <Sidebar
        sidebar={{ places: SIDEBAR.places, ratings: [], folders: [], smartFolders: [], tags: [] }}
        query=""
        onPick={() => {}}
      />,
    );
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Places"]);
  });
});
