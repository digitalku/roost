import type { SidebarRow, SidebarTypeRow, WireFacets } from "@roost/contract";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FilterBar } from "./FilterBar.js";
import type { FacetScope } from "./vocabulary.js";

/**
 * The bar over the grid (ADR-0035).
 *
 * What is under test throughout is that it sends **values, never a query**: the
 * grammar has one implementation and it is not in the sandbox. Everything about
 * what those values spell is tested in `@roost/search`'s `facets.test.ts`.
 */

const NONE: WireFacets = { tags: [], tagRule: "any", stars: [], unrated: false, exts: [] };

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

function show(
  facets: WireFacets = NONE,
  representable = true,
  subfolders = false,
  scope: FacetScope = null,
) {
  const sent: WireFacets[] = [];
  const depths: boolean[] = [];
  const wanted: boolean[] = [];
  render(
    <FilterBar
      facets={facets}
      representable={representable}
      tags={TAGS}
      ratings={RATINGS}
      types={TYPES}
      scope={scope}
      onScopeWanted={(on) => wanted.push(on)}
      onChange={(next) => sent.push(next)}
      subfolders={subfolders}
      onSubfolders={(on) => depths.push(on)}
    />,
  );
  return { user: userEvent.setup(), sent, depths, wanted };
}

const open = async (user: ReturnType<typeof userEvent.setup>, facet: RegExp): Promise<void> => {
  await user.click(screen.getByRole("button", { name: facet }));
};

describe("inside a folder (ADR-0035 §8)", () => {
  const FOLDER: FacetScope = {
    tags: [row({ id: "tag:wood", name: "wood", count: 3, group: "Materials" })],
    types: [{ ext: "png", count: 3 }],
  };
  const items = (): (string | null)[] =>
    screen.getAllByRole("menuitemcheckbox").map((item) => item.textContent);

  it("offers only what the folder holds, at the folder's counts", async () => {
    const { user } = show(NONE, true, false, FOLDER);
    await open(user, /^Tags/);
    expect(items()).toEqual([expect.stringContaining("wood")]);
    expect(items()[0]).toContain("3");
    await user.keyboard("{Escape}");
    await open(user, /^Types/);
    expect(items()).toEqual([expect.stringContaining("PNG")]);
  });

  it("keeps a ticked value the folder does not hold, so it can be unticked", async () => {
    const { user, sent } = show({ ...NONE, tags: ["wip"], exts: ["mp4"] }, true, false, FOLDER);
    await open(user, /^Tags/);
    const wip = await screen.findByRole("menuitemcheckbox", { name: /wip/ });
    expect(wip.getAttribute("aria-checked")).toBe("true");
    await user.click(wip);
    expect(sent.at(-1)?.tags).toEqual([]);
  });

  it("draws the library's list for a menu the answer leaves alone (§9)", async () => {
    // Under All over the whole library only Tags is narrowed; Types is the
    // library's, and the answer says so with a null rather than a copy.
    const { user } = show(NONE, true, false, {
      tags: [row({ id: "tag:wood", name: "wood", count: 3 })],
      types: null,
    });
    await open(user, /^Tags/);
    expect(items()).toEqual([expect.stringContaining("wood")]);
    await user.keyboard("{Escape}");
    await open(user, /^Types/);
    expect(items()).toHaveLength(TYPES.length);
  });

  it("says it is counting rather than showing the library's list first", async () => {
    const { user } = show(NONE, true, false, "counting");
    await open(user, /^Tags/);
    expect(screen.queryAllByRole("menuitemcheckbox")).toEqual([]);
    expect((await screen.findByRole("menu")).textContent).toContain("Counting…");
  });

  it("says a folder holds no tags in its own words", async () => {
    const { user } = show(NONE, true, false, { tags: [], types: [] });
    await open(user, /^Tags/);
    expect((await screen.findByRole("menu")).textContent).toContain("No tags here");
  });

  it("asks for the folder's lists while Tags or Types is open, and not for Rating", async () => {
    const { user, wanted } = show();
    expect(wanted).toEqual([false]);
    await open(user, /^Rating/);
    expect(wanted).toEqual([false]);
    await user.keyboard("{Escape}");
    await open(user, /^Tags/);
    expect(wanted).toEqual([false, true]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(wanted).toEqual([false, true, false]));
  });
});

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
    expect(sent).toEqual([{ ...NONE, tags: ["wood"] }]);
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
    expect(sent).toEqual([{ ...NONE, unrated: true }]);
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
    show({ ...NONE, tags: ["wood", "metal"], stars: [5] });
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
    expect(sent.at(-1)).toEqual({ ...NONE, exts: ["png"] });
  });

  it("offers the tag rule, and no other facet has one", async () => {
    // ADR-0035 §7.1: an asset has one extension and one rating, so `all` on
    // either would be a button whose only outcome is an empty grid.
    const { user } = show();
    await open(user, /^Tags/);
    expect(await screen.findByRole("button", { name: "Rule: All" })).toBeDefined();
    await user.keyboard("{Escape}");

    await open(user, /^Rating/);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Rule:/ })).toBeNull());
  });

  it("sends the rule with the values, and does not close the menu to do it", async () => {
    const { user, sent } = show({ ...NONE, tags: ["wood", "metal"] });
    await open(user, /^Tags/);
    await user.click(await screen.findByRole("button", { name: "Rule: All" }));

    expect(sent.at(-1)).toEqual({ ...NONE, tags: ["wood", "metal"], tagRule: "all" });
    // Choosing a rule and then a third tag is one visit to the menu.
    expect(screen.getByRole("menu")).toBeDefined();
  });

  it("shows which rule is on", async () => {
    const { user } = show({ ...NONE, tags: ["wood", "metal"], tagRule: "all" });
    await open(user, /^Tags/);
    const all = await screen.findByRole("button", { name: "Rule: All" });
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Rule: Any" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("keeps the rule when the filters are cleared", async () => {
    // The rule is not a filter: it is how the *next* two tags will be joined,
    // and clearing has said nothing about that.
    const { user, sent } = show({ ...NONE, tags: ["wood"], tagRule: "all" });
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(sent).toEqual([{ ...NONE, tagRule: "all" }]);
  });

  it("searches a long list, and leaves a short one alone", async () => {
    // ADR-0035 §7.3. A field over five tags costs a row and saves nothing.
    const { user } = show();
    await open(user, /^Tags/);
    expect(screen.queryByRole("searchbox", { name: "Search tags" })).toBeNull();
    await user.keyboard("{Escape}");

    const many = Array.from({ length: 12 }, (_, i) =>
      row({ id: `tag:${i}`, name: i === 4 ? "olahraga" : `tag-${i}`, count: i }),
    );
    render(
      <FilterBar
        facets={NONE}
        representable
        tags={many}
        ratings={RATINGS}
        types={TYPES}
        onChange={() => {}}
        subfolders={false}
        onSubfolders={() => {}}
      />,
    );
    const triggers = screen.getAllByRole("button", { name: /^Tags/ });
    await user.click(triggers[triggers.length - 1] as HTMLElement);

    const field = await screen.findByRole("searchbox", { name: "Search tags" });
    await user.type(field, "olah");
    await waitFor(() =>
      expect(screen.getAllByRole("menuitemcheckbox").map((item) => item.textContent)).toHaveLength(
        1,
      ),
    );
    expect(screen.getByRole("menuitemcheckbox").textContent).toContain("olahraga");
  });

  it("gives the field the caret once, not each time the pointer leaves a value", async () => {
    // Found on 2026-10-24: a menu focuses its own content whenever the pointer
    // leaves an item, and handing that on to the field scrolled a long menu
    // back to its head under the hand of somebody scrolling down it.
    const many = Array.from({ length: 12 }, (_, i) => row({ id: `tag:${i}`, name: `tag-${i}` }));
    render(
      <FilterBar
        facets={NONE}
        representable
        tags={many}
        ratings={RATINGS}
        types={TYPES}
        onChange={() => {}}
        subfolders={false}
        onSubfolders={() => {}}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Tags/ }));
    const field = await screen.findByRole("searchbox", { name: "Search tags" });
    await waitFor(() => expect(document.activeElement).toBe(field));

    const item = screen.getByRole("menuitemcheckbox", { name: /tag-9/ });
    await user.hover(item);
    expect(document.activeElement).toBe(item);
    await user.unhover(item);
    expect(document.activeElement).not.toBe(field);
  });

  it("says when a search matches nothing, rather than opening onto a blank", async () => {
    const many = Array.from({ length: 12 }, (_, i) => row({ id: `tag:${i}`, name: `tag-${i}` }));
    render(
      <FilterBar
        facets={NONE}
        representable
        tags={many}
        ratings={RATINGS}
        types={TYPES}
        onChange={() => {}}
        subfolders={false}
        onSubfolders={() => {}}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Tags/ }));
    await user.type(await screen.findByRole("searchbox", { name: "Search tags" }), "zzz");
    await waitFor(() => expect(screen.getByText("Nothing matches")).toBeDefined());
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
        subfolders={false}
        onSubfolders={() => {}}
      />,
    );
    const user = userEvent.setup();
    await open(user, /^Tags/);
    await waitFor(() => expect(screen.getByText("No tags yet")).toBeDefined());
  });

  it("draws Show subfolder contents beside the facets, not as one of them", async () => {
    // A facet narrows what is on screen; this says how deep the place reaches
    // (ADR-0036). Different question, so a checkbox rather than a chip — and it
    // is why the roster test above still finds three buttons.
    const { user, depths } = show(NONE, true, false);
    const box = screen.getByRole("checkbox", { name: "Show subfolder contents" });
    expect(box).toHaveProperty("checked", false);

    await user.click(box);
    expect(depths).toEqual([true]);
  });

  it("draws it ticked when the query on screen reaches into subfolders", async () => {
    const { user, depths } = show(NONE, true, true);
    const box = screen.getByRole("checkbox", { name: "Show subfolder contents" });
    expect(box).toHaveProperty("checked", true);

    await user.click(box);
    expect(depths).toEqual([false]);
  });

  it("draws it even where the chips cannot describe the query", () => {
    // The chips go off for a query they cannot show, and this does not: the
    // depth is read off the place, which is exactly the part that survives a
    // query the bar refuses.
    show(NONE, false, true);
    expect(screen.getByRole("checkbox", { name: "Show subfolder contents" })).toHaveProperty(
      "checked",
      true,
    );
  });
});
