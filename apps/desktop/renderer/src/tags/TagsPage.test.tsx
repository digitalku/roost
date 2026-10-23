import type { WireTagList } from "@roost/contract";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App.js";
import { FakeEngine, fakeAsset, install } from "../testing/fake-engine.js";

/**
 * The tags page (ADR-0061), driven through the window: the sidebar row that
 * opens it, the groups and the tags, and what each gesture sends. Everything it
 * draws is read back from the engine after the edit, which the fake models.
 */

const HOLIDAY = "/home/you/Holiday Photos.roost";

const LIST: WireTagList = {
  groups: [{ id: 1, name: "Materials", tags: 1 }],
  tags: [
    { name: "olahraga", query: "tag:olahraga", group: null, count: 12 },
    { name: "traveling", query: "tag:traveling", group: null, count: 4 },
    { name: "wood", query: "tag:wood", group: 1, count: 88 },
  ],
};

const open = async (tagList: WireTagList = LIST) => {
  const engine = new FakeEngine({
    openLibraryDialog: HOLIDAY,
    existing: [{ root: HOLIDAY, name: "Holiday Photos" }],
    stats: { assets: 3 },
    assets: Array.from({ length: 3 }, (_, i) => fakeAsset(i)),
    sidebar: {
      places: [
        {
          id: "all",
          name: "All assets",
          query: "",
          count: null,
          depth: 0,
          group: null,
          stars: null,
        },
        {
          id: "untagged",
          name: "Untagged",
          query: "is:untagged",
          count: null,
          depth: 0,
          group: null,
          stars: null,
        },
      ],
      ratings: [],
      folders: [],
      smartFolders: [],
      tags: tagList.tags.map((tag) => ({
        id: `tag:${tag.name}`,
        name: tag.name,
        query: tag.query,
        count: tag.count,
        depth: 0,
        group: null,
        stars: null,
      })),
      types: [],
    },
    tagList,
  });
  install(engine);
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Open library…" }));
  await screen.findByRole("heading", { name: "Holiday Photos" });
  await user.click(screen.getByRole("button", { name: /^Tags\s*3$/ }));
  await screen.findByRole("region", { name: "Tags" });
  return { engine, user };
};

const tags = (): string[] =>
  within(screen.getByRole("listbox"))
    .queryAllByRole("option")
    .map((row) => row.querySelector(".tags-name")?.textContent ?? "");

const sent = (engine: FakeEngine, type: string) =>
  engine.seen.filter((request) => request.type === type);

describe("the tags page", () => {
  it("takes the grid's place from a row under Untagged, and gives it back", async () => {
    const { user } = await open();
    // The grid, its filter bar and the inspector are all away.
    expect(screen.queryByRole("toolbar", { name: "Filters" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Tags\s*3$/ }).getAttribute("aria-current")).toBe(
      "true",
    );
    expect(tags()).toEqual(["olahraga", "traveling", "wood"]);

    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Tags" })).toBeNull());
    expect(screen.getByRole("toolbar", { name: "Filters" })).toBeDefined();
  });

  it("lists a group's tags, the ungrouped, or every one", async () => {
    const { user } = await open();
    const groups = screen.getByRole("navigation", { name: "Tag groups" });
    await user.click(within(groups).getByRole("button", { name: /Materials/ }));
    expect(tags()).toEqual(["wood"]);
    await user.click(within(groups).getByRole("button", { name: /Ungrouped/ }));
    expect(tags()).toEqual(["olahraga", "traveling"]);
    await user.type(screen.getByRole("searchbox", { name: "Search tags" }), "trav");
    expect(tags()).toEqual(["traveling"]);
  });

  it("orders by how many assets carry a tag when asked", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Order: Most used" }));
    expect(tags()).toEqual(["wood", "olahraga", "traveling"]);
  });

  it("makes a group, and says why a second of one name is refused", async () => {
    const { engine, user } = await open();
    await user.click(screen.getByRole("button", { name: "+ New group" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "materials");
    await user.click(screen.getByRole("button", { name: "Create" }));
    // Kept open, with the name still there to correct.
    expect((await screen.findByRole("alert")).textContent).toContain("already exists");

    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Sports");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(engine.tagList.groups.map((group) => group.name)).toContain("Sports"),
    );
    // A group made from + New group is the one shown next.
    await waitFor(() =>
      expect(screen.getByRole("listbox").getAttribute("aria-label")).toBe("Sports"),
    );
  });

  it("moves the chosen tags into a group from the menu", async () => {
    const { engine, user } = await open();
    const rows = within(screen.getByRole("listbox")).getAllByRole("option");
    await user.click(rows[0] as HTMLElement);
    await user.keyboard("{Control>}");
    await user.click(rows[1] as HTMLElement);
    await user.keyboard("{/Control}");
    await user.pointer({ keys: "[MouseRight]", target: rows[1] as HTMLElement });
    // A submenu opens on a click here, as the view menu's Sort By does in
    // `App.test.tsx`. Its item is clicked without moving the pointer: with no
    // geometry, Radix reads any move as leaving for elsewhere and closes the
    // submenu first. `check-tags.mjs` drives the real pointer.
    await user.click(await screen.findByRole("menuitem", { name: /Move to group/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Materials/ }));
    expect(sent(engine, "tag:group").at(-1)).toMatchObject({
      tags: ["olahraga", "traveling"],
      group: 1,
    });
    await waitFor(() =>
      expect(engine.tagList.tags.filter((tag) => tag.group === 1)).toHaveLength(3),
    );
  });

  it("says a rename onto a tag that exists is a merge, before it is one", async () => {
    const { engine, user } = await open();
    await user.click(within(screen.getByRole("listbox")).getAllByRole("option")[1] as HTMLElement);
    await user.keyboard("{F2}");
    const field = screen.getByRole("textbox", { name: "Name" });
    await user.clear(field);
    await user.type(field, "Olahraga");
    expect(screen.getByText(/already exists/)).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Merge" }));
    expect(sent(engine, "tag:rename").at(-1)).toMatchObject({ from: "traveling", to: "Olahraga" });
    await waitFor(() => expect(tags()).toEqual(["olahraga", "wood"]));
  });

  it("deletes the chosen tags after asking, and never the grid's selection", async () => {
    const { engine, user } = await open();
    await user.click(within(screen.getByRole("listbox")).getAllByRole("option")[2] as HTMLElement);
    await user.keyboard("{Delete}");
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("88 assets");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(sent(engine, "tag:delete").at(-1)).toMatchObject({ tags: ["wood"] });
    // `Delete` on the window trashes the grid's selection; on this page it
    // must not have reached it.
    expect(sent(engine, "assets:trash")).toEqual([]);
    await waitFor(() => expect(tags()).toEqual(["olahraga", "traveling"]));
  });

  it("leaves for the grid, showing what carries a tag, on a double-click", async () => {
    const { user } = await open();
    await user.dblClick(
      within(screen.getByRole("listbox")).getAllByRole("option")[0] as HTMLElement,
    );
    await waitFor(() => expect(screen.queryByRole("region", { name: "Tags" })).toBeNull());
    expect(screen.getByRole("searchbox", { name: /Search/ })).toHaveProperty(
      "value",
      "tag:olahraga",
    );
  });
});
