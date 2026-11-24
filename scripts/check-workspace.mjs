/**
 * A file edited by another application, asserted against a **running window**
 * (ADR-0047).
 *
 *     node scripts/check-workspace.mjs
 *
 * **It builds its own library** in a temporary directory and deletes it again,
 * then writes over a file inside `files/` the way an external editor does —
 * behind the engine's back, through no code of Roost's. That is the whole
 * point: everything else in the test suite reaches the store through the
 * library's own API, which is the one path that was never broken.
 *
 * Three things are only true in a window and are checked nowhere else.
 *
 * The **thumbnail's address has to move**, because the response is served
 * `immutable` for a year and an `<img>` whose `src` did not change is one
 * Chromium never asks about again. A watcher that re-derived perfectly would
 * still leave last week's picture on screen, and only a real Chromium proves
 * otherwise.
 *
 * The **watcher is the engine's**, running in a `utilityProcess` (ADR-0006), so
 * a save has to travel filesystem → engine → derive → event → renderer before
 * anything is visible. Every other test of this runs the pieces in one process.
 *
 * And **RL-21**: a file the window has drawn, thumbnailed and opened in its
 * preview must still be writable by another application. That is a fact about
 * libvips' operation cache and about Windows, and it fails silently — the
 * failure it produces is Word saying *"the file is in use"* and naming nobody.
 */
import { readdir, rename, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { importInto, Library, resolveFile, runDerives } from "@roost/library";
import { GRID_SIZE, gradient } from "@roost/media";
import { ledger } from "./lib/checks.mjs";
import { scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

const { dir, dispose } = await scratch("check-workspace");
const { root, first, firstPath } = await buildLibrary(dir);

const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

/** Every cell's id and thumbnail address, in one round trip. */
const cellsExpression = `
  [...document.querySelectorAll(".cell")].map((cell) => ({
    id: cell.dataset.id ?? null,
    src: cell.querySelector(".cell-image")?.getAttribute("src") ?? null,
  }))`;

const srcOf = (cells, id) => cells.find((cell) => cell.id === id)?.src ?? null;

/**
 * Writes over a file the way another application's Save does.
 *
 * A second first. A file noticed as changed has its derive time cleared
 * (`refresh.ts`), so the derive that follows writes the clock, in whole
 * seconds, with nothing to stay ahead of: two saves in one second come back
 * under one thumbnail address, which Chromium does not ask about again. That
 * is a bug (`TODO.md` §3), and it flaked this check whenever the window opened
 * quickly; the pause keeps the check about what it checks.
 */
async function saveOverIt(path, bytes) {
  await new Promise((done) => setTimeout(done, 1100));
  await writeFile(path, bytes);
  // A save in the same second as the import would leave `mtime` unchanged, and
  // the comparison is deliberately `size` and `mtime` rather than a hash.
  const later = new Date(Date.now() + 5000);
  await utimes(path, later, later);
}

try {
  section("the grid draws what the library holds");

  const cells = await cdp.settle(cellsExpression, (found) => found.length >= 3);
  check(
    "every cell has a thumbnail",
    cells.every((cell) => cell.src !== null),
  );
  check(
    "the address carries a derive time, so it can move",
    /[?&]v=\d+/.test(srcOf(cells, first) ?? ""),
  );

  section("another application saves the file");

  const before = srcOf(cells, first);
  await saveOverIt(firstPath, await gradient(64, 64, 99, "png"));

  // The engine's watcher debounces for 400ms, then re-derives at interactive
  // priority, then tells the window. A generous window on a busy machine.
  const after = await cdp.settle(
    cellsExpression,
    (found) => srcOf(found, first) !== null && srcOf(found, first) !== before,
    { attempts: 60, everyMs: 250 },
  );

  check("the thumbnail's address changed, so Chromium asks again", srcOf(after, first) !== before);
  check("it is still the same asset", srcOf(after, first)?.includes(first) === true);
  check("nothing else moved", after.length === cells.length);

  section("the preview open on it, and another save");

  // Reported 2026-11-24: the thumbnail moved and the preview did not, until
  // Roost was restarted. `roost://file/<id>` is served `immutable`, and the pane
  // re-read its detail only on `library:changed`, which a save elsewhere never
  // sends. A new shape is what proves the bytes, not merely the address, were
  // read again.
  await cdp.evaluate(`
    (() => {
      const cell = document.querySelector('.cell[data-id="${first}"]');
      cell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      cell.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
      cell.click();
      document.querySelector(".grid").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    })()`);
  const pictureExpression = `(() => {
    const image = document.querySelector(".preview-photo-image");
    return {
      src: image?.getAttribute("src") ?? null,
      width: image?.complete ? image.naturalWidth : 0,
      height: image?.complete ? image.naturalHeight : 0,
      inspector: document.querySelector(".inspector-preview img")?.getAttribute("src") ?? null,
    };
  })()`;
  const opened = await cdp.settle(pictureExpression, (found) => found.width > 0);
  check("the preview draws the file at the size it was saved", opened.width === 64);

  await saveOverIt(firstPath, await gradient(96, 48, 42, "png"));
  const resaved = await cdp.settle(
    pictureExpression,
    (found) => found.width === 96 && found.inspector !== opened.inspector,
    { attempts: 60, everyMs: 250 },
  );
  check("the preview's address moved", resaved.src !== opened.src);
  check(
    "and it draws the new bytes, not the cached ones",
    resaved.width === 96 && resaved.height === 48,
  );
  check("the inspector's picture moved with it", resaved.inspector !== opened.inspector);

  await cdp.evaluate(`
    document.querySelector(".preview").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    )`);
  await cdp.settle("document.querySelector('.preview') === null", (gone) => gone === true);

  section("the file is still the application's to write (RL-21)");

  // The window has now drawn this asset, thumbnailed it twice and had libvips
  // open it. A second save must still work — this is the assertion that fails
  // when `sharp`'s operation cache holds the file mapped.
  let writable = true;
  try {
    await saveOverIt(firstPath, await gradient(64, 64, 7, "png"));
  } catch (error) {
    writable = false;
    check(`a second save failed: ${error.code ?? error.message}`, false);
  }
  check("a file the window has drawn can be written over again", writable);

  let renamable = true;
  const moved = `${firstPath.replace(/\.png$/, "")}.renamed-png`;
  try {
    await rename(firstPath, moved);
    await rename(moved, firstPath);
  } catch (error) {
    renamable = false;
    check(`a rename failed: ${error.code ?? error.message}`, false);
  }
  check("and renamed, which is how most applications save", renamable);

  section("the store is left the way the format wants it");

  const shard = join(root, "files", first.slice(0, 2));
  const names = await readdir(shard);
  check(
    "the file is still named by its id",
    names.some((name) => name.startsWith(first)),
  );
  check(
    "and has no trailing dot (RL-9a)",
    names.every((name) => !name.endsWith(".")),
  );
  check("the shard is one level deep", (await stat(shard)).isDirectory());
} finally {
  await window.close();
  await dispose();
}

report();

/**
 * Three real images, imported and derived before the window opens.
 *
 * Derived here rather than left to the window for the same reason
 * `check-failures.mjs` does it: the check is about what happens when a file
 * changes *after* everything has settled, and racing the first derive would
 * make it flake rather than fail.
 */
async function buildLibrary(where) {
  const source = join(where, "pictures");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(source, { recursive: true });
  for (let index = 0; index < 3; index += 1) {
    await writeFile(join(source, `shot-${index}.png`), await gradient(64, 64, index + 1, "png"));
  }

  const root = join(where, "Workspace.roost");
  const library = await Library.create(root, "Workspace");
  try {
    await importInto(library, [source]);
    await runDerives(library, { sizes: [GRID_SIZE] });

    const ids = library.db.repo.allIds();
    const first = ids[0];
    if (first === undefined) throw new Error("nothing imported");
    const found = await resolveFile(library, first);
    if (found.kind !== "found") throw new Error("the import placed no file");
    return { root, first, firstPath: found.path };
  } finally {
    await library.close();
  }
}
