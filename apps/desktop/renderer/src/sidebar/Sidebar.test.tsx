import type { SidebarFolderRow, SidebarRow, WireSidebar } from "@roost/contract";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ASSET_DRAG_TYPE, FOLDER_DRAG_TYPE } from "../dnd.js";
import { useExpansion } from "./expansion.js";
import { found, Sidebar, type SidebarProps } from "./Sidebar.js";

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
    descendants: over.descendants ?? 0,
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
  types: [
    { ext: "png", count: 412 },
    { ext: "jpg", count: 188 },
  ],
};

/**
 * Fires a drag event carrying a payload and a modifier.
 *
 * Built through `createEvent` rather than dispatched by hand, because React
 * routes its own synthetic events and a bare `new Event("dragover")` never
 * reaches `onDragOver`. `ctrlKey` is then defined on it: happy-dom's
 * `DragEvent` takes no `MouseEventInit`, so passing it to `fireEvent` leaves it
 * `undefined` — and a test asserting on the flag would pass for the wrong
 * reason, which is how it failed first.
 */
function drag(
  target: HTMLElement,
  type: string,
  dataTransfer: DataTransfer,
  ctrlKey = false,
): void {
  const event = createEvent[type === "drop" ? "drop" : "dragOver"](target, { dataTransfer });
  Object.defineProperty(event, "ctrlKey", { value: ctrlKey });
  fireEvent(target, event);
}

/** The branch a folder row sits in, which is the drop target and the drag source. */
function branchOf(name: string | RegExp): HTMLElement {
  const branch = screen.getByRole("button", { name }).closest(".sidebar-branch");
  if (!(branch instanceof HTMLElement)) throw new Error(`no branch for ${String(name)}`);
  return branch;
}

/**
 * A `dataTransfer` carrying what a drag inside the window carries.
 *
 * happy-dom has no drag-and-drop, so the object is built by hand — which is
 * enough, because what these tests are about is the decision a target makes
 * from the types and the payload.
 */
function transfer(data: Record<string, string>): DataTransfer {
  return {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? "",
    setData: () => {},
    dropEffect: "none",
    effectAllowed: "all",
  } as unknown as DataTransfer;
}

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
  onDropAssets = () => {},
  onMoveFolder = () => {},
  onEmptyTrash = () => {},
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
      onDropAssets={onDropAssets}
      onMoveFolder={onMoveFolder}
      onEmptyTrash={onEmptyTrash}
    />
  );
}

describe("the navigation pane", () => {
  it("draws every section it was given, in order", () => {
    render(<Pane />);
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Places",
      // The `+` is part of the heading, which is where the only way to make a
      // folder lives (ADR-0033).
      "Folders+",
      "Smart folders",
    ]);
  });

  it("draws no rating and no tag rows, whatever it was sent", () => {
    // They moved to the filter bar on 2026-09-07 (ADR-0035), and the sidebar
    // still receives both — the bar needs the same counts and the inspector
    // suggests from the same tags. What is under test is that the *pane* has
    // stopped drawing them, not that the engine stopped sending them.
    render(<Pane />);
    expect(SIDEBAR.ratings.length).toBe(3);
    expect(SIDEBAR.tags.length).toBe(3);
    expect(screen.queryByRole("button", { name: /5 stars/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /wood/ })).toBeNull();
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
    await user.click(screen.getByRole("button", { name: /All assets/ }));

    expect(picked).toEqual(['folder:"Design/Icons"', ""]);
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

  it("takes a drop of assets, and says whether Ctrl was held", () => {
    // `UI_SPEC.md` §4.3. The pane reports the gesture; the *window* decides
    // whether it is a move, because only it knows what is on screen.
    const dropped: { folder: string; hashes: readonly string[]; copy: boolean }[] = [];
    render(
      <Pane
        onDropAssets={(folder, hashes, copy) => dropped.push({ folder: folder.path, hashes, copy })}
      />,
    );

    const design = branchOf("Design 412");
    const carrying = transfer({ [ASSET_DRAG_TYPE]: JSON.stringify(["a".repeat(64)]) });

    drag(design, "dragover", carrying);
    expect(design.hasAttribute("data-over")).toBe(true);

    drag(design, "drop", carrying, true);
    expect(dropped).toEqual([{ folder: "Design", hashes: ["a".repeat(64)], copy: true }]);
    // The highlight is a property of the drag, so it goes with it.
    expect(design.hasAttribute("data-over")).toBe(false);
  });

  it("refuses a folder dropped on itself, and takes one dropped on another", () => {
    const moves: [number, number | null][] = [];
    render(<Pane onMoveFolder={(folder, parent) => moves.push([folder, parent])} />);
    const design = branchOf("Design 412");
    const itself = transfer({ [FOLDER_DRAG_TYPE]: "1" });
    drag(design, "dragover", itself);
    // Not a target for itself, so nothing lights up and nothing is offered.
    expect(design.hasAttribute("data-over")).toBe(false);
    drag(design, "drop", itself);
    expect(moves).toEqual([]);

    const other = transfer({ [FOLDER_DRAG_TYPE]: "2" });
    drag(design, "dragover", other);
    expect(design.hasAttribute("data-over")).toBe(true);
    drag(design, "drop", other);
    expect(moves).toEqual([[2, 1]]);
  });

  it("takes a folder dropped on the heading as a move to the top level", () => {
    const moves: [number, number | null][] = [];
    render(<Pane onMoveFolder={(folder, parent) => moves.push([folder, parent])} />);

    const heading = screen.getByRole("heading", { name: /Folders/ });
    const carrying = transfer({ [FOLDER_DRAG_TYPE]: "2" });
    drag(heading, "dragover", carrying);
    drag(heading, "drop", carrying);
    expect(moves).toEqual([[2, null]]);

    // Assets have no business at the top level: they live in folders, and it
    // is not one.
    const assets = transfer({ [ASSET_DRAG_TYPE]: JSON.stringify(["a".repeat(64)]) });
    drag(heading, "dragover", assets);
    expect(heading.hasAttribute("data-over")).toBe(false);
  });

  it("offers Move to top level only where there is somewhere to move from", async () => {
    // The keyboard's half of dragging onto the heading. Disabled rather than
    // absent on a folder already at the top: a menu that changes shape between
    // two rows is one nobody learns.
    const moves: [number, number | null][] = [];
    render(<Pane onMoveFolder={(folder, parent) => moves.push([folder, parent])} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Expand Design" }));
    const icons = screen.getByRole("button", { name: /Icons/ });
    icons.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: "Move to top level" }));
    expect(moves).toEqual([[2, null]]);

    const design = screen.getByRole("button", { name: "Design 412" });
    design.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");
    expect(
      screen.getByRole("menuitem", { name: "Move to top level" }).getAttribute("aria-disabled"),
    ).toBe("true");
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

  it("offers Empty trash from the Trash row, and runs nothing itself", async () => {
    // Asked for 2026-09-08, with a screenshot of the row: the command was in
    // the grid's menu only, which means reaching it required standing in the
    // Trash place first. The pane raises it and owns no dialog, exactly as the
    // three folder commands do.
    let asked = 0;
    render(
      <Pane
        sidebar={{
          ...SIDEBAR,
          places: [
            row({ name: "All assets", query: "" }),
            row({ id: "trash", name: "Trash", query: "is:trashed", count: 2 }),
          ],
        }}
        onEmptyTrash={() => {
          asked += 1;
        }}
      />,
    );
    const user = userEvent.setup();

    const trash = screen.getByRole("button", { name: "Trash 2" });
    trash.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");

    await user.click(screen.getByRole("menuitem", { name: "Empty trash" }));
    expect(asked).toBe(1);
  });

  it("draws Empty trash dead while the trash is empty", async () => {
    render(
      <Pane
        sidebar={{
          ...SIDEBAR,
          places: [row({ id: "trash", name: "Trash", query: "is:trashed", count: 0 })],
        }}
      />,
    );

    const trash = screen.getByRole("button", { name: "Trash 0" });
    trash.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");
    // Dead rather than absent: a menu whose one item comes and goes is one
    // nobody learns.
    expect(
      screen.getByRole("menuitem", { name: "Empty trash" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("gives the other places no menu at all", async () => {
    render(<Pane />);
    const all = screen.getByRole("button", { name: /All assets/ });
    all.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("marks the row whose query is on screen", () => {
    render(<Pane query="" />);
    expect(screen.getByRole("button", { name: /All assets/ }).getAttribute("aria-current")).toBe(
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Recent PNGs" }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("draws no heading for a section that is empty", () => {
    // A library with no smart folders should not have to look at a heading
    // explaining that.
    render(
      <Pane
        sidebar={{
          places: SIDEBAR.places,
          ratings: [],
          folders: [],
          smartFolders: [],
          tags: [],
          types: [],
        }}
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

/**
 * A tree deep enough to search: two branches holding a match apiece, one
 * branch holding none, and a match with a child of its own.
 *
 * ```
 * Clients          Archive          Zebra
 *   Acme             Old logos
 *     Logos
 *       Draft
 *   Billing
 * ```
 */
const DEEP: readonly SidebarFolderRow[] = [
  folderRow({ id: "f1", folder: 1, name: "Clients", path: "Clients", depth: 0 }),
  folderRow({ id: "f2", folder: 2, name: "Acme", path: "Clients/Acme", depth: 1 }),
  folderRow({ id: "f3", folder: 3, name: "Logos", path: "Clients/Acme/Logos", depth: 2 }),
  folderRow({ id: "f4", folder: 4, name: "Draft", path: "Clients/Acme/Logos/Draft", depth: 3 }),
  folderRow({ id: "f5", folder: 5, name: "Billing", path: "Clients/Billing", depth: 1 }),
  folderRow({ id: "f6", folder: 6, name: "Archive", path: "Archive", depth: 0 }),
  folderRow({ id: "f7", folder: 7, name: "Old logos", path: "Archive/Old logos", depth: 1 }),
  folderRow({ id: "f8", folder: 8, name: "Zebra", path: "Zebra", depth: 0 }),
];

const DEEP_SIDEBAR: WireSidebar = { ...SIDEBAR, folders: DEEP };

/** Every folder row on screen, deepest-marked, in the order it is drawn. */
function treeOnScreen(): string[] {
  return [...document.querySelectorAll(".sidebar-branch")].map((branch) => {
    const name = branch.querySelector(".sidebar-label")?.textContent ?? "";
    return branch.hasAttribute("data-context") ? `(${name})` : name;
  });
}

describe("searching the folder tree", () => {
  it("keeps the field shut until the magnifier is pressed, then takes the caret", async () => {
    render(<Pane sidebar={DEEP_SIDEBAR} />);
    const user = userEvent.setup();
    expect(screen.queryByRole("searchbox", { name: "Search folders" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Search folders" }));

    const field = screen.getByRole("searchbox", { name: "Search folders" });
    // A field that has to be clicked before it can be typed into is two
    // gestures for one intention, and the magnifier was the first of them.
    expect(document.activeElement).toBe(field);
  });

  it("keeps the tree's shape, bringing every folder on the path to a match", async () => {
    render(<Pane sidebar={DEEP_SIDEBAR} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Search folders" }));
    await user.type(screen.getByRole("searchbox", { name: "Search folders" }), "logos");

    // `Clients`, `Acme` and `Archive` are drawn only because something under
    // them matched, so they are marked as context. `Draft` is under a match
    // and does not come along — which is what stops a needle matching near the
    // root from redrawing the whole pane.
    expect(treeOnScreen()).toEqual(["(Clients)", "(Acme)", "Logos", "(Archive)", "Old logos"]);
  });

  it("draws the disclosure as a mark rather than a control while searching", async () => {
    render(<Pane sidebar={DEEP_SIDEBAR} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Search folders" }));
    await user.type(screen.getByRole("searchbox", { name: "Search folders" }), "logos");

    // A branch is drawn here only because something under it matched, so the
    // one thing closing it could do is hide the reason it is there.
    expect(screen.queryByRole("button", { name: /Collapse|Expand/ })).toBeNull();
    expect(document.querySelectorAll(".sidebar-twisty[data-open]").length).toBe(3);
  });

  it("says so when nothing matches, rather than drawing a heading over nothing", async () => {
    render(<Pane sidebar={DEEP_SIDEBAR} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Search folders" }));
    await user.type(screen.getByRole("searchbox", { name: "Search folders" }), "nowhere");

    expect(treeOnScreen()).toEqual([]);
    expect(screen.getByText("Nothing matches")).toBeDefined();
  });

  it("gives the expansion back untouched when the field is closed", async () => {
    render(<Pane sidebar={DEEP_SIDEBAR} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Expand Clients" }));
    expect(treeOnScreen()).toEqual(["Clients", "Acme", "Billing", "Archive", "Zebra"]);

    await user.click(screen.getByRole("button", { name: "Search folders" }));
    await user.type(screen.getByRole("searchbox", { name: "Search folders" }), "logos");
    await user.keyboard("{Escape}");

    // Escape closes the field, and the pane is exactly where it was left:
    // `Clients` open, `Acme` still closed, so `Logos` is not drawn.
    expect(screen.queryByRole("searchbox", { name: "Search folders" })).toBeNull();
    expect(treeOnScreen()).toEqual(["Clients", "Acme", "Billing", "Archive", "Zebra"]);
  });

  it("clears the needle when a folder command is raised, keeping the field", async () => {
    // A new subfolder whose name does not match the needle would be made and
    // then not drawn, which reads as the command having failed.
    const made: (SidebarFolderRow | null)[] = [];
    render(<Pane sidebar={DEEP_SIDEBAR} onNewFolder={(parent) => made.push(parent)} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Search folders" }));
    await user.type(screen.getByRole("searchbox", { name: "Search folders" }), "logos");

    await user.click(screen.getByRole("button", { name: "New folder" }));

    expect(made).toEqual([null]);
    expect(screen.getByRole("searchbox", { name: "Search folders" })).toHaveProperty("value", "");
    expect(treeOnScreen()).toEqual(["Clients", "Archive", "Zebra"]);
  });

  it("offers no magnifier where there is nothing to search", () => {
    render(<Pane sidebar={{ ...SIDEBAR, folders: [] }} />);
    // The heading is drawn on an empty section solely so `+` has somewhere to
    // live; a magnifier there could only ever answer "nothing matches".
    expect(screen.queryByRole("button", { name: "Search folders" })).toBeNull();
    expect(screen.getByRole("button", { name: "New folder" })).toBeDefined();
  });
});

describe("found", () => {
  const shape = (needle: string): string[] =>
    found(DEEP, needle).map(
      ({ row, hasChildren, isContext }) =>
        `${isContext ? "-" : "+"}${row.depth}:${row.name}${hasChildren ? "*" : ""}`,
    );

  it("returns the matches and their ancestors, in depth-first order", () => {
    expect(shape("logos")).toEqual([
      "-0:Clients*",
      "-1:Acme*",
      "+2:Logos",
      "-0:Archive*",
      "+1:Old logos",
    ]);
  });

  it("matches without regard to case, and ignores the ends", () => {
    expect(shape("  ZEBRA ")).toEqual(["+0:Zebra"]);
  });

  it("marks a folder as having children by what is drawn, not by what exists", () => {
    // `Acme` has `Logos` under it and `Logos` has `Draft`, but a match's own
    // subtree does not come along — so `Logos` is drawn as a leaf here.
    expect(shape("acme")).toEqual(["-0:Clients*", "+1:Acme"]);
  });

  it("finds nothing where nothing matches", () => {
    expect(found(DEEP, "nowhere")).toEqual([]);
  });
});
