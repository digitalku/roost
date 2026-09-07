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
/** Tagged `olahraga`. */
const TAGGED = 5;
/** Rated three stars. Different from `TAGGED`, on purpose. */
const RATED = 2;
const TAG = "olahraga";
const STARS = 3;

const { dir, dispose } = await scratch("check-filters");
const root = await imageLibrary(dir, { count: ASSETS });
await tagsOnto(root, [TAG], TAGGED);
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
const itemAt = (text) =>
  cdp.evaluate(`(() => {
    const found = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find(
      (item) => item.textContent.includes(${JSON.stringify(text)}),
    );
    if (found === undefined) return null;
    const box = found.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);

/** The search field's text, the grid's row count, and what each chip says. */
const state = () =>
  cdp.evaluate(`(() => ({
    query: document.querySelector(".search-input")?.value ?? null,
    cells: document.querySelectorAll(".cell").length,
    chips: [...document.querySelectorAll(".filter-trigger")].map((b) => b.textContent.trim()),
    on: [...document.querySelectorAll(".filter-trigger[data-on]")].length,
    note: document.querySelector(".filter-note")?.textContent ?? null,
  }))()`);

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
    await cdp.evaluate(`(() => {
      const field = document.querySelector(".search-input");
      const box = field.getBoundingClientRect();
      window.__at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    const at = await cdp.evaluate(`window.__at`);
    await cdp.mouse.click(at.x, at.y);
    await cdp.keyboard.press("a", { ctrl: true });
    for (const character of "ext:png") await cdp.keyboard.press(character);
    await cdp.keyboard.press("Enter");
    await sleep(400);

    const seen = await state();
    check("the tag chip let go", seen.chips[0]?.includes(TAG) === false, seen.chips[0]);
    check("the type chip took it up", seen.chips[2]?.includes("PNG") === true, seen.chips[2]);
    check("the grid is the whole library again", seen.cells === ASSETS, `${seen.cells} cells`);
  }

  section("A query the chips cannot describe says so");
  {
    const at = await cdp.evaluate(`window.__at`);
    await cdp.mouse.click(at.x, at.y);
    await cdp.keyboard.press("a", { ctrl: true });
    for (const character of `tag:${TAG} OR ext:png`) await cdp.keyboard.press(character);
    await cdp.keyboard.press("Enter");
    await sleep(400);

    const seen = await state();
    check("no chip claims to be on", seen.on === 0, `on=${seen.on}`);
    check("and it is said out loud", seen.note !== null, seen.note ?? "no note");
  }

  section("Clear takes the filters off and leaves the words alone");
  {
    const at = await cdp.evaluate(`window.__at`);
    await cdp.mouse.click(at.x, at.y);
    await cdp.keyboard.press("a", { ctrl: true });
    for (const character of `shot tag:${TAG}`) await cdp.keyboard.press(character);
    await cdp.keyboard.press("Enter");
    await sleep(400);

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
} finally {
  report();
  await window.close();
  await dispose();
}
