/**
 * The filter bar over the grid, asserted against a **running window**
 * (ADR-0035).
 *
 * The component tests can see which values were sent and the query tests can
 * see what those values spell. Neither can see the thing this control is for:
 * a bar, a search field, and a grid that have to agree about one string, in a
 * browser that decides what is actually on screen. The bar is a *view* of the
 * query — so the claim under test throughout is the round trip. Tick a facet,
 * and the field, the grid and the chip must all say the same thing; type into
 * the field, and the chips must follow.
 *
 *   node scripts/check-filters.mjs
 *
 * **It builds its own library** in a temporary directory and deletes it again,
 * so it can never touch anything of yours. The fixture is chosen so that no two
 * facets return the same number of assets: a check that cannot tell `ext:png`
 * from `rating:5` would pass with the two swapped.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { ledger } from "./lib/checks.mjs";
import { imageLibrary, rateFirst, scratch, tagsOnto } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

/** Every asset is a PNG, so the type facet selects all of them. */
const ASSETS = 8;
/** Tagged `olahraga`: the first five. */
const TAGGED = 5;
/** Rated three stars. Different from `TAGGED`, on purpose. */
const RATED = 2;
const TAG = "olahraga";
const OTHER = "traveling";
const STARS = 3;
/**
 * The two tags overlap on two assets and cover all eight between them.
 *
 * Which is what makes the rule visible: `any` is the whole library and `all` is
 * two of it, so a check cannot pass with the two swapped (ADR-0035 §7).
 */
const BOTH = 2;

/** Enough tags that the menu is searched rather than read (§7.3 wants > 8). */
const FILLER = ["comedy", "school", "gym", "studio", "draft", "final", "print", "web"];

const { dir, dispose } = await scratch("check-filters");
const root = await imageLibrary(dir, { count: ASSETS });
await tagsOnto(root, [TAG], TAGGED);
await tagsOnto(root, [OTHER], ASSETS - TAGGED + BOTH, TAGGED - BOTH);
await tagsOnto(root, FILLER, 1);
await rateFirst(root, STARS, RATED);

const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

/** Where a facet's button is, by the label it starts with. */
const triggerAt = (label) =>
  cdp.evaluate(`(() => {
    const found = [...document.querySelectorAll(".filter-trigger")].find(
      (button) => button.textContent.startsWith(${JSON.stringify(label)}),
    );
    if (found === undefined) return null;
    const box = found.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);

/** Where a menu item is, by a fragment of its text. */
const itemExpression = (text) => `
  (() => {
    const found = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find(
      (item) => item.textContent.includes(${JSON.stringify(text)}),
    );
    if (found === undefined) return null;
    const box = found.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`;

const itemAt = (text) => cdp.evaluate(itemExpression(text));

/** The search field's text, the grid's row count, and what each chip says. */
const state = () =>
  cdp.evaluate(`(() => ({
    query: document.querySelector(".search-input")?.value ?? null,
    cells: document.querySelectorAll(".cell").length,
    chips: [...document.querySelectorAll(".filter-trigger")].map((b) => b.textContent.trim()),
    on: [...document.querySelectorAll(".filter-trigger[data-on]")].length,
    note: document.querySelector(".filter-note")?.textContent ?? null,
  }))()`);

/** Puts `text` in the search field and applies it, the way a person would. */
async function typeQuery(text) {
  const at = await cdp.box(".search-input");
  await cdp.mouse.click(at.x, at.y);
  await cdp.keyboard.press("a", { ctrl: true });
  await cdp.keyboard.press("Backspace");
  for (const character of text) await cdp.keyboard.press(character);
  await cdp.keyboard.press("Enter");
  await sleep(400);
}

/** Ticks one value in one facet, and closes the menu again. */
async function tick(facet, value) {
  const trigger = await triggerAt(facet);
  await cdp.mouse.click(trigger.x, trigger.y);
  const item = await cdp.settle(
    `document.querySelectorAll('[role="menuitemcheckbox"]').length`,
    (n) => n > 0,
  );
  if (item === undefined) throw new Error(`no menu opened for ${facet}`);
  const at = await itemAt(value);
  if (at === null) throw new Error(`${facet} has no ${value}`);
  await cdp.mouse.click(at.x, at.y);
  await sleep(150);
  await cdp.keyboard.press("Escape");
  await sleep(250);
}

try {
  await cdp.settle(`document.querySelectorAll(".cell").length`, (n) => n === ASSETS);

  section("The bar is there, and the pane is not");
  {
    const seen = await state();
    check("three facets, always drawn", seen.chips.length === 3, seen.chips.join(" · "));
    check("nothing chosen yet", seen.on === 0 && seen.query === "", `on=${seen.on}`);
    // The half of ADR-0035 that removed something. A pane still drawing rating
    // rows would make two controls over one vocabulary, which is the thing the
    // decision refused.
    const pane = await cdp.evaluate(
      `[...document.querySelectorAll(".sidebar-row")].map((row) => row.textContent).join("|")`,
    );
    check("no rating rows in the pane", !pane.includes("stars"), pane);
    check("no tag rows in the pane", !pane.includes(TAG), pane);
  }

  section("A facet writes the query, and the query is what the grid asked");
  {
    await tick("Tags", TAG);
    const seen = await state();
    check("the field shows the term", seen.query === `tag:${TAG}`, seen.query);
    check("the grid narrowed", seen.cells === TAGGED, `${seen.cells} cells`);
    check("the chip says which tag", seen.chips[0]?.includes(TAG) === true, seen.chips[0]);
    check("only that chip is on", seen.on === 1, `on=${seen.on}`);
  }

  section("Facets are ANDed, and each keeps its own values");
  {
    await tick("Rating", `${STARS} stars`);
    const seen = await state();
    check(
      "both terms, in the bar's order",
      seen.query === `tag:${TAG} rating:${STARS}`,
      seen.query,
    );
    // Every rated asset is also tagged, by construction: the first two of the
    // five. So the AND is the smaller of the two, and a bar that ORed its
    // facets would show more assets rather than fewer.
    check("the grid shows the intersection", seen.cells === RATED, `${seen.cells} cells`);
    check("two chips on", seen.on === 2, `on=${seen.on}`);
  }

  section("Typing in the field moves the chips, because the query is the truth");
  {
    await typeQuery("ext:png");
    const seen = await state();
    check("the tag chip let go", seen.chips[0]?.includes(TAG) === false, seen.chips[0]);
    check("the type chip took it up", seen.chips[2]?.includes("PNG") === true, seen.chips[2]);
    check("the grid is the whole library again", seen.cells === ASSETS, `${seen.cells} cells`);
  }

  section("A query the chips cannot describe says so");
  {
    await typeQuery(`tag:${TAG} OR ext:png`);
    const seen = await state();
    check("no chip claims to be on", seen.on === 0, `on=${seen.on}`);
    check("and it is said out loud", seen.note !== null, seen.note ?? "no note");
  }

  section("Clear takes the filters off and leaves the words alone");
  {
    await typeQuery(`shot tag:${TAG}`);
    const clear = await cdp.evaluate(`(() => {
      const button = document.querySelector(".filter-clear");
      if (button === null) return null;
      const box = button.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    check("Clear is offered", clear !== null);
    if (clear !== null) {
      await cdp.mouse.click(clear.x, clear.y);
      await sleep(400);
      const seen = await state();
      check("the typed words survive", seen.query === "shot", seen.query);
      check("and nothing is chosen", seen.on === 0, `on=${seen.on}`);
    }
  }
  section("Several values in one visit");
  {
    // The regression this script exists for. `onSelect`'s `preventDefault` is
    // the documented way to keep a menu open and it held for the **first** tick
    // and not the second, so choosing two tags shut the menu on the second.
    // Every component test passed: happy-dom dispatches the sequence
    // differently, and only a browser decides this.
    await typeQuery("");
    const trigger = await triggerAt("Tags");
    await cdp.mouse.click(trigger.x, trigger.y);
    await cdp.settle(`document.querySelectorAll('[role="menuitemcheckbox"]').length`, (n) => n > 0);

    for (const value of [TAG, OTHER]) {
      const item = await cdp.settle(itemExpression(value), (found) => found !== null);
      await cdp.mouse.click(item.x, item.y);
      await sleep(300);
    }
    const items = await cdp.evaluate(
      `document.querySelectorAll('[role="menuitemcheckbox"]').length`,
    );
    check("the menu is still open after the second tick", items > 0, `${items} items`);
    const both = await state();
    check("and both were taken", both.query === `(tag:${TAG} OR tag:${OTHER})`, both.query);

    // And it still closes when a person closes it.
    await cdp.keyboard.press("Escape");
    await sleep(250);
    const gone = await cdp.evaluate(
      `document.querySelectorAll('[role="menuitemcheckbox"]').length`,
    );
    check("Escape still closes it", gone === 0, `${gone} items`);
  }

  section("Any and All");
  {
    const any = await state();
    check("two tags are ORed by default", any.query === `(tag:${TAG} OR tag:${OTHER})`, any.query);
    check("and the grid shows either", any.cells === ASSETS, `${any.cells} cells`);

    const trigger = await triggerAt("Tags");
    await cdp.mouse.click(trigger.x, trigger.y);
    const rule = await cdp.settle(
      `(() => {
        const found = [...document.querySelectorAll(".filter-rule-button")].find(
          (button) => button.textContent === "All",
        );
        if (found === undefined) return null;
        const box = found.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      })()`,
      (at) => at !== null,
    );
    await cdp.mouse.click(rule.x, rule.y);
    await sleep(300);
    // The menu is still open: choosing a rule and then a third tag is one visit.
    const stillOpen = await cdp.evaluate(
      `document.querySelectorAll('[role="menuitemcheckbox"]').length > 0`,
    );
    check("choosing a rule does not close the menu", stillOpen === true);
    await cdp.keyboard.press("Escape");
    await sleep(300);

    const all = await state();
    check("All writes a term each", all.query === `tag:${TAG} tag:${OTHER}`, all.query);
    check("and the grid shows only both", all.cells === BOTH, `${all.cells} cells`);
  }

  section("The rule is remembered where the query cannot hold it");
  {
    // §7.2, and the shape the user chose: `tag:olahraga` is the same string
    // under either rule, so dropping to one tag must not quietly undo `All`.
    await tick("Tags", OTHER);
    const one = await state();
    check("one tag spells the same query either way", one.query === `tag:${TAG}`, one.query);

    await tick("Tags", OTHER);
    const back = await state();
    check(
      "and the second tag comes back ANDed, not ORed",
      back.query === `tag:${TAG} tag:${OTHER}`,
      back.query,
    );
  }

  section("A long facet is searched");
  {
    const trigger = await triggerAt("Tags");
    await cdp.mouse.click(trigger.x, trigger.y);
    const field = await cdp.settle(
      `document.querySelector(".filter-search-input") === null ? null : true`,
      (found) => found === true,
    );
    check("a field appears once the list is longer than a glance", field === true);

    // Typed through the input pipeline: a `radix-ui` menu binds printable keys
    // to jump between its items, and this is the check that the field takes
    // them instead.
    for (const character of "olah") await cdp.keyboard.press(character);
    await sleep(250);
    const shown = await cdp.evaluate(
      `[...document.querySelectorAll('[role="menuitemcheckbox"]')].map((item) =>
         item.querySelector(".menu-label")?.textContent)`,
    );
    check("and it filters the list rather than ticking a value", shown.length === 1, shown.join());
    check("to what was typed", shown[0] === TAG, shown.join());
    await cdp.keyboard.press("Escape");
    await sleep(200);
    const after = await state();
    check("nothing was chosen by typing", after.query === `tag:${TAG} tag:${OTHER}`, after.query);
  }
} finally {
  report();
  await window.close();
  await dispose();
}
