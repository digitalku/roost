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
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { importInto, Library } from "@roost/library";
import { gradient } from "@roost/media";

const PORT = 9500 + (process.pid % 100);
const electron = createRequire(import.meta.url)("electron");
if (typeof electron !== "string") {
  console.error("electron is not installed (ELECTRON_SKIP_BINARY_DOWNLOAD?)");
  process.exit(2);
}

/** How many assets the fixture holds. Enough to page, few enough to be instant. */
const ASSETS = 12;

const scratch = await mkdtemp(join(tmpdir(), "roost-check-trash-"));
const root = join(scratch, "Check.roost");
await build(root, scratch);

const child = spawn(
  electron,
  [
    "apps/desktop/main/dist/main.js",
    `--remote-debugging-port=${PORT}`,
    "--ozone-platform-hint=auto",
  ],
  { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ROOST_LIBRARY: root } },
);
let noise = "";
child.stderr.on("data", (chunk) => {
  noise += chunk;
});

const failures = [];
let passed = 0;
function check(name, pass, saw) {
  console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}${saw === undefined ? "" : `   ${saw}`}`);
  if (pass) passed += 1;
  else failures.push(name);
}

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

/**
 * A click on the first cell, as pointer events rather than as `.click()`.
 *
 * The grid selects on `pointerdown`, so a bare click would leave the selection
 * empty and every assertion after it would be about nothing.
 */
const clickFirstCell = `
  (() => {
    const cell = document.querySelector(".cell");
    cell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    cell.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    cell.click();
  })()`;

const openMenu = `
  document.querySelector(".cell").dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }),
  )`;

const clickPlace = (name) => `
  (() => {
    const section = [...document.querySelectorAll(".sidebar-section")]
      .find((s) => s.querySelector(".sidebar-heading")?.textContent === "Places");
    [...(section?.querySelectorAll(".sidebar-row") ?? [])]
      .find((r) => r.querySelector(".sidebar-label")?.textContent === ${JSON.stringify(name)})?.click();
  })()`;

try {
  const cdp = await connect(PORT, () => noise);
  await cdp.evaluate(
    `window.roost.invoke({ type: "library:open", path: ${JSON.stringify(root)} })`,
  );
  await cdp.evaluate("location.reload()").catch(() => {});
  await settle(cdp, "window.roostBench?.firstPaintAt ?? null", (v) => typeof v === "number");

  console.log("The Trash place");
  // `firstPaintAt` fires when the *grid* has rows, which is a different request
  // from the sidebar's — reading once here is a race, and it lost one.
  const places = await settle(
    cdp,
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

  console.log("\nDelete, over the grid");
  // The asset itself, not a count of rendered cells: the grid is virtualised,
  // so how many cells exist depends on how many fit, and "one fewer" stopped
  // being true the moment the inspector started holding its width.
  const doomed = await cdp.evaluate("document.querySelector('.cell')?.dataset.hash ?? null");
  await cdp.evaluate(clickFirstCell);
  await settle(
    cdp,
    "document.querySelectorAll('.cell[aria-selected=\"true\"]').length",
    (n) => n === 1,
  );
  // The layout while something is selected, so the check after the delete has
  // something to compare against.
  const selectedLayout = await cdp.evaluate(statusExpression);
  await cdp.evaluate(
    'document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }))',
  );
  await settle(
    cdp,
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

  console.log("\nInside the Trash");
  await cdp.evaluate(clickPlace("Trash"));
  await settle(cdp, "document.querySelectorAll('.cell').length", (n) => n === 1);
  check("it shows what was trashed", true, "cells=1");
  check(
    "the search field shows the query that got there",
    (await cdp.evaluate("document.querySelector('.search-input')?.value ?? null")) === "is:trashed",
  );

  await cdp.evaluate(clickFirstCell);
  await cdp.evaluate(openMenu);
  const items = await settle(
    cdp,
    "[...document.querySelectorAll('[role=menuitem]')].map((i) => i.textContent)",
    (list) => Array.isArray(list) && list.length > 0,
  );
  check(
    "Restore is offered",
    items.some((i) => i?.startsWith("Restore")),
  );
  check("Delete permanently is offered", items.includes("Delete permanently"));
  check("Empty trash is offered", items.includes("Empty trash"));
  // Never both spellings at once, or "delete" means two things in one menu.
  check("Move to trash is not", !items.some((i) => i?.includes("Move to trash")));

  console.log("\nThe confirmation");
  await cdp.evaluate(
    '[...document.querySelectorAll("[role=menuitem]")].find((i) => i.textContent === "Delete permanently")?.click()',
  );
  const dialog = await settle(cdp, dialogExpression, (d) => d !== null);
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

  await cdp.evaluate(
    'document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))',
  );
  await sleep(400);
  check(
    "Escape cancels without deleting anything",
    (await trashedCount(cdp)) === 1,
    `trashed=${await trashedCount(cdp)}`,
  );

  console.log("\nRestore");
  await cdp.evaluate(clickFirstCell);
  await cdp.evaluate(openMenu);
  await settle(cdp, "[...document.querySelectorAll('[role=menuitem]')].length", (n) => n > 0);
  await cdp.evaluate(
    '[...document.querySelectorAll("[role=menuitem]")].find((i) => i.textContent?.startsWith("Restore"))?.click()',
  );
  await settle(cdp, "document.querySelectorAll('.cell').length", (n) => n === 0);
  check("the asset leaves the Trash view", true, "cells=0");
  check("and is live again", (await trashedCount(cdp)) === 0);
  check(
    "an empty trash says so, rather than reporting a failed search",
    (await cdp.evaluate("document.querySelector('.grid-empty')?.textContent ?? null")) ===
      "The trash is empty.",
  );

  console.log("");
  if (failures.length > 0) {
    console.log(`${failures.length} of ${failures.length + passed} checks failed`);
    process.exitCode = 1;
  } else {
    console.log(`all ${passed} checks passed`);
  }
} catch (error) {
  console.error(error);
  console.error(noise.slice(-4000));
  process.exitCode = 2;
} finally {
  child.kill("SIGTERM");
  await sleep(300);
  child.kill("SIGKILL");
  await rm(scratch, { recursive: true, force: true });
}

/** A throwaway library with a handful of real images in it. */
async function build(path, dir) {
  const source = join(dir, "pictures");
  await mkdir(source, { recursive: true });
  for (let index = 0; index < ASSETS; index += 1) {
    await writeFile(join(source, `shot-${index}.png`), await gradient(64, 64, index + 1, "png"));
  }
  const library = await Library.create(path, "Check");
  try {
    await importInto(library, [source]);
  } finally {
    await library.close();
  }
}

function trashedCount(cdp) {
  return cdp.evaluate(
    'window.roost.invoke({ type: "assets:count", query: "is:trashed" }).then((o) => o.value)',
  );
}

/** Polls an expression until it satisfies `ok`, so nothing here races a render. */
async function settle(cdp, expression, ok) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await cdp.evaluate(expression).catch(() => undefined);
    if (ok(value)) return value;
    await sleep(100);
  }
  throw new Error(`never settled: ${expression.trim().slice(0, 120)}`);
}

async function connect(port, log) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page !== undefined) return await session(page.webSocketDebuggerUrl);
    } catch {
      // The port is not listening yet, which is ordinary for the first second.
    }
    await sleep(250);
  }
  throw new Error(`no page target after 20s\n${log()}`);
}

async function session(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  let id = 0;
  const pending = new Map();
  socket.onmessage = (message) => {
    const reply = JSON.parse(message.data);
    const waiting = pending.get(reply.id);
    if (waiting === undefined) return;
    pending.delete(reply.id);
    if (reply.error) waiting.reject(new Error(JSON.stringify(reply.error)));
    else waiting.resolve(reply.result);
  };

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  return {
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails !== undefined) {
        throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
      }
      return result.result.value;
    },
  };
}
