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
 * The last section is the field itself rather than the bar, and it is here for
 * the same reason the rest of this is: where a text field is *scrolled to* is a
 * browser's decision, and jsdom has no layout to make it with (`UI_SPEC.md` §5).
 *
 *   node scripts/check-filters.mjs
 *
 * **It builds its own library** in a temporary directory and deletes it again,
 * so it can never touch anything of yours. The fixture is chosen so that no two
 * facets return the same number of assets: a check that cannot tell `ext:png`
 * from `rating:5` would pass with the two swapped.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ledger } from "./lib/checks.mjs";
import { foldersInto, imageLibrary, rateFirst, scratch, tagsOnto } from "./lib/fixtures.mjs";
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
/**
 * A folder holding nothing directly, with everything one level down.
 *
 * Which is what makes *Show subfolder contents* visible at all (ADR-0036): off,
 * `Design` is empty; on, it is `Alpha`'s three.
 */
const NESTED = 3;
await foldersInto(root, [{ name: "Design" }, { name: "Alpha", parent: "Design", assets: NESTED }]);

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

/** The Show subfolder contents checkbox, as the window draws it. */
const checkbox = () =>
  cdp.evaluate('document.querySelector(".filter-check input")?.checked ?? null');

/** Clicks a row in the navigation pane, by name. */
async function pickRow(name) {
  const at = await cdp.evaluate(`(() => {
    const found = [...document.querySelectorAll(".sidebar-row")].find(
      (row) => row.querySelector(".sidebar-label")?.textContent === ${JSON.stringify(name)},
    );
    if (found === undefined) return null;
    const box = found.getBoundingClientRect();
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  })()`);
  if (at === null) throw new Error(`no sidebar row called ${name}`);
  await cdp.mouse.click(at.x, at.y);
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
  section("Show subfolder contents (ADR-0036)");
  await typeQuery("");
  check(
    "the checkbox is drawn, and starts from the library's setting",
    (await checkbox()) === false,
  );

  await pickRow("Design");
  const shallow = await state();
  // Off by default, so the sidebar wrote the term that does not descend and the
  // grid answers it: `Design` holds nothing directly.
  check(
    "opening a folder asks with infolder:, and the grid shows the folder alone",
    shallow.query === "infolder:Design" && shallow.cells === 0,
    `${shallow.query} → ${shallow.cells} cells`,
  );

  const at = await cdp.box(".filter-check input");
  await cdp.mouse.click(at.x, at.y);
  await sleep(500);
  const deep = await state();
  check(
    "ticking it rewrites the query on screen rather than changing what a term means",
    deep.query === "folder:Design" && deep.cells === NESTED,
    `${deep.query} → ${deep.cells} cells`,
  );

  // The pane has to be re-read, and nothing in the library changed — which is
  // why this was missed by every unit test and found in a screenshot. The
  // setting decides the term every folder row carries, so a stale pane keeps
  // rows asking the other depth: the count stays wrong and the row for the
  // folder on screen stops matching the query, so it stops being marked.
  const pane = await cdp.settle(
    `(() => {
      const found = [...document.querySelectorAll(".sidebar-branch")].find(
        (row) => row.querySelector(".sidebar-label")?.textContent === "Design",
      );
      if (found === undefined) return null;
      return {
        count: found.querySelector(".sidebar-count")?.textContent ?? null,
        current: found.querySelector(".sidebar-row[data-current]") !== null,
      };
    })()`,
    (row) => row !== null && row.count === String(NESTED),
    { attempts: 40 },
  );
  check(
    "the pane follows: the row counts what its own query now matches",
    pane.count === String(NESTED),
    `Design=${pane.count}`,
  );
  check("and it is still the row on screen", pane.current === true);

  // The setting, on disk, in the library — not in the window (ADR-0019). This
  // is the whole reason it is a file rather than a piece of window state.
  const saved = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
  check(
    "and writes the setting into the library's own settings.json",
    saved.showSubfolderContents === true,
    JSON.stringify(saved),
  );

  await typeQuery("infolder:Design");
  check("typing the other term by hand unticks it", (await checkbox()) === false);
  await typeQuery("folder:Design");
  check("and typing this one ticks it", (await checkbox()) === true);

  // A query naming no folder has nothing to reflect, so the checkbox falls back
  // to the setting — which is what the next folder opened will use.
  await typeQuery(`tag:${TAG}`);
  check("with no folder on screen it shows the setting again", (await checkbox()) === true);

  section("A long query shows its head");

  // The one thing about this field no unit test can see: a browser decides
  // where a text field is scrolled to, and jsdom has no layout at all. A folder
  // path long enough to overflow leaves the field showing its tail — the half
  // that names nothing — unless something puts it back.
  const room = await cdp.evaluate('document.querySelector(".search-input").clientWidth');
  // Padded with bare words, which are ordinary free text (ADR-0027): the query
  // has to overflow the field, and it also has to parse.
  let long = 'folder:"Design/Alpha"';
  for (let word = 0; long.length < room / 6; word += 1) long += ` word${word}`;
  await typeQuery(long);

  const afterTyping = await cdp.evaluate(`(() => {
    const input = document.querySelector(".search-input");
    return { over: input.scrollWidth > input.clientWidth + 1, scroll: input.scrollLeft };
  })()`);
  check(
    "typing a query longer than the field leaves it scrolled off its head",
    afterTyping.over === true && afterTyping.scroll > 0,
    `scrollLeft=${afterTyping.scroll}`,
  );

  // The empty state rather than the grid: this query matches nothing, and a
  // paragraph is the one thing on screen a click cannot ask a question with.
  const elsewhere = await cdp.box(".grid-empty");
  await cdp.mouse.click(elsewhere.x, elsewhere.y);
  await sleep(200);
  const atRest = await cdp.evaluate('document.querySelector(".search-input").scrollLeft');
  check("and it goes back to the head as soon as the caret leaves", atRest === 0, `${atRest}`);

  const fieldAt = await cdp.box(".search-input");
  await cdp.mouse.click(fieldAt.x, fieldAt.y);
  await sleep(200);
  const clicked = await cdp.evaluate(`(() => {
    const input = document.querySelector(".search-input");
    return {
      start: input.selectionStart,
      end: input.selectionEnd,
      direction: input.selectionDirection,
      scroll: input.scrollLeft,
      length: input.value.length,
    };
  })()`);
  check(
    "the click that focuses it selects the whole query",
    clicked.start === 0 && clicked.end === clicked.length,
    `${clicked.start}-${clicked.end} of ${clicked.length}`,
  );
  // The point of the backward direction: a browser scrolls to the selection's
  // focus end, so the field shows the folder the query names rather than the
  // last twenty characters of a path.
  check(
    "and shows its head rather than the tail it was scrolled to",
    clicked.direction === "backward" && clicked.scroll === 0,
    `${clicked.direction}, scrollLeft=${clicked.scroll}`,
  );

  // The two shortcuts, dispatched as real keys: `Ctrl+F` is a chord the window
  // has to claim, and `/` is a character that must reach a field somebody is
  // typing into rather than the shortcut (`UI_SPEC.md` §9).
  await cdp.mouse.click(elsewhere.x, elsewhere.y);
  await sleep(150);
  await cdp.keyboard.press("f", { ctrl: true });
  await sleep(150);
  const byChord = await cdp.evaluate("document.activeElement?.className ?? null");
  check("Ctrl+F takes the field from anywhere in the window", byChord === "search-input", byChord);

  await cdp.mouse.click(elsewhere.x, elsewhere.y);
  await sleep(150);
  const before = (await state()).query;
  await cdp.keyboard.press("/");
  await sleep(150);
  const bySlash = await cdp.evaluate(`(() => ({
    focused: document.activeElement?.className ?? null,
    query: document.querySelector(".search-input").value,
  }))()`);
  check("a bare slash takes it too", bySlash.focused === "search-input", bySlash.focused);
  // And it is a shortcut rather than a character the field then swallowed —
  // the query it lands in already has slashes of its own in a folder path.
  check("without typing itself into the query", bySlash.query === before, bySlash.query);

  await typeQuery(`tag:${TAG}`);
} finally {
  report();
  await window.close();
  await dispose();
}
