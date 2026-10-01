/**
 * The folder is the library's name, asserted against a **running window**
 * (ADR-0056).
 *
 *     node scripts/check-rename.mjs
 *
 * The component tests drive the dialog and the notice against a fake engine.
 * What only a window can say is the half between the processes: that main lets
 * go of its read-only connection before the folder moves and takes it up again
 * at the new path, so that the thumbnails still arrive, and that a folder
 * renamed from outside while it is open is noticed, closed, and offered back
 * without the old path being made again.
 *
 * **It builds its own library** in a temporary directory, renames it twice, and
 * deletes it again.
 */
import { existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { ledger } from "./lib/checks.mjs";
import { imageLibrary, scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

const centreOfText = (cdp, selector, text) =>
  cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((node) => node.textContent.trim() === ${JSON.stringify(text)});
    if (el === undefined) return null;
    const box = el.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);

const clickText = async (cdp, selector, text) => {
  const at = await centreOfText(cdp, selector, text);
  if (at === null) throw new Error(`no ${selector} saying ${text}`);
  await cdp.mouse.click(at.x, at.y);
};

const heading = (cdp, name) =>
  cdp.settle(`document.querySelector(".bar-title")?.textContent ?? null`, (seen) => seen === name);

/** How many grid pictures have arrived through `roost://`, decoded. */
const picturesDrawn = (cdp) =>
  cdp.settle(
    `[...document.querySelectorAll(".grid img")].filter((img) => img.complete && img.naturalWidth > 0).length`,
    (count) => typeof count === "number" && count >= 3,
    { attempts: 150 },
  );

const { dir, dispose } = await scratch("check-rename");
const first = await imageLibrary(dir, { count: 3, size: 64, name: "traveling" });
const second = join(dir, "trip.roost");
const third = join(dir, "holiday.roost");
const window = await launch({ library: first });
const { cdp } = window;
const { check, section, report } = ledger();

try {
  section("Rename library… from the ☰");
  await heading(cdp, "traveling");
  await picturesDrawn(cdp);
  const trigger = await cdp.evaluate(`(() => {
    const box = document.querySelector(".app-menu-trigger").getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  await cdp.mouse.click(trigger.x, trigger.y);
  await cdp.settle(
    `[...document.querySelectorAll('[role="menuitem"]')].some((node) => node.textContent.trim() === "Rename library…")`,
    (seen) => seen === true,
  );
  await clickText(cdp, '[role="menuitem"]', "Rename library…");
  const prefilled = await cdp.settle(
    `document.querySelector("#library-rename")?.value ?? null`,
    (value) => typeof value === "string",
  );
  check("the field starts with the library's name", prefilled === "traveling", prefilled);

  await cdp.evaluate(`document.querySelector("#library-rename").select()`);
  await cdp.send("Input.insertText", { text: "trip" });
  const said = await cdp.settle(
    `document.querySelector(".dialog-body code")?.textContent ?? ""`,
    (text) => text === "trip.roost",
  );
  check("the dialog names the folder it will become", said === "trip.roost", said);

  await clickText(cdp, "button", "Rename");
  await heading(cdp, "trip");
  check("the head says the new name", true);
  check("the folder was renamed", existsSync(second) && !existsSync(first));
  const manifest = JSON.parse(await readFile(join(second, "library.json"), "utf8"));
  check("library.json records it", manifest.name === "trip", manifest.name);

  // A reload draws the grid again from nothing, so every picture comes through
  // main's connection, which has to be at the new path.
  await cdp.evaluate("location.reload()").catch(() => {});
  await heading(cdp, "trip");
  check("the pictures still arrive after a reload", (await picturesDrawn(cdp)) >= 3);

  section("renamed from outside while it is open");
  await rename(second, third);
  const notice = await cdp.settle(
    `document.querySelector(".lost-notice p")?.textContent ?? null`,
    (text) => typeof text === "string",
    { attempts: 60 },
  );
  check(
    "the window goes back to the picker and says why",
    notice.startsWith("trip was renamed to holiday while it was open"),
    notice,
  );
  check("the old folder is not made again", !existsSync(second));

  await clickText(cdp, "button", "Open holiday");
  await heading(cdp, "holiday");
  check("Open holiday opens it where it went", true);
  check("and its pictures arrive", (await picturesDrawn(cdp)) >= 3);
  const kept = JSON.parse(await readFile(join(third, "library.json"), "utf8"));
  check("a rename from outside leaves library.json alone (RL-7b)", kept.name === "trip", kept.name);
} catch (error) {
  console.error(error);
  console.error(window.noise().slice(-4000));
  process.exitCode = 2;
} finally {
  await window.close();
  await dispose();
  report();
}
