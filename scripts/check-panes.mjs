/**
 * Showing and hiding the two side panes, against a **running window**
 * (ADR-0028 §6, `UI_SPEC.md` §1).
 *
 *     node scripts/check-panes.mjs
 *
 * The component tests drive this against a fake engine, so they can say which
 * elements are mounted and nothing about what the window then looks like. Two
 * of the three claims here are about exactly that:
 *
 * - **The `☰` survives hiding the column it lives in.** It is drawn at the head
 *   of the sidebar, so a toggle that only hid the column would hide the way
 *   back; it moves to the content head instead, and there must never be two.
 * - **The grid takes the room.** A pane that is unmounted but whose width the
 *   layout still reserves is a pane that was not hidden.
 * - **A second window opens with what the first was left with**, which is the
 *   half no single window can assert about itself.
 *
 * It builds its own library in a temporary directory and deletes it again.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ledger } from "./lib/checks.mjs";
import { imageLibrary, scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

/** What is on screen, as one round trip: the panes, the ☰, and the grid's width. */
const layoutExpression = `
  (() => {
    const triggers = [...document.querySelectorAll(".app-menu-trigger")];
    const frame = document.querySelector(".grid-frame");
    return {
      sidebar: document.querySelector(".pane-sidebar") !== null,
      inspector: document.querySelector(".inspector") !== null,
      triggers: triggers.length,
      // Which head it is drawn in — the whole point of the relocation.
      inSidebarHead: triggers.some((node) => node.closest(".bar-sidebar") !== null),
      inContentHead: triggers.some((node) => node.closest(".pane-content > .bar") !== null),
      grid: frame === null ? 0 : Math.round(frame.getBoundingClientRect().width),
      // The third head a preview puts on screen in place of the grid's.
      preview: document.querySelector(".preview") !== null,
      inPreviewBar: triggers.some((node) => node.closest(".preview-bar") !== null),
      // Hard against the start of its row, wherever it is drawn: a button that
      // moves across the window as a preview opens is a different button.
      atStart:
        triggers.length === 1
          ? Math.round(triggers[0].getBoundingClientRect().left) < 80
          : false,
    };
  })()`;

/**
 * `settings.json`, once it says what the window was told.
 *
 * Polled rather than read once: the write is a round trip and a file write
 * behind it, so reading immediately after a keystroke would be a race that
 * fails on a slow machine and passes here.
 */
const written = async (library, ready, attempts = 50) => {
  for (let left = attempts; left > 0; left -= 1) {
    let held = {};
    try {
      held = JSON.parse(await readFile(join(library, "settings.json"), "utf8"));
    } catch {
      // Absent until the first preference is changed, which is the state this
      // is waiting to leave.
    }
    if (ready(held)) return held;
    await sleep(100);
  }
  throw new Error("settings.json never said what the window was told");
};

const { dir, dispose } = await scratch("check-panes");
const root = await imageLibrary(dir, { count: 12 });
const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

/** The middle of an element, in viewport coordinates, for `cdp.mouse`. */
const centreOf = (selector) =>
  cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return null;
    const box = el.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);

/** Opens the `☰` and clicks the checkbox item whose label contains `label`. */
const pick = async (label) => {
  const trigger = await centreOf(".app-menu-trigger");
  if (trigger === null) throw new Error("no ☰ on screen");
  await cdp.mouse.click(trigger.x, trigger.y);
  const at = await cdp.settle(
    `(() => {
      const item = [...document.querySelectorAll('[role="menuitemcheckbox"]')]
        .find((node) => node.textContent.includes(${JSON.stringify(label)}));
      if (item === undefined) return null;
      const box = item.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`,
    (found) => found !== null,
  );
  await cdp.mouse.click(at.x, at.y);
};

try {
  const opened = await cdp.settle(layoutExpression, (seen) => seen.grid > 0);

  section("the window a library opens in");
  check("the sidebar is drawn", opened.sidebar);
  check("the inspector is drawn", opened.inspector);
  check("the ☰ is at the head of the sidebar", opened.triggers === 1 && opened.inSidebarHead);

  section("Show sidebar");
  await pick("Show sidebar");
  const noSidebar = await cdp.settle(layoutExpression, (seen) => seen.sidebar === false);
  check("the column is gone", noSidebar.sidebar === false);
  // The regression this script exists for: one menu, still reachable.
  check(
    "the ☰ moved to the content head rather than going with it",
    noSidebar.triggers === 1 && noSidebar.inContentHead,
    JSON.stringify({ triggers: noSidebar.triggers, content: noSidebar.inContentHead }),
  );
  check(
    "the grid took the room",
    noSidebar.grid > opened.grid + 100,
    `${opened.grid}px → ${noSidebar.grid}px`,
  );

  section("Show inspector");
  await pick("Show inspector");
  const neither = await cdp.settle(layoutExpression, (seen) => seen.inspector === false);
  check("the panel is gone", neither.inspector === false);
  check(
    "and the grid took that room as well",
    neither.grid > noSidebar.grid + 100,
    `${noSidebar.grid}px → ${neither.grid}px`,
  );

  section("F9 and F4, with the menu shut (`UI_SPEC.md` §9)");
  await cdp.keyboard.press("F9");
  const back = await cdp.settle(layoutExpression, (seen) => seen.sidebar === true);
  check("F9 brings the sidebar back", back.sidebar === true);
  check("and the ☰ is at its head again, once", back.triggers === 1 && back.inSidebarHead);
  await cdp.keyboard.press("F4");
  check(
    "F4 brings the inspector back",
    (await cdp.settle(layoutExpression, (seen) => seen.inspector === true)).inspector === true,
  );

  section("a file open, with no sidebar behind it");
  // The gap the user found on 2026-09-13: the preview replaces the content
  // head with its own bar, so with the sidebar hidden there was no head left
  // holding the ☰ — and no way back to the sidebar but a key nothing says.
  await pick("Show sidebar");
  await cdp.settle(layoutExpression, (seen) => seen.sidebar === false);
  const cell = await cdp.evaluate(`(() => {
    const el = document.querySelector(".cell");
    if (el === null) return null;
    const box = el.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  // Clicked, then `Enter`: the same two gestures a person uses, and a `Return`
  // is one event where a double-click is four.
  await cdp.mouse.click(cell.x, cell.y);
  await cdp.keyboard.press("Enter");
  const open = await cdp.settle(layoutExpression, (seen) => seen.preview === true);
  check("the ☰ is drawn in the preview's own bar", open.triggers === 1 && open.inPreviewBar);
  check("and still at the start of the row", open.atStart);
  // Which is the whole point: the sidebar can be brought back from here.
  await pick("Show sidebar");
  const restored = await cdp.settle(layoutExpression, (seen) => seen.sidebar === true);
  check("the sidebar comes back from it, with the file still open", restored.preview === true);
  check(
    "and the ☰ is back at the head of the sidebar, not repeated in the bar",
    restored.triggers === 1 && restored.inSidebarHead,
  );
  await cdp.keyboard.press("Escape");
  await cdp.settle(layoutExpression, (seen) => seen.preview === false);

  section("a library opens with the panes it was left with (ADR-0019)");
  // Left hidden, then read back from the file before the window is closed: a
  // preference the window holds and never writes would pass every check above.
  await cdp.keyboard.press("F9");
  await cdp.settle(layoutExpression, (seen) => seen.sidebar === false);
  await cdp.keyboard.press("F4");
  await cdp.settle(layoutExpression, (seen) => seen.inspector === false);
  const settings = await written(root, (held) => held.showInspector === false);
  check(
    "settings.json holds both",
    settings.showSidebar === false && settings.showInspector === false,
    JSON.stringify({ sidebar: settings.showSidebar, inspector: settings.showInspector }),
  );

  // A second window, because that is the claim. The first is closed first:
  // Electron holds a single-instance lock, so a second process started beside
  // it hands its command line to the first and exits — and what is under test
  // is a **start-up**.
  await window.close();
  const second = await launch({ library: root });
  try {
    const drawn = await second.cdp.settle(layoutExpression, (seen) => seen.grid > 0);
    check("the second window draws neither pane", !drawn.sidebar && !drawn.inspector);
    check(
      "and its ☰ is in the content head, where the sidebar is not",
      drawn.triggers === 1 && drawn.inContentHead,
    );
  } finally {
    await second.close();
  }

  report();
} catch (error) {
  console.error(error);
  console.error(window.noise().slice(-4000));
  process.exitCode = 2;
} finally {
  await window.close();
  await dispose();
}
