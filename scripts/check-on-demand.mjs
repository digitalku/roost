/**
 * Thumbnails drawn as they are looked at, asserted against a **running window**
 * (ADR-0065).
 *
 *     node scripts/check-on-demand.mjs
 *
 * **It builds its own library** in a temporary directory and deletes it again:
 * two thousand pictures imported and none of them derived, with the engine on a
 * threadpool of one, so that a screen can be caught before it is finished.
 *
 * The claim is about three things at once, which is why it is a window check:
 * the grid says where it came to rest, the engine draws those and no others, and
 * the cell redraws when the derive event arrives. It also proves the one thing
 * that still runs unasked: a file another application saved is drawn while
 * somebody watches its cell.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { importInto, Library } from "@roost/library";
import { gradient } from "@roost/media";
import { ledger } from "./lib/checks.mjs";
import { scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

const COUNT = 2000;
/** What the queue may have started before a list changed under it. */
const WORKERS = 16;
const ENV = { UV_THREADPOOL_SIZE: "1" };

const { dir, dispose } = await scratch("check-on-demand");
const pictures = join(dir, "pictures");
await mkdir(pictures, { recursive: true });
for (let n = 0; n < COUNT; n += 1) {
  await writeFile(join(pictures, `p${n}.jpg`), await gradient(320, 240, n + 1, "jpeg"));
}
const root = join(dir, "OnDemand.roost");
const made = await Library.create(root, "OnDemand");
try {
  await importInto(made, [pictures]);
} finally {
  await made.close();
}

const { check, section, report } = ledger();
const statusText = `[...document.querySelectorAll(".status .status-job")].map((e) => e.textContent).join(" | ")`;
const queued = `window.roost.invoke({ type: "derive:status" }).then((o) => o.value)`;

/** Cells inside the grid's own viewport, and how many have no picture yet. */
const onScreen = `
  (() => {
    const view = document.querySelector(".grid").getBoundingClientRect();
    const cells = [...document.querySelectorAll(".cell")].filter((c) => {
      const r = c.getBoundingClientRect();
      return r.bottom > view.top && r.top < view.bottom;
    });
    return {
      cells: cells.length,
      undrawn: cells.filter((c) => !(c.querySelector(".cell-image")?.naturalWidth > 0)).length,
    };
  })()`;

const window = await launch({ library: root, env: ENV });
const { cdp } = window;

/** The queue once it has stopped moving, which it does when the screen is drawn. */
const settled = async () => {
  let last = await cdp.evaluate(queued);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(1000);
    const now = await cdp.evaluate(queued);
    if (now.ready === last.ready) return now;
    last = now;
  }
  return last;
};

/** A screen is drawn once each of its pictures has also arrived in the cell. */
const drawnScreen = async () => {
  let seen;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    seen = await cdp.evaluate(onScreen);
    if (seen.undrawn === 0) return seen;
    await cdp.send("Page.captureScreenshot");
    await sleep(250);
  }
  return seen;
};

const scrollTo = (at) =>
  cdp.evaluate(`(() => {
    const grid = document.querySelector(".grid");
    grid.scrollTop = ${at} * (grid.scrollHeight - grid.clientHeight);
  })()`);

try {
  await cdp.send("Page.bringToFront");

  section("opening a library");
  const opened = await settled();
  const first = await drawnScreen();
  check("what is on screen has its pictures", first.undrawn === 0, JSON.stringify(first));
  const drawn = COUNT - opened.ready;
  check(
    "and only those are drawn",
    drawn > 0 && drawn <= first.cells + WORKERS,
    `${drawn} of ${COUNT}`,
  );

  section("the status bar");
  const line = await cdp.settle(statusText, (text) => /not drawn yet/.test(text ?? ""));
  check("it counts what is left", /[\d,]+ thumbnails not drawn yet/.test(line), line);
  check("with nothing to pause or resume", !/×|Resume|Deriving/.test(line), line);
  const info = await cdp.box(".status-job-info");
  await cdp.mouse.click(info.x, info.y);
  const note = await cdp
    .settle(
      `document.querySelector(".derive-note")?.textContent ?? ""`,
      (text) => text.length > 0,
      { attempts: 30 },
    )
    .catch(() => "");
  check("pressed, it says how they get drawn", /as you use Roost/.test(note), note);
  await cdp.keyboard.press("Escape");
  const after = await cdp.evaluate(queued);
  check("and starts nothing", after.ready === opened.ready, `${after.ready} left`);
  const menu = await cdp.box(".app-menu-trigger");
  await cdp.mouse.click(menu.x, menu.y);
  const rows = await cdp.settle(
    `[...document.querySelectorAll("[role=menuitem]")].map((e) => e.textContent)`,
    (list) => Array.isArray(list) && list.length > 0,
  );
  check("the ☰ has no Resume", !rows.some((row) => row.startsWith("Resume")), rows[0]);
  await cdp.keyboard.press("Escape");

  section("scrolling");
  // Faster than a screen counts as at rest, so nothing passed is drawn for
  // nobody, and only the screen it stops on is.
  for (const at of [0.2, 0.4, 0.6, 0.8]) {
    await scrollTo(at);
    await sleep(40);
  }
  const scrolled = await settled();
  const landed = await drawnScreen();
  check("the screen it stops on is drawn", landed.undrawn === 0, JSON.stringify(landed));
  const spent = opened.ready - scrolled.ready;
  check(
    "and what it passed still waits",
    spent <= landed.cells + WORKERS,
    `${spent} drawn of ${opened.ready}`,
  );

  section("opening a file");
  // Caught as it arrives on screen, with one worker drawing them.
  const visibleUndrawn = `
    (() => {
      const view = document.querySelector(".grid").getBoundingClientRect();
      return [...document.querySelectorAll(".cell")].find((c) => {
        const r = c.getBoundingClientRect();
        return !(c.querySelector(".cell-image")?.naturalWidth > 0) &&
          r.top >= view.top && r.bottom <= view.bottom;
      })?.dataset.id ?? null;
    })()`;
  let id = null;
  for (const at of [0.5, 0.25, 0.75, 0.1, 0.9]) {
    await scrollTo(at);
    await sleep(50);
    id = await cdp.evaluate(visibleUndrawn);
    if (id !== null) break;
  }
  check("the grid has an undrawn cell to open", id !== null);
  const cell = await cdp.box(`[data-id="${id}"]`);
  await cdp.mouse.click(cell.x, cell.y);
  const opensDrawn = await cdp
    .settle(
      `document.querySelector('[data-id="${id}"] .cell-image')?.naturalWidth > 0`,
      (value) => value === true,
      { attempts: 100 },
    )
    .catch(() => false);
  check("its picture is made", opensDrawn === true);

  section("a file another application saved");
  // On screen and drawn, so nothing about the grid will ask for it again.
  await settled();
  const picture = await cdp.evaluate(`(() => {
    const image = document.querySelector('[data-id="${id}"] .cell-image');
    return image?.getAttribute("src") ?? null;
  })()`);
  const detail = await cdp.evaluate(
    `window.roost.invoke({ type: "asset:detail", id: ${JSON.stringify(id)} }).then((o) => o.value)`,
  );
  // Written behind the engine's back, as `check-workspace.mjs` does.
  const path = join(root, "files", id.slice(0, 2), `${id}.${detail.ext}`);
  await sleep(1100);
  await appendFile(path, "saved by another application");
  const moved = await cdp
    .settle(
      `document.querySelector('[data-id="${id}"] .cell-image')?.getAttribute("src")`,
      (src) => typeof src === "string" && src !== picture,
      { attempts: 100 },
    )
    .catch(() => null);
  check("its cell is drawn again, unasked", moved !== null, String(moved));
} catch (error) {
  console.error(error);
  process.exitCode = 2;
} finally {
  await window.close();
  await dispose();
  report();
}
