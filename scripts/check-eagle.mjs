/**
 * Importing from Eagle, asserted against a **running window** (ADR-0032).
 *
 * The component tests drive this through a fake engine, which proves the
 * sequence — a menu item, a chooser, a survey, a confirmation — and proves
 * nothing at all about the four processes underneath it. This is the other
 * half: a real preload, a real main, a real engine, and a real Eagle library on
 * disk, so `eagle:survey` and `eagle:import` are exercised end to end through
 * the port rather than through a stub that answers instantly.
 *
 *   node scripts/check-eagle.mjs
 *
 * **The one step it cannot drive is the native directory chooser**, which
 * belongs to the desktop and hands back a path no script can pre-fill. So the
 * menu item is asserted here and the path is handed to the page directly
 * afterwards — everything from there on is the real thing.
 *
 * Builds its own Roost library and its own Eagle library in a temporary
 * directory, and deletes both.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { ledger } from "./lib/checks.mjs";
import { eagleLibrary, imageLibrary, scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

const { dir, dispose } = await scratch("check-eagle");
// Two assets already here, so the counts afterwards have to be about what
// arrived rather than about everything the library holds.
const root = await imageLibrary(dir, { count: 2, name: "Destination" });
const eagle = await eagleLibrary(dir);

const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

/** Every item in the Add menu, in order, with whether it can be chosen. */
const addItemsExpression = `
  [...document.querySelectorAll('[role="menuitem"]')].map((item) => ({
    label: item.querySelector(".menu-label")?.textContent ?? item.textContent,
    disabled: item.getAttribute("aria-disabled") === "true",
  }))`;

/** What the sidebar's Folders and Tags sections hold. */
const sidebarExpression = `
  (() => {
    const named = (heading) =>
      [...document.querySelectorAll(".sidebar-section")]
        .filter((s) => (s.querySelector(".sidebar-heading")?.textContent ?? "").startsWith(heading))
        .flatMap((s) => [...s.querySelectorAll(".sidebar-row")])
        .map((row) => ({
          name: row.querySelector(".sidebar-label")?.textContent,
          count: row.querySelector(".sidebar-count")?.textContent ?? null,
        }));
    return { folders: named("Folders") };
  })()`;

/**
 * The tags, read from the filter bar's menu.
 *
 * They were sidebar rows until 2026-09-07 (ADR-0035). What the import has to
 * produce is unchanged — a tag with a count — and where a person reads it is
 * the only thing that moved.
 */
const tagsExpression = `
  [...document.querySelectorAll('[role="menuitemcheckbox"]')].map((item) => ({
    name: item.querySelector(".menu-label")?.textContent,
    count: item.querySelector(".menu-count")?.textContent ?? null,
  }))`;

/** A request sent the way the window sends one: through the preload's surface. */
const request = (payload) => `window.roost.invoke(${JSON.stringify(payload)})`;

try {
  section("The door in the Add menu");
  // A real pointer, not a dispatched click: Radix opens on `pointerdown`, and a
  // synthetic `click()` on the trigger leaves the menu shut.
  const trigger = await cdp.box(".add-trigger");
  await cdp.mouse.click(trigger.x, trigger.y);
  const items = await cdp.settle(
    addItemsExpression,
    (rows) => Array.isArray(rows) && rows.length > 0,
  );
  const eagleItem = items.find((item) => item.label === "Import from Eagle…");

  check(
    "Import from Eagle… is in the menu",
    eagleItem !== undefined,
    items.map((i) => i.label).join(" · "),
  );
  check("it can be chosen while nothing is importing", eagleItem?.disabled === false);
  check(
    "it sits with the other two imports, not above them",
    items.findIndex((i) => i.label === "Import from Eagle…") >
      items.findIndex((i) => i.label === "Import folder…"),
  );
  // Closed again, or the menu keeps the focus for everything after this.
  await cdp.keyboard.press("Escape");
  await sleep(50);

  section("The survey, through the real engine");
  const surveyed = await cdp.evaluate(request({ type: "eagle:survey", path: eagle }));
  const survey = surveyed?.ok === true ? surveyed.value : undefined;

  check("it answers", surveyed?.ok === true, JSON.stringify(surveyed?.problem ?? "").slice(0, 120));
  check("it reads Eagle's version", survey?.version === "4.0.0", `version=${survey?.version}`);
  check(
    "it counts the items and not Eagle's thumbnails",
    survey?.items === 3,
    `items=${survey?.items}`,
  );
  check(
    "it counts the folder tree, nested ones included",
    survey?.folders === 3,
    `folders=${survey?.folders}`,
  );
  check(
    "it finds the caption no metadata mentions",
    survey?.subtitles === 1,
    `subtitles=${survey?.subtitles}`,
  );
  check(
    "it counts a comment on every item",
    survey?.comments === 3,
    `comments=${survey?.comments}`,
  );
  // `star` is written on one item and omitted on the others, which is Eagle's
  // convention and the one a remembered parser turns into three ratings of zero.
  check("only the item Eagle rated is rated", survey?.rated === 1, `rated=${survey?.rated}`);

  section("Nothing was written by looking");
  const before = await cdp.evaluate(request({ type: "library:stats" }));
  check(
    "the library still holds what it did",
    before?.value?.assets === 2,
    `assets=${before?.value?.assets}`,
  );

  section("The import");
  const imported = await cdp.evaluate(
    request({ type: "eagle:import", path: eagle, mode: "managed" }),
  );
  const eagleReport = imported?.ok === true ? imported.value : undefined;

  check("it answers", imported?.ok === true, JSON.stringify(imported?.problem ?? "").slice(0, 120));
  check("every item arrived", eagleReport?.assets === 3, `assets=${eagleReport?.assets}`);
  // Three items and one `.srt`, which is an asset of its own (ADR-0025).
  check(
    "the caption is an asset too",
    eagleReport?.imported === 4,
    `imported=${eagleReport?.imported}`,
  );
  check(
    "it attached the caption",
    eagleReport?.subtitles === 1,
    `subtitles=${eagleReport?.subtitles}`,
  );
  check("it made the folders", eagleReport?.folders === 3, `folders=${eagleReport?.folders}`);
  check(
    "it carried the comments",
    eagleReport?.comments === 3,
    `comments=${eagleReport?.comments}`,
  );
  check(
    "it drew thumbnails in the same run",
    (eagleReport?.thumbnails ?? 0) > 0,
    `thumbnails=${eagleReport?.thumbnails}`,
  );

  section("And the window says so");
  await cdp.settle(sidebarExpression, (s) => s.folders.length > 0);
  // `Deep` is inside `majorette`, and a branch starts closed (ADR-0033) — so
  // the arrow is pressed first, which is also the gesture a person makes. This
  // check asked for `Deep` without opening its parent from the day collapsing
  // landed until 2026-09-07, and failed silently in a script nobody re-ran.
  const twisty = await cdp.box('button[aria-label="Expand majorette"]');
  await cdp.mouse.click(twisty.x, twisty.y);
  const sidebar = await cdp.settle(sidebarExpression, (s) =>
    s.folders.some((row) => row.name === "Deep"),
  );
  check(
    "the folders are in the sidebar",
    ["gym", "majorette", "Deep"].every((name) => sidebar.folders.some((row) => row.name === name)),
    sidebar.folders.map((row) => `${row.name}=${row.count}`).join(" · "),
  );
  check(
    "an item in two folders counts in both",
    sidebar.folders.find((row) => row.name === "Deep")?.count === "1",
    sidebar.folders.map((row) => `${row.name}=${row.count}`).join(" · "),
  );

  const tagsTrigger = await cdp.evaluate(`(() => {
    const found = [...document.querySelectorAll(".filter-trigger")].find(
      (button) => button.textContent.startsWith("Tags"),
    );
    if (found === undefined) return null;
    const box = found.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
  await cdp.mouse.click(tagsTrigger.x, tagsTrigger.y);
  const tags = await cdp.settle(tagsExpression, (rows) => rows.length > 0);
  check(
    "Eagle's tags are the library's tags",
    tags.some((row) => row.name === "blue" && row.count === "2"),
    tags.map((row) => `${row.name}=${row.count}`).join(" · "),
  );
  await cdp.keyboard.press("Escape");

  const after = await cdp.evaluate(request({ type: "library:stats" }));
  check(
    "the two that were here are still here",
    after?.value?.assets === 6,
    `assets=${after?.value?.assets}`,
  );

  section("Running it again changes nothing");
  const again = await cdp.evaluate(request({ type: "eagle:import", path: eagle, mode: "managed" }));
  check(
    "no bytes are imported twice",
    again?.value?.imported === 0,
    `imported=${again?.value?.imported}`,
  );
  check("no folder is made twice", again?.value?.folders === 0, `folders=${again?.value?.folders}`);
  check(
    "no comment is added twice",
    again?.value?.comments === 0,
    `comments=${again?.value?.comments}`,
  );

  section("A judgement made here survives the next import (ADR-0032 §8)");
  // Eagle gives `a1` four stars and a note. The point is what happens when
  // somebody disagrees with Eagle *after* the first import.
  const page = await cdp.evaluate(
    request({ type: "assets:page", query: "a1", limit: 1, after: null }),
  );
  const hash = page?.value?.assets?.[0]?.hash ?? null;
  check("the rated item is findable by name", hash !== null, `hash=${String(hash).slice(0, 12)}`);

  await cdp.evaluate(request({ type: "asset:rate", hashes: [hash], rating: 1 }));
  await cdp.evaluate(request({ type: "asset:note", hash, note: "what I actually think" }));

  const third = await cdp.evaluate(request({ type: "eagle:import", path: eagle, mode: "managed" }));
  const detail = await cdp.evaluate(request({ type: "asset:detail", hash }));

  check(
    "the rating set here is not replaced by Eagle's",
    detail?.value?.rating === 1,
    `rating=${detail?.value?.rating}`,
  );
  check(
    "and neither is the note",
    detail?.value?.note === "what I actually think",
    JSON.stringify(detail?.value?.note),
  );
  check(
    "the run says how many it left alone, rather than saying nothing",
    (third?.value?.preserved ?? 0) >= 2,
    `preserved=${third?.value?.preserved}`,
  );
  check(
    "and wrote none of the three it was carrying",
    third?.value?.ratings === 0 && third?.value?.notes === 0 && third?.value?.sources === 0,
    `ratings=${third?.value?.ratings} notes=${third?.value?.notes} sources=${third?.value?.sources}`,
  );

  section("A directory that is not an Eagle library");
  const refused = await cdp.evaluate(request({ type: "eagle:survey", path: dir }));
  check("it is refused rather than reported as empty", refused?.ok === false);
  check(
    "and the refusal says what was missing",
    (refused?.problem?.code ?? "") === "not_an_eagle_library",
    `code=${refused?.problem?.code}`,
  );
} finally {
  await window.close();
  await dispose();
}

report();
