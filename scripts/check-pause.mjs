/**
 * Pausing the derive queue, asserted against a **running window** (ADR-0049).
 *
 *     node scripts/check-pause.mjs
 *
 * **It builds its own library** in a temporary directory and deletes it again:
 * two thousand pictures imported and none of them derived, with the engine on
 * a threadpool of one, so that the queue is still going when the × is pressed.
 *
 * What it walks through is the request as the user made it: press × while the
 * queue is working, see that something is left and how to carry on — in the
 * status bar and in the ☰ — close the window and find it still paused, open
 * one file and watch that one be drawn, and then resume.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { importInto, Library } from "@roost/library";
import { gradient } from "@roost/media";
import { ledger } from "./lib/checks.mjs";
import { scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

const COUNT = 2000;
const ENV = { UV_THREADPOOL_SIZE: "1" };

const { dir, dispose } = await scratch("check-pause");

/*
 * Three damaged PNGs imported **last**, which puts them at the top of a grid
 * sorted newest first — on screen, so the queue does them first (`Wanted`) and
 * they have failed long before the pictures are done. The status bar then has a
 * problem it could show while it is still counting — and must not: since
 * ADR-0050 it is progress only, and a failure is told on the file. Imported
 * first, they sat at the far end of both orders.
 */
const broken = join(dir, "broken");
const pictures = join(dir, "pictures");
await mkdir(broken, { recursive: true });
await mkdir(pictures, { recursive: true });
for (let n = 0; n < 3; n += 1) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(join(broken, `torn-${n}.png`), Buffer.concat([header, Buffer.alloc(64 + n)]));
}
for (let n = 0; n < COUNT; n += 1) {
  await writeFile(join(pictures, `shot-${n}.png`), await gradient(256, 256, n + 1, "png"));
}
const root = join(dir, "Check.roost");
const made = await Library.create(root, "Check");
try {
  await importInto(made, [pictures]);
  // `imported_at` is in seconds and two thousand pictures import in under one:
  // without a second between them, the three share it with the pictures, the
  // grid orders the tie by random id, and they land nowhere near the screen.
  await sleep(1_100);
  await importInto(made, [broken]);
} finally {
  await made.close();
}
const { check, section, report } = ledger();

const statusText = `[...document.querySelectorAll(".status .status-job")].map((e) => e.textContent).join(" | ")`;
const queued = `window.roost.invoke({ type: "derive:status" }).then((o) => o.value)`;
const settings = async () => JSON.parse(await readFile(join(root, "settings.json"), "utf8"));

/** What the first window left queued, for the second to compare against. */
let left = 0;

let window = await launch({ library: root, env: ENV });
try {
  const { cdp } = window;
  section("while the queue is working");

  const running = await cdp.settle(statusText, (text) => /Deriving…/.test(text ?? ""), {
    attempts: 200,
  });
  check("the status bar counts the work", /Deriving… [\d,]+ to go/.test(running), running);
  const cross = await cdp.box('button[aria-label="Pause deriving"]');
  check("a × stands beside the count", cross !== null);
  await cdp.settle(queued, (status) => status?.failed === 3);
  const working = await cdp.evaluate(statusText);
  check(
    "what failed is not counted beside it — the file says it (ADR-0050)",
    /Deriving…/.test(working) && !/could not be drawn/.test(working),
    working,
  );

  section("pressing ×");

  await cdp.mouse.click(cross.x, cross.y);
  const paused = await cdp
    .settle(statusText, (text) => /Paused/.test(text ?? ""))
    .catch(async () => `never paused; the bar said: ${await cdp.evaluate(statusText)}`);
  check("the status bar says what is left", /Paused · [\d,]+ left/.test(paused), paused);
  check("and nothing about what failed", !/could not be drawn/.test(paused), paused);
  check(
    "and offers to resume",
    (await cdp.box(".status-job-action")) !== null &&
      (await cdp.evaluate(`document.querySelector(".status-job-action").textContent`)) === "Resume",
  );
  // What is in flight finishes; after that, nothing moves.
  await sleep(1500);
  const settled = await cdp.evaluate(queued);
  await sleep(2000);
  const later = await cdp.evaluate(queued);
  check("the engine says it is paused", settled.paused === true);
  check(
    "and nothing more is derived",
    later.ready === settled.ready && settled.ready > 0,
    `${settled.ready} → ${later.ready} left`,
  );
  check("the library remembers it", (await settings()).derivePaused === true);

  // Up to three presses: the status bar re-reads the queue every 1.5 s, and a
  // press that lands on that re-render has been seen to open nothing.
  let items = [];
  for (let press = 0; press < 3 && items.length === 0; press += 1) {
    const menu = await cdp.box(".app-menu-trigger");
    await cdp.mouse.click(menu.x, menu.y);
    items = await cdp
      .settle(
        `[...document.querySelectorAll("[role=menuitem]")].map((e) => e.textContent)`,
        (list) => Array.isArray(list) && list.length > 0,
        { attempts: 20 },
      )
      .catch(() => []);
  }
  check(
    "the ☰ offers to resume, with the count",
    items[0] === `Resume deriving (${later.ready.toLocaleString("en")} left)`,
    items[0],
  );
  await cdp.keyboard.press("Escape");
  left = later.ready;
} finally {
  await window.close();
}

window = await launch({ library: root, env: ENV });
try {
  const { cdp } = window;
  section("reopened");

  await sleep(1500);
  const reopened = await cdp.evaluate(queued);
  check("it is still paused", reopened.paused === true);
  check("and has derived nothing on its own", reopened.ready === left, `${reopened.ready} left`);

  section("opening a file with no picture");

  // One inside the grid's own viewport. The grid draws cells above and below
  // it as well, and the first draft of this picked one of those: its middle was
  // under the status bar, and the click that was meant to open a file pressed
  // Resume instead — which then read as "opening a file resumes everything".
  //
  // Not one of the three damaged files, which have no picture for good and
  // nothing queued — opening one draws nothing, correctly, and the first run
  // with them in the library picked one.
  //
  // Scrolled for, because the screen the window opens on is exactly what was
  // drawn first. Scrolling a paused grid asks for nothing to be drawn, so what
  // is found undrawn stays undrawn until it is opened.
  const visibleUndrawn = `
    (() => {
      const view = document.querySelector(".grid").getBoundingClientRect();
      return [...document.querySelectorAll(".cell")].find((c) => {
        const r = c.getBoundingClientRect();
        return c.querySelector(".cell-image")?.hidden &&
          c.querySelector(".placeholder-badge") === null &&
          r.top >= view.top && r.bottom <= view.bottom;
      })?.dataset.id ?? null;
    })()`;
  let id = null;
  for (const at of [0, 0.5, 0.25, 0.75, 1]) {
    await cdp.evaluate(`(() => {
      const grid = document.querySelector(".grid");
      grid.scrollTop = ${at} * (grid.scrollHeight - grid.clientHeight);
    })()`);
    await sleep(600);
    id = await cdp.evaluate(visibleUndrawn);
    if (id !== null) break;
  }
  check("the grid has an undrawn cell to open", id !== null);
  const cell = await cdp.box(`[data-id="${id}"]`);
  await cdp.mouse.click(cell.x, cell.y);
  const drawn = await cdp
    .settle(
      `(() => { const i = document.querySelector('[data-id="${id}"] .cell-image'); return i !== null && !i.hidden && i.naturalWidth > 0; })()`,
      (value) => value === true,
      { attempts: 100 },
    )
    .catch(() => false);
  check("its picture is made on the spot", drawn === true);
  await sleep(1000);
  const after = await cdp.evaluate(queued);
  check("and only its picture", after.ready === left - 1, `${left} → ${after.ready} left`);

  section("Resume");

  const resume = await cdp.box(".status-job-action");
  await cdp.mouse.click(resume.x, resume.y);
  const moving = await cdp.settle(statusText, (text) => /Deriving…/.test(text ?? ""));
  check("the status bar is counting again", /Deriving…/.test(moving), moving);
  await sleep(2000);
  const resumed = await cdp.evaluate(queued);
  check(
    "the queue is being worked",
    resumed.ready < after.ready,
    `${after.ready} → ${resumed.ready} left`,
  );
  check("the library forgets the pause", (await settings()).derivePaused === false);
} finally {
  await window.close();
  await dispose();
}

report();
