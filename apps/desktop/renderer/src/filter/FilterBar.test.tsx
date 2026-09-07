import type { SidebarRow, SidebarTypeRow, WireFacets } from "@roost/contract";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FilterBar } from "./FilterBar.js";

/**
 * The bar over the grid (ADR-0035).
 *
 * What is under test throughout is that it sends **values, never a query**: the
 * grammar has one implementation and it is not in the sandbox. Everything about
 * what those values spell is tested in `@roost/search`'s `facets.test.ts`.
 */

const NONE: WireFacets = { tags: [], stars: [], unrated: false, exts: [] };

function row(over: Partial<SidebarRow>): SidebarRow {
  return {
    id: over.id ?? "x",
    name: over.name ?? "x",
    query: over.query ?? "",
    count: over.count ?? null,
    depth: 0,
    group: over.group ?? null,
    stars: over.stars ?? null,
  };
}

const TAGS: readonly SidebarRow[] = [
  row({ id: "tag:wood", name: "wood", count: 88, group: "Materials" }),
  row({ id: "tag:metal", name: "metal", count: 41, group: "Materials" }),
  row({ id: "tag:wip", name: "wip", count: 12, group: null }),
];

const RATINGS: readonly SidebarRow[] = [
  row({ id: "rating-5", name: "5 stars", count: 3, stars: 5 }),
  row({ id: "rating-4", name: "4 stars", count: 0, stars: 4 }),
  row({ id: "rating-none", name: "No stars", count: 7, stars: 0 }),
];

const TYPES: readonly SidebarTypeRow[] = [
  { ext: "png", count: 412 },
  { ext: "mp4", count: 31 },
  { ext: "", count: 2 },
];

function show(facets: WireFacets = NONE, representable = true) {
  const sent: WireFacets[] = [];
  render(
    <FilterBar
      facets={facets}
      representable={representable}
      tags={TAGS}
      ratings={RATINGS}
      types={TYPES}
      onChange={(next) => sent.push(next)}
    />,
  );
  return { user: userEvent.setup(), sent };
}

const open = async (user: ReturnType<typeof userEvent.setup>, facet: RegExp): Promise<void> => {
  await user.click(screen.getByRole("button", { name: facet }));
};

describe("the filter bar", () => {
  it("offers three facets and nothing else", () => {
    show();
    expect(
      screen.getAllByRole("button").map((button) => button.textContent?.replace("▾", "").trim()),
    ).toEqual(["Tags", "Rating", "Types"]);
  });

  it("draws the counts it was given, and invents none", async () => {
    const { user } = show();
    await open(user, /^Tags/);
    expect((await screen.findByRole("menuitemcheckbox", { name: /wood/ })).textContent).toContain(
      "88",
    );
  });

  it("groups the tags the way the pane did", async () => {
    // A group is how somebody arranged their tags; ninety in a flat list is not
    // a control (`UI_SPEC.md` §4.1).
    const { user } = show();
    await open(user, /^Tags/);
    const menu = await screen.findByRole("menu");
    expect(menu.textContent).toContain("Materials");
    // Ungrouped last, with no heading of its own.
    const items = screen.getAllByRole("menuitemcheckbox").map((item) => item.textContent);
    expect(items.at(-1)).toContain("wip");
  });

  it("sends the value, never a query", async () => {
    const { user, sent } = show();
    await open(user, /^Tags/);
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /wood/ }));
    expect(sent).toEqual([{ tags: ["wood"], stars: [], unrated: false, exts: [] }]);
  });

  it("stays open so a second value can be chosen", async () => {
    // Two tags is the ordinary case, and a menu that closed on the first would
    // make it three gestures instead of one.
    const { user, sent } = show({ ...NONE, tags: ["wood"] });
    await open(user, /^Tags/);
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /metal/ }));
    expect(screen.getByRole("menu")).toBeDefined();
    expect(sent.at(-1)?.tags).toEqual(["wood", "metal"]);
  });

  it("takes a value back off", async () => {
    const { user, sent } = show({ ...NONE, tags: ["wood", "metal"] });
    await open(user, /^Tags/);
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /wood/ }));
    expect(sent.at(-1)?.tags).toEqual(["metal"]);
  });

  it("toggles unrated on its own field, because it is not a rating of zero", async () => {
    // The schema has no zero (`DATA_MODEL.md`), and a bar that pushed a `0` into
    // the stars would ask a question the grammar refuses.
    const { user, sent } = show();
    await open(user, /^Rating/);
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /No stars/ }));
    expect(sent).toEqual([{ tags: [], stars: [], unrated: true, exts: [] }]);
  });

  it("draws a rating as stars and keeps its name for a reader", async () => {
    const { user } = show();
    await open(user, /^Rating/);
    const five = await screen.findByRole("menuitemcheckbox", { name: /5 stars/ });
    expect(five.querySelectorAll(".filter-stars > [data-on]").length).toBe(5);
    expect(five.querySelectorAll(".filter-stars > *").length).toBe(5);
  });

  it("names the extension nobody has, rather than dropping the row", async () => {
    // An asset with no extension is a real answer to what is in the library,
    // and a facet whose counts do not add up is worse than a plain-looking row.
    const { user, sent } = show();
    await open(user, /^Types/);
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /No extension/ }));
    expect(sent.at(-1)?.exts).toEqual([""]);
  });

  it("says what is chosen, not merely that something is", async () => {
    // Three chips that only light up make somebody open all three to find out
    // which one is hiding their assets.
    show({ tags: ["wood", "metal"], stars: [5], unrated: false, exts: [] });
    expect(screen.getByRole("button", { name: /^Tags/ }).textContent).toContain("wood +1");
    expect(screen.getByRole("button", { name: /^Rating/ }).textContent).toContain("★★★★★");
  });

  it("offers Clear only when there is something to clear", async () => {
    const { user, sent } = show({ ...NONE, exts: ["png"] });
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(sent).toEqual([NONE]);
  });

  it("has no Clear when nothing is on", () => {
    show();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("says so when the query is one it cannot show", async () => {
    // A query with a top-level OR filters the grid while every chip reads as
    // off. Three empty chips over two hundred assets is the one state this bar
    // could lie about, so it says it out loud.
    const { user, sent } = show({ ...NONE, tags: ["wood"] }, false);
    expect(screen.getByRole("button", { name: /^Tags/ }).textContent).not.toContain("wood");
    expect(screen.getByText(/cannot show/)).toBeDefined();

    // And choosing something still works: it adds, rather than claiming to own
    // what is already there.
    await open(user, /^Types/);
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /PNG/ }));
    expect(sent.at(-1)).toEqual({ tags: [], stars: [], unrated: false, exts: ["png"] });
  });

  it("says a facet is empty rather than opening onto nothing", async () => {
    const sent: WireFacets[] = [];
    render(
      <FilterBar
        facets={NONE}
        representable
        tags={[]}
        ratings={RATINGS}
        types={[]}
        onChange={(next) => sent.push(next)}
      />,
    );
    const user = userEvent.setup();
    await open(user, /^Tags/);
    await waitFor(() => expect(screen.getByText("No tags yet")).toBeDefined());
  });
});
