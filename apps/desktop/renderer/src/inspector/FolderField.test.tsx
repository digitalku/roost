import type { SidebarFolderRow } from "@roost/contract";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FolderField } from "./FolderField.js";

/**
 * The folder menu, driven the way a person drives it.
 *
 * The tree the user showed on 2026-09-09 is the fixture: three accounts with
 * the same four subfolders under each, which is the shape that made the menu
 * taller than the window and made a name in it worth searching for.
 */

const TREE: readonly SidebarFolderRow[] = [
  row(1, "ig oskasmanla", "ig oskasmanla", 0),
  row(2, "highlights", "ig oskasmanla/highlights", 1),
  row(3, "post", "ig oskasmanla/post", 1),
  row(4, "reels", "ig oskasmanla/reels", 1),
  row(5, "story", "ig oskasmanla/story", 1),
  row(6, "ig paskibra.foursta", "ig paskibra.foursta", 0),
  row(7, "highlights", "ig paskibra.foursta/highlights", 1),
  row(8, "post", "ig paskibra.foursta/post", 1),
  row(9, "tagged", "ig paskibra.foursta/tagged", 1),
  row(10, "kucing", "kucing", 0),
];

/** Under the threshold the field is not drawn, so the small tree is separate. */
const SMALL: readonly SidebarFolderRow[] = TREE.slice(0, 3);

function row(folder: number, name: string, path: string, depth: number): SidebarFolderRow {
  return {
    id: `folder:${folder}`,
    name,
    query: `folder:"${path}"`,
    count: null,
    depth,
    group: null,
    stars: null,
    folder,
    path,
  };
}

const labels = (): string[] =>
  screen.getAllByRole("menuitem").map((item) => item.textContent?.trim() ?? "");

const show = async (tree: readonly SidebarFolderRow[] = TREE) => {
  const onAdd = vi.fn();
  render(<FolderField tree={tree} attached={[]} onAdd={onAdd} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Add to folder" }));
  await screen.findByRole("menu");
  return { user, onAdd };
};

describe("searching the folder menu", () => {
  it("does not cost a row on a tree short enough to read", async () => {
    await show(SMALL);
    expect(screen.queryByLabelText("Search folders")).toBeNull();
  });

  it("is drawn past a listful of folders", async () => {
    await show();
    expect(screen.getByLabelText("Search folders")).toBeDefined();
  });

  it("keeps the tree's shape, so two folders of one name stay apart", async () => {
    const { user } = await show();
    await user.type(screen.getByLabelText("Search folders"), "post");
    // Both `post` folders, each under the account that holds it — the ancestors
    // come along as context, and no other subfolder does.
    expect(labels()).toEqual(["ig oskasmanla", "post", "ig paskibra.foursta", "post"]);
  });

  it("brings a matched folder's own subtree along with nothing else", async () => {
    const { user } = await show();
    await user.type(screen.getByLabelText("Search folders"), "kucing");
    expect(labels()).toEqual(["kucing"]);
  });

  it("says so rather than drawing an empty menu", async () => {
    const { user } = await show();
    await user.type(screen.getByLabelText("Search folders"), "nowhere");
    // Not a `menuitem`: there is nothing to choose, and a disabled row the
    // keyboard walks onto would be a dead stop in the list.
    expect(screen.queryAllByRole("menuitem")).toEqual([]);
    expect(screen.getByText("Nothing matches")).toBeDefined();
  });

  it("still files into the folder a search found", async () => {
    const { user, onAdd } = await show();
    await user.type(screen.getByLabelText("Search folders"), "tagged");
    await user.click(screen.getByRole("menuitem", { name: "tagged" }));
    expect(onAdd).toHaveBeenCalledWith(9);
  });

  it("forgets the needle between two openings", async () => {
    const { user } = await show();
    await user.type(screen.getByLabelText("Search folders"), "kucing");
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Add to folder" }));
    await screen.findByRole("menu");
    expect(labels()).toHaveLength(TREE.length);
    expect((screen.getByLabelText("Search folders") as HTMLInputElement).value).toBe("");
  });
});
