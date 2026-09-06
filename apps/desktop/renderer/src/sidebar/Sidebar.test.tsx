import type { SidebarFolderRow, SidebarRow, WireSidebar } from "@roost/contract";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useExpansion } from "./expansion.js";
import { Sidebar, type SidebarProps } from "./Sidebar.js";

function row(over: Partial<SidebarRow> & { name: string; query: string }): SidebarRow {
  return { id: over.id ?? over.name, count: null, depth: 0, group: null, stars: null, ...over };
}

/** A folder's row, which carries the id and the path only it has. */
function folderRow(
  over: Partial<SidebarFolderRow> & { folder: number; name: string; path: string },
): SidebarFolderRow {
  return {
    ...row({ ...over, query: over.query ?? `folder:"${over.path}"` }),
    folder: over.folder,
    path: over.path,
  };
}

const SIDEBAR: WireSidebar = {
  places: [row({ name: "All assets", query: "" })],
  ratings: [
    row({ id: "rating-5", name: "5 stars", query: "rating:5", count: 3, stars: 5 }),
    row({ id: "rating-4", name: "4 stars", query: "rating:4", count: 0, stars: 4 }),
    row({ id: "rating-none", name: "No stars", query: "is:unrated", count: 7, stars: 0 }),
  ],
  folders: [
    folderRow({ id: "folder:1", folder: 1, name: "Design", path: "Design", count: 412, depth: 0 }),
    folderRow({
      id: "folder:2",
      folder: 2,
      name: "Icons",
      path: "Design/Icons",
      count: 40,
      depth: 1,
    }),
  ],
  smartFolders: [row({ id: "smart:1", name: "Recent PNGs", query: "ext:png" })],
  tags: [
    row({ id: "tag:wood", name: "wood", query: "tag:wood", count: 88, group: "Materials" }),
    row({ id: "tag:metal", name: "metal", query: "tag:metal", count: 41, group: "Materials" }),
    row({ id: "tag:wip", name: "wip", query: "tag:wip", count: 12, group: null }),
  ],
};

/**
 * The pane with a live expansion state, which is what the window gives it.
 *
 * A stub would have made the collapse tests assert against their own fixture
 * rather than against the component: the branch that opens has to be the one
 * the arrow was pressed on.
 */
function Pane({
  sidebar = SIDEBAR,
  query = "",
  onPick = () => {},
  onNewFolder = () => {},
  onRenameFolder = () => {},
  onDeleteFolder = () => {},
}: Partial<Omit<SidebarProps, "expansion">>): React.JSX.Element {
  const expansion = useExpansion();
  return (
    <Sidebar
      sidebar={sidebar}
      query={query}
      onPick={onPick}
      expansion={expansion}
      onNewFolder={onNewFolder}
      onRenameFolder={onRenameFolder}
      onDeleteFolder={onDeleteFolder}
    />
  );
}

describe("the navigation pane", () => {
  it("draws every section it was given, in order", () => {
    render(<Pane />);
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Places",
      "Rating",
      // The `+` is part of the heading, which is where the only way to make a
      // folder lives (ADR-0033).
      "Folders+",
      "Smart folders",
      "Tags · Materials",
      "Tags",
    ]);
  });

  it("counts a rating with none, rather than hiding the row", () => {
    // A row that appears and vanishes with state nothing on screen shows is a
    // row people misread, so every star is drawn and an empty one says `0`.
    render(<Pane />);
    expect(screen.getByRole("button", { name: /5 stars/ }).textContent).toContain("3");
    expect(screen.getByRole("button", { name: /4 stars/ }).textContent).toContain("0");
  });

  it("draws a rating as stars, and keeps its name for the accessible tree", () => {
    // The eye gets a shape it can compare down a column; a screen reader gets
    // the sentence the row used to read. Five are always drawn, so the rows
    // line up as one scale rather than as a staircase.
    render(<Pane />);

    const lit = (name: RegExp): number =>
      screen.getByRole("button", { name }).querySelectorAll(".sidebar-stars > [data-on]").length;
    const drawn = (name: RegExp): number =>
      screen.getByRole("button", { name }).querySelectorAll(".sidebar-stars > *").length;

    expect(lit(/5 stars/)).toBe(5);
    expect(lit(/4 stars/)).toBe(4);
    // Unrated is the same shape with nothing lit — not a rating of zero, which
    // the schema does not have.
    expect(lit(/No stars/)).toBe(0);
    expect(drawn(/No stars/)).toBe(5);
  });

  it("leaves every other row a name rather than a shape", () => {
    render(<Pane />);
    expect(
      screen.getByRole("button", { name: /All assets/ }).querySelector(".sidebar-stars"),
    ).toBeNull();
  });

  it("puts ungrouped tags last, whatever order they arrived in", () => {
    // `UI_SPEC.md` §4.1. The ungrouped pile is the one that needs work, and it
    // reads as a pile rather than as a group with no name.
    const shuffled: WireSidebar = {
      ...SIDEBAR,
      tags: [SIDEBAR.tags[2] as SidebarRow, ...SIDEBAR.tags.slice(0, 2)],
    };
    render(<Pane sidebar={shuffled} />);
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings.indexOf("Tags")).toBeGreaterThan(headings.indexOf("Tags · Materials"));
  });

  it("hands over the query it was given, never one it built", async () => {
    // The decision that keeps the search field honest (`UI_SPEC.md` §4.1): the
    // renderer has no `quoteValue` and no business having one.
    const picked: string[] = [];
    render(<Pane onPick={(q) => picked.push(q)} />);
    const user = userEvent.setup();

    // `Icons` is inside `Design`, and a branch starts closed — so the arrow is
    // pressed first, which is the gesture a person makes too.
    await user.click(screen.getByRole("button", { name: "Expand Design" }));
    await user.click(screen.getByRole("button", { name: /Icons/ }));
    await user.click(screen.getByRole("button", { name: /wood/ }));
    await user.click(screen.getByRole("button", { name: /All assets/ }));

    expect(picked).toEqual(['folder:"Design/Icons"', "tag:wood", ""]);
  });

  it("shows only the counts it received", () => {
    render(<Pane />);
    expect(screen.getByRole("button", { name: "Design 412" })).toBeDefined();
    // A place carries no count, and the renderer does not invent one: it never
    // counts anything it did not receive.
    expect(screen.getByRole("button", { name: "All assets" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Recent PNGs" })).toBeDefined();
  });

  it("carries the depth the engine gave it, without knowing the tree", async () => {
    render(<Pane />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Expand Design" }));

    // The indent is an attribute the stylesheet reads, so the spacing token
    // stays the one source of it — and so a test can assert the depth rather
    // than a pixel value. It is on the branch rather than on the row, because
    // the disclosure arrow is a sibling of the row and both move together.
    const branch = (name: RegExp): Element | null =>
      screen.getByRole("button", { name }).closest(".sidebar-branch");
    expect(branch(/Icons/)?.getAttribute("data-depth")).toBe("1");
    expect(branch(/^Design/)?.getAttribute("data-depth")).toBeNull();
  });

  it("starts collapsed, and an arrow opens exactly one branch", async () => {
    // The pane the user showed on 2026-09-06 was a hundred folders drawn flat.
    // A closed branch still says how much is under it, because the count is the
    // subtree's (`UI_SPEC.md` §4.1).
    render(<Pane />);
    const user = userEvent.setup();

    expect(screen.queryByRole("button", { name: /Icons/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Design 412" })).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Expand Design" }));
    expect(screen.getByRole("button", { name: /Icons/ })).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Collapse Design" }));
    expect(screen.queryByRole("button", { name: /Icons/ })).toBeNull();
  });

  it("gives a leaf no arrow, rather than one that does nothing", () => {
    render(<Pane />);
    // `Design` has a child and `Recent PNGs` is not a folder at all; the row
    // that must not have one is the folder with nothing under it.
    expect(screen.queryByRole("button", { name: /Expand Icons/ })).toBeNull();
  });

  it("raises the three folder commands and runs none of them", async () => {
    // The pane owns no dialog: each of these opens one, and the window has the
    // one dialog it can have at a time (ADR-0033).
    const made: (string | null)[] = [];
    const renamed: string[] = [];
    const deleted: string[] = [];
    render(
      <Pane
        onNewFolder={(parent) => made.push(parent?.path ?? null)}
        onRenameFolder={(folder) => renamed.push(folder.path)}
        onDeleteFolder={(folder) => deleted.push(folder.path)}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "New folder" }));
    expect(made).toEqual([null]);

    // Dispatched rather than driven through `userEvent`: Radix opens on a
    // `contextmenu` event, which happy-dom does not synthesise from a right
    // click.
    const design = screen.getByRole("button", { name: "Design 412" });
    design.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");

    await user.click(screen.getByRole("menuitem", { name: "New subfolder…" }));
    expect(made).toEqual([null, "Design"]);

    design.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: "Delete folder…" }));
    expect(deleted).toEqual(["Design"]);
    expect(renamed).toEqual([]);
  });

  it("marks the row whose query is on screen", () => {
    render(<Pane query="tag:wood" />);
    expect(screen.getByRole("button", { name: /wood/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /metal/ }).getAttribute("aria-current")).toBeNull();
  });

  it("draws no heading for a section that is empty", () => {
    // A library with no smart folders should not have to look at a heading
    // explaining that.
    render(
      <Pane
        sidebar={{ places: SIDEBAR.places, ratings: [], folders: [], smartFolders: [], tags: [] }}
      />,
    );
    // Folders is the exception, and its heading is why: the `+` in it is the
    // only way to make the first folder (ADR-0033).
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Places",
      "Folders+",
    ]);
  });
});
