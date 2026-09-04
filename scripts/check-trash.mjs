/**
 * The trash, asserted against a **running window** (ADR-0022).
 *
 * The unit and service tests cover what trash *is*: a column, two journal ops,
 * a scoped query, and a menu that renders the right labels. None of them can
 * see what this does — a selection and a grid and a status bar in one place,
 * with a real browser deciding where focus goes. Both defects this found on the
 * day it was written lived exactly there: trashing left the selection holding
 * an asset nobody could see, and the fix for that wiped the status line the
 * action had just written.
 *
 *   node scripts/check-trash.mjs
 *
 * **It builds its own library** in a temporary directory and deletes it again,
 * so it can never trash anything of yours. Exits non-zero on the first failure,
 * so it can be a CI step on a machine that composites a window.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { ledger } from "./lib/checks.mjs";
import { imageLibrary, scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

/** How many assets the fixture holds. Enough to page, few enough to be instant. */
const ASSETS = 12;

const { dir, dispose } = await scratch("check-trash");
const root = await imageLibrary(dir, { count: ASSETS });
const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

const placesExpression = `
  (() => {
    const section = [...document.querySelectorAll(".sidebar-section")]
      .find((s) => s.querySelector(".sidebar-heading")?.textContent === "Places");
    return [...(section?.querySelectorAll(".sidebar-row") ?? [])].map((row) => ({
      name: row.querySelector(".sidebar-label")?.textContent,
      count: row.querySelector(".sidebar-count")?.textContent ?? null,
    }));
  })()`;

const statusExpression = `
  (() => {
    const panel = document.querySelector(".inspector");
    const grid = document.querySelector(".grid-frame") ?? document.querySelector(".grid");
    const cells = [...document.querySelectorAll(".cell")];
    const top = cells[0]?.getBoundingClientRect().top;
    return {
      total: document.querySelector(".status")?.firstElementChild?.textContent ?? null,
      note: document.querySelector(".status-note")?.textContent ?? null,
      inspector:
        panel === null
          ? "absent"
          : panel.querySelector(".inspector-empty") === null
            ? "detail"
            : "empty",
      gridWidth: Math.round(grid?.getBoundingClientRect().width ?? 0),
      columns: cells.filter((c) => Math.abs(c.getBoundingClientRect().top - top) < 2).length,
    };
  })()`;

const dialogExpression = `
  (() => {
    const el = document.querySelector("[role=alertdialog]");
    if (el === null) return null;
    return {
      title: el.querySelector(".dialog-title")?.textContent ?? null,
      focused: document.activeElement?.textContent ?? null,
      overlay: getComputedStyle(document.querySelector(".dialog-overlay")).backgroundColor,
      background: getComputedStyle(el).backgroundColor,
    };
  })()`;

/** A real click on the first cell, which also puts the keyboard focus in the grid. */
async function clickFirstCell() {
  const cell = await cdp.box(".cell");
  await cdp.mouse.click(cell.x, cell.y);
  await cdp.settle(
    "document.querySelectorAll('.cell[aria-selected=\"true\"]').length",
    (n) => n > 0,
  );
}

async function openMenu() {
  const cell = await cdp.box(".cell");
  await cdp.mouse.click(cell.x, cell.y, { button: "right" });
  return cdp.settle(
    "[...document.querySelectorAll('[role=menuitem]')].map((i) => i.textContent)",
    (list) => Array.isArray(list) && list.length > 0,
  );
}

const clickPlace = (name) => `
  (() => {
    const section = [...document.querySelectorAll(".sidebar-section")]
      .find((s) => s.querySelector(".sidebar-heading")?.textContent === "Places");
    [...(section?.querySelectorAll(".sidebar-row") ?? [])]
      .find((r) => r.querySelector(".sidebar-label")?.textContent === ${JSON.stringify(name)})?.click();
  })()`;

try {
  section("The Trash place");
  // `firstPaintAt` fires when the *grid* has rows, which is a different request
  // from the sidebar's — reading once here is a race, and it lost one.
  const places = await cdp.settle(
    placesExpression,
    (rows) => Array.isArray(rows) && rows.length > 0,
  );
  check(
    "it is in Places",
    places.some((p) => p.name === "Trash"),
  );
  check(
    "an empty trash still carries its count",
    places.find((p) => p.name === "Trash")?.count === "0",
    `count=${places.find((p) => p.name === "Trash")?.count}`,
  );

  section("Delete, over the grid");
  // The asset itself, not a count of rendered cells: the grid is virtualised,
  // so how many cells exist depends on how many fit, and "one fewer" stopped
  // being true the moment the inspector started holding its width.
  const doomed = await cdp.evaluate("document.querySelector('.cell')?.dataset.hash ?? null");
  await clickFirstCell();
  // The layout while something is selected, so the check after the delete has
  // something to compare against.
  const selectedLayout = await cdp.evaluate(statusExpression);
  // A real key press rather than a dispatched event: where the focus went after
  // the click is part of the claim, and a synthetic event on `document.body`
  // would pass whether the grid holds it or not.
  await cdp.keyboard.press("Delete");
  await cdp.settle(
    `[...document.querySelectorAll(".cell")].some((c) => c.dataset.hash === ${JSON.stringify(doomed)})`,
    (present) => present === false,
  );
  check("the asset leaves the grid", true, `${doomed?.slice(0, 8)}… gone`);

  const trashRow = await cdp.evaluate(
    `(${placesExpression}).find((p) => p.name === "Trash")?.count ?? null`,
  );
  check("the Trash count follows", trashRow === "1", `count=${trashRow}`);

  const status = await cdp.evaluate(statusExpression);
  // Both halves of one defect. The selection named an asset that is no longer
  // on screen — left alone it says "1 selected" over a grid with nothing
  // highlighted, and the inspector goes on editing a trashed asset. And the
  // status line has to survive the very selection change that clearing causes,
  // or an action can never say what it did.
  check(
    "the selection goes with it",
    !/selected/.test(status.total ?? ""),
    `total=${JSON.stringify(status.total)}`,
  );
  // The panel is always drawn (`UI_SPEC.md` §3), so it empties rather than
  // disappearing — and the grid keeps its width. Measured before that change:
  // selecting one asset took the grid from 1040px and four columns to 760px and
  // two, and deselecting took it back, so every cell moved twice per click on
  // the background.
  //
  // Width rather than column count: icons take the asset's own proportions by
  // default (ADR-0018), so how many fit on the first row depends on which
  // assets are in it, and removing one legitimately changes that.
  check("the inspector empties without vanishing", status.inspector === "empty", status.inspector);
  check(
    "the grid keeps its width whatever the selection does",
    status.gridWidth === selectedLayout.gridWidth,
    `${selectedLayout.gridWidth}px -> ${status.gridWidth}px`,
  );
  check(
    "and it still says what happened",
    status.note === "Moved 1 asset to the trash",
    `note=${JSON.stringify(status.note)}`,
  );
  check(
    "the total counts live assets only",
    status.total === `${ASSETS - 1} assets`,
    `total=${JSON.stringify(status.total)}`,
  );

  section("Inside the Trash");
  await cdp.evaluate(clickPlace("Trash"));
  await cdp.settle("document.querySelectorAll('.cell').length", (n) => n === 1);
  check("it shows what was trashed", true, "cells=1");
  check(
    "the search field shows the query that got there",
    (await cdp.evaluate("document.querySelector('.search-input')?.value ?? null")) === "is:trashed",
  );

  await clickFirstCell();
  const items = await openMenu();
  check(
    "Restore is offered",
    items.some((i) => i?.startsWith("Restore")),
  );
  check("Delete permanently is offered", items.includes("Delete permanently"));
  check("Empty trash is offered", items.includes("Empty trash"));
  // Never both spellings at once, or "delete" means two things in one menu.
  check("Move to trash is not", !items.some((i) => i?.includes("Move to trash")));

  section("The confirmation");
  await cdp.evaluate(
    '[...document.querySelectorAll("[role=menuitem]")].find((i) => i.textContent === "Delete permanently")?.click()',
  );
  const dialog = await cdp.settle(dialogExpression, (d) => d !== null);
  check("it appears", dialog !== null, `title=${JSON.stringify(dialog.title)}`);
  // The claim happy-dom could not make: a real browser decides where focus
  // lands, and an alert dialog focused on its destructive button is one stray
  // Enter away from being no dialog at all.
  check(
    "focus starts on Cancel",
    dialog.focused === "Cancel",
    `focused=${JSON.stringify(dialog.focused)}`,
  );
  check("the scrim is painted", dialog.overlay !== "rgba(0, 0, 0, 0)", dialog.overlay);
  check("the panel is painted", dialog.background !== "rgba(0, 0, 0, 0)", dialog.background);

  await cdp.keyboard.press("Escape");
  await sleep(400);
  check(
    "Escape cancels without deleting anything",
    (await trashedCount()) === 1,
    `trashed=${await trashedCount()}`,
  );

  section("Restore");
  await clickFirstCell();
  await openMenu();
  await cdp.evaluate(
    '[...document.querySelectorAll("[role=menuitem]")].find((i) => i.textContent?.startsWith("Restore"))?.click()',
  );
  await cdp.settle("document.querySelectorAll('.cell').length", (n) => n === 0);
  check("the asset leaves the Trash view", true, "cells=0");
  check("and is live again", (await trashedCount()) === 0);
  check(
    "an empty trash says so, rather than reporting a failed search",
    (await cdp.evaluate("document.querySelector('.grid-empty')?.textContent ?? null")) ===
      "The trash is empty.",
  );

  report();
} catch (error) {
  console.error(error);
  console.error(window.noise().slice(-4000));
  process.exitCode = 2;
} finally {
  await window.close();
  await dispose();
}

function trashedCount() {
  return cdp.evaluate(
    'window.roost.invoke({ type: "assets:count", query: "is:trashed" }).then((o) => o.value)',
  );
}
