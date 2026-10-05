/**
 * A thumbnail somebody chose, asserted against a **running window** and the
 * desktop's own clipboard (ADR-0060).
 *
 *     node scripts/check-thumbnail.mjs
 *
 * The component tests prove the menu asks for the right thing, and the library
 * tests that the pictures are drawn, kept and never drawn over. What only a
 * window can say is the whole of it at once: main reading what another
 * application put on the clipboard, the engine drawing it, and the cell
 * changing in front of the person who asked, with the extension still on it.
 * It writes the clipboard with `wl-copy`, so it needs a Wayland session with
 * `wl-clipboard` installed and says so plainly otherwise.
 *
 * **The window runs under XWayland**, as `check-clipboard.mjs`'s does and for
 * its reason: what a desktop lets a window that is not in front do with the
 * clipboard is not what this is checking.
 *
 * *Set thumbnail from file…* opens the system's dialog, which nothing here can
 * drive, so it is not covered: only that its row is there.
 *
 * **It replaces what is on your clipboard.** It builds its own library in a
 * temporary directory and deletes it again.
 */
import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { importInto, Library, runDerives } from "@roost/library";
import { GRID_SIZE, gradient } from "@roost/media";
import { ledger } from "./lib/checks.mjs";
import { scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

/** Puts `input` on the clipboard as `type`, or clears it when there is none. */
const copy = (type, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("wl-copy", input === undefined ? ["--clear"] : ["--type", type], {
      // Not inherited: the copy `wl-copy` leaves behind to serve the
      // selection would hold this process's output open, and a pipe reading it
      // would never end.
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    // `wl-copy` forks to serve the selection and the parent exits once it has
    // it, which is the moment the clipboard holds it.
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`wl-copy ${code}`))));
    if (input === undefined) child.stdin.end();
    else if (typeof input === "string") child.stdin.end(input);
    else input.pipe(child.stdin);
  });

const hasClipboard = await new Promise((resolve) =>
  execFile("wl-copy", ["--version"], (error) => resolve(error === null)),
);
if (process.env.WAYLAND_DISPLAY === undefined || !hasClipboard) {
  console.log("needs a Wayland session with wl-copy (wl-clipboard) to write the clipboard");
  process.exit(1);
}

const { dir, dispose } = await scratch("check-thumbnail");
const { root, pictures } = await library(dir);
const window = await launch({ library: root, args: ["--ozone-platform=x11"] });
const { cdp } = window;
const { check, section, report } = ledger();

/** One cell, by the name the library shows. */
const cell = (name) => `.cell[aria-label="${name}"]`;

/** What one cell is drawing, in one round trip. */
const drawn = (name) =>
  cdp.evaluate(`(() => {
    const cell = document.querySelector(${JSON.stringify(cell(name))});
    const image = cell?.querySelector(".cell-image");
    const label = cell?.querySelector(".cell-ext");
    return {
      src: image?.getAttribute("src") ?? null,
      loaded: image !== null && image !== undefined && image.hasAttribute("data-loaded") && !image.hidden && image.naturalWidth > 0,
      label: label !== null && label !== undefined && getComputedStyle(label).display !== "none" ? label.textContent : null,
      badge: cell?.querySelector(".placeholder-badge") !== null && cell?.querySelector(".placeholder-badge") !== undefined,
    };
  })()`);

/** Waits for one cell to be drawing what `ready` asks, asking for a frame each time. */
const until = async (name, ready) => {
  let seen;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    seen = await drawn(name);
    if (ready(seen)) return seen;
    await cdp.send("Page.captureScreenshot");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return seen;
};

/** The status bar's line once it says something other than `before`. */
const note = (before = "") =>
  cdp
    .settle(
      `document.querySelector(".status-note")?.textContent ?? ""`,
      (line) => typeof line === "string" && line.length > 0 && line !== before,
      { attempts: 50 },
    )
    .catch(() => "");

/** The menu's rows over one cell, right-clicked. */
const menuOver = async (name) => {
  const box = await cdp.box(cell(name));
  await cdp.mouse.click(box.x, box.y, { button: "right" });
  return cdp.settle(
    `[...document.querySelectorAll('[role=menuitem]')].map((i) => i.textContent)`,
    (rows) => Array.isArray(rows) && rows.length > 0,
  );
};

/** Chooses one row of the menu that is open. */
const pick = async (row) => {
  const box = await cdp.evaluate(`(() => {
    const item = [...document.querySelectorAll('[role=menuitem]')].find((i) => i.textContent === ${JSON.stringify(row)});
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (box === null) throw new Error(`no row called "${row}"`);
  await cdp.mouse.click(box.x, box.y);
};

const closeMenu = async () => {
  await cdp.keyboard.press("Escape");
  await cdp.settle(`document.querySelector("[role=menu]") === null`, (gone) => gone);
};

try {
  await cdp.send("Page.bringToFront");
  const start = await until("broken", (seen) => seen.badge);
  if (start?.badge !== true) throw new Error("the broken file never said it could not be drawn");

  section("A picture on the clipboard, for a file that could not be drawn");
  const rows = await menuOver("broken");
  check(
    "the menu offers both sources, and nothing to remove yet",
    rows.includes("Set thumbnail from clipboard") &&
      rows.includes("Set thumbnail from file…") &&
      !rows.includes("Remove custom thumbnail"),
    rows.join(" | "),
  );
  await closeMenu();
  await copy("image/png", createReadStream(pictures.red));
  await menuOver("broken");
  await pick("Set thumbnail from clipboard");
  const set = await note();
  check("the status bar says it was set", set === "Set a custom thumbnail", set);
  const notes = await until("broken", (seen) => seen.loaded && !seen.badge);
  check("the cell draws the picture", notes?.loaded === true, JSON.stringify(notes));
  check("and no longer says it could not be drawn", notes?.badge === false, JSON.stringify(notes));
  check("with the file's own extension on it", notes?.label === "png", String(notes?.label));

  const box = await cdp.box(cell("broken"));
  await cdp.mouse.click(box.x, box.y);
  const line = await cdp
    .settle(
      `document.querySelector(".inspector-chosen")?.textContent ?? null`,
      (text) => text !== null,
      { attempts: 30 },
    )
    .catch(() => null);
  check("the inspector says the picture was chosen", line === "Custom thumbnail", String(line));

  section("A file copied in a file manager");
  const before = await drawn("photo");
  await copy("text/uri-list", `${pathToFileURL(pictures.blue).href}\r\n`);
  await menuOver("photo");
  await pick("Set thumbnail from clipboard");
  // The same sentence as before, so the picture is what says it happened, and
  // the line is read after it.
  const photo = await until("photo", (seen) => seen.loaded && seen.src !== before.src);
  const second = await note();
  check("the status bar says it was set", second === "Set a custom thumbnail", second);
  check(
    "the cell's picture moved to a new address",
    photo?.src !== before.src && photo?.loaded === true,
    `${before.src} → ${photo?.src}`,
  );

  section("Nothing on the clipboard");
  // Words, which is what a clipboard holds most of the time.
  await copy("text/plain", "not a picture");
  await menuOver("photo");
  await pick("Set thumbnail from clipboard");
  const empty = await note(second);
  check(
    "the status bar says what to do",
    empty === "Nothing on the clipboard can be a thumbnail — copy an image",
    empty,
  );

  section("Removing it");
  const offered = await menuOver("broken");
  check(
    "the menu offers to remove it",
    offered.includes("Remove custom thumbnail"),
    offered.join(" | "),
  );
  await pick("Remove custom thumbnail");
  const removed = await note(empty);
  check("the status bar says so", removed === "Removed the custom thumbnail", removed);
  // Shown, not merely in the page under a picture that is still there: the
  // removed picture's address was cached for good, and covered the badge.
  const back = await until("broken", (seen) => seen.badge && !seen.loaded);
  check(
    "the removed picture goes, and the file says again it could not be drawn",
    back?.badge === true && back?.loaded === false,
    JSON.stringify(back),
  );
  const after = await menuOver("broken");
  check(
    "and there is nothing left to remove",
    !after.includes("Remove custom thumbnail"),
    after.join(" | "),
  );
  await closeMenu();

  report();
} catch (error) {
  console.error(error);
  console.error(window.noise().slice(-4000));
  process.exitCode = 2;
} finally {
  await window.close();
  await dispose();
}

/**
 * A photograph, and a file that only claims to be one, both through the queue
 * already. The broken one is a PNG signature with nothing behind it, as
 * `check-failures.mjs` makes them: a file of a kind Roost never draws (an
 * archive) carries no badge to lose. The two pictures offered as thumbnails are
 * outside the library, as anything on a clipboard is.
 */
async function library(where) {
  const incoming = join(where, "incoming");
  await mkdir(incoming, { recursive: true });
  await writeFile(join(incoming, "photo.png"), await gradient(160, 120, 3, "png"));
  await writeFile(
    join(incoming, "broken.png"),
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64),
    ]),
  );
  const red = join(where, "red.png");
  const blue = join(where, "blue.png");
  await writeFile(red, await gradient(200, 120, 11, "png"));
  await writeFile(blue, await gradient(120, 200, 23, "png"));

  const path = join(where, "Thumbnails.roost");
  const made = await Library.create(path, "Thumbnails");
  try {
    await importInto(made, [join(incoming, "photo.png"), join(incoming, "broken.png")]);
    await runDerives(made, { sizes: [GRID_SIZE] });
  } finally {
    await made.close();
  }
  return { root: path, pictures: { red, blue } };
}
