/**
 * Folders drawn in the grid, asserted against a **running window** (ADR-0043).
 *
 *     node scripts/check-folder-tiles.mjs
 *
 * **It builds its own library** in a temporary directory and deletes it again:
 * a folder `Projects` holding five subfolders and nothing of its own — one with
 * six pictures, one with one, one with two, one empty, and one that holds only
 * a subfolder of three.
 *
 * What only a window can say. **The covers are drawn** — `roost://thumb`
 * addresses the engine named, decoded by Chromium — and in the order the user
 * chose on 2026-09-25: newest first, the folder's own before its subfolders'.
 * **A folder of folders draws its folders**, which it did not until the same
 * day: it said *"Nothing matches this query"* over an empty grid. And **a
 * double-click opens the folder without landing a preview on it**, which is the
 * hazard ADR-0043 chose Explorer's gesture against, and which happy-dom cannot
 * see because it fires both clicks at a DOM that never re-rendered.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFolder, importInto, Library, runDerives } from "@roost/library";
import { GRID_SIZE, gradient } from "@roost/media";
import { ledger } from "./lib/checks.mjs";
import { scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

const { dir, dispose } = await scratch("check-folder-tiles");
const root = await library(dir);
const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

/** Every tile on screen: its name, how many pictures it draws, and how many loaded. */
const tilesExpression = `
  [...document.querySelectorAll(".cell-folder")].map((tile) => ({
    name: tile.querySelector(".cell-name-text")?.textContent ?? null,
    covers: tile.querySelectorAll(".folder-sheet-image").length,
    loaded: [...tile.querySelectorAll(".folder-sheet-image")].filter((i) => i.naturalWidth > 0).length,
    holes: tile.querySelectorAll(".folder-hole").length,
  }))`;

try {
  // Lazy images are only fetched in a window Chromium is drawing, and a
  // check's window may be behind another; a fixed viewport and the front are
  // what the screenshots that designed this were taken with.
  await cdp.send("Page.bringToFront");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  });

  section("A folder that holds only folders");
  const row = await cdp.settle(
    `(() => {
      const r = [...document.querySelectorAll(".sidebar-row")].find((r) => r.textContent.includes("Projects"));
      if (!r) return null;
      const b = r.getBoundingClientRect();
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    })()`,
    (box) => box !== null,
  );
  await cdp.mouse.click(row.x, row.y);
  // Every tile first, pictures or not.
  await cdp.settle(tilesExpression, (list) => Array.isArray(list) && list.length === 5);
  /*
   * Then the pictures, which are lazy: Chromium fetches a lazy image only in a
   * frame it draws, and a check's window behind somebody's editor draws about
   * one frame in 400 ms (measured 2026-09-25, as `check-grid.mjs` found before).
   * A screenshot is a frame on demand, so each attempt asks for one rather
   * than waiting for a compositor that is not coming.
   */
  let tiles = await cdp.evaluate(tilesExpression);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (tiles.every((t) => t.loaded === t.covers)) break;
    await cdp.screenshot();
    await new Promise((resolve) => setTimeout(resolve, 100));
    tiles = await cdp.evaluate(tilesExpression);
  }
  const empty = await cdp.evaluate(`document.querySelector(".grid-empty")?.textContent ?? null`);
  check("its five folders are drawn", tiles.length === 5, tiles.map((t) => t.name).join(", "));
  check("rather than saying nothing matches", empty === null, JSON.stringify(empty));
  const places = await cdp.evaluate(`
    [...document.querySelectorAll(".cell-folder")].map((t) => {
      const b = t.getBoundingClientRect();
      return Math.round(b.left) + "," + Math.round(b.top);
    })`);
  check(
    "laid out side by side, not overlaid",
    new Set(places).size === places.length,
    places.join(" "),
  );

  section("The covers");
  const by = Object.fromEntries(tiles.map((t) => [t.name, t]));
  check("four of six, drawn by Chromium", by.Design?.covers === 4 && by.Design?.loaded === 4);
  check("one fills the sheet", by.Single?.covers === 1);
  check("two are two", by.Pair?.covers === 2);
  check("an empty folder is an empty sleeve", by.Empty?.covers === 0);
  check(
    "a folder of folders shows what is below it",
    by["Only folders"]?.covers === 3,
    `${by["Only folders"]?.covers} pictures`,
  );
  check(
    "every sleeve is punched",
    tiles.every((t) => t.holes === 6),
  );
  const order = await cdp.evaluate(`
    [...document.querySelectorAll('.cell-folder')]
      .find((t) => t.querySelector('.cell-name-text')?.textContent === 'Design')
      ?.querySelector('.folder-sheet-image')?.getAttribute('src') ?? null`);
  const newest = await cdp.evaluate(
    `window.roost.invoke({ type: "folder:covers", folders: [${await folderId("Design")}] }).then((o) => o.value[0].assets[0].id)`,
  );
  check(
    "the first picture is the newest",
    typeof order === "string" && order.includes(newest),
    `${order} / ${newest}`,
  );

  section("A folder's row, in Details and Compact");
  /*
   * A row draws the sleeve without pictures, the user's call of 2026-09-25 —
   * but a sleeve that still reads as a folder. Scaled from the Icons tile its
   * holes were a pixel wide and the row showed a grey rectangle, so the punch
   * is sized in pixels there, and this is what asserts it is on screen.
   */
  const rowsExpression = `
    [...document.querySelectorAll(".cell-folder")].map((tile) => ({
      name: tile.querySelector(".cell-name-text")?.textContent ?? null,
      pictures: tile.querySelectorAll(".folder-sheet-image").length,
      holes: [...tile.querySelectorAll(".folder-hole")]
        .map((hole) => hole.getBoundingClientRect())
        .filter((box) => box.width >= 2 && box.height >= 2).length,
    }))`;
  for (const view of ["details", "compact"]) {
    await setView(view);
    const rows = await cdp.evaluate(rowsExpression);
    if (process.env.ROOST_SHOTS !== undefined) {
      await cdp.screenshot(join(process.env.ROOST_SHOTS, `folder-rows-${view}.png`));
    }
    check(`${view}: every folder is a row`, rows.length === 5, rows.map((r) => r.name).join(", "));
    check(
      `${view}: no pictures in a row's sleeve`,
      rows.every((r) => r.pictures === 0),
      rows.map((r) => `${r.name}=${r.pictures}`).join(" "),
    );
    check(
      `${view}: three holes, each big enough to see`,
      rows.every((r) => r.holes === 3),
      rows.map((r) => `${r.name}=${r.holes}`).join(" "),
    );
  }
  await setView("icons");

  section("Double-clicking a folder");
  const design = await cdp.box(`.cell-folder[aria-label^="Design"]`);
  await cdp.mouse.click(design.x, design.y, { clickCount: 1 });
  await cdp.mouse.click(design.x, design.y, { clickCount: 2 });
  const opened = await cdp.settle(
    `document.querySelector('input[type="search"]')?.value ?? null`,
    (value) => typeof value === "string" && value.includes("Design"),
  );
  await cdp.settle(`document.querySelectorAll(".cell:not(.cell-folder)").length`, (n) => n === 6);
  const preview = await cdp.evaluate(`document.querySelector(".preview") !== null`);
  check("opens the folder", opened.includes("Projects/Design"), opened);
  check("and does not land a preview on what it opened", preview === false);

  report();
} catch (error) {
  console.error(error);
  console.error(window.noise().slice(-4000));
  process.exitCode = 2;
} finally {
  await window.close();
  await dispose();
}

/** Switches the view by its shortcut and waits for the grid to be drawn in it. */
async function setView(view) {
  await cdp.keyboard.press(String(["icons", "compact", "details"].indexOf(view) + 1), {
    ctrl: true,
  });
  await cdp.settle(
    `document.querySelector(".grid")?.dataset.view ?? null`,
    (seen) => seen === view,
  );
}

/** A folder's id, read from the sidebar the window already holds. */
async function folderId(name) {
  return cdp.evaluate(
    `window.roost.invoke({ type: "library:sidebar" }).then((o) => o.value.folders.find((f) => f.name === ${JSON.stringify(name)}).folder)`,
  );
}

/** `Projects`, five subfolders, and nothing of its own. */
async function library(where) {
  const path = join(where, "Tiles.roost");
  const made = await Library.create(path, "Tiles");
  try {
    const parent = await createFolder(made, "Projects", null);
    let seed = 1;
    const fill = async (folder, name, count) => {
      const source = join(where, `src-${name}`);
      await mkdir(source, { recursive: true });
      for (let n = 0; n < count; n += 1) {
        seed += 7;
        await writeFile(join(source, `${name}-${n}.png`), await gradient(96, 72, seed, "png"));
      }
      await importInto(made, [source], { folder });
    };
    await fill(await createFolder(made, "Design", parent), "design", 6);
    await fill(await createFolder(made, "Single", parent), "single", 1);
    await fill(await createFolder(made, "Pair", parent), "pair", 2);
    await createFolder(made, "Empty", parent);
    const only = await createFolder(made, "Only folders", parent);
    await fill(await createFolder(made, "Kid", only), "kid", 3);
    await runDerives(made, { sizes: [GRID_SIZE] });
  } finally {
    await made.close();
  }
  return path;
}
