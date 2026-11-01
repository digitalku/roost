/**
 * A photograph taken on its side, and an old picture of it, asserted against a
 * **running window** (ADR-0064).
 *
 *     node scripts/check-orientation.mjs
 *
 * The media tests prove the file is drawn the right way up, and the library
 * tests that a refresh draws it again. What only a window can say is that a
 * sideways picture is left alone until somebody asks, that **Refresh thumbnail**
 * replaces it in front of them without paging the grid, that the card takes the
 * new shape with it, and that a picture nobody asked to see again moves nothing.
 *
 * It builds its own library in a temporary directory and deletes it again.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { importInto, Library, runDerives } from "@roost/library";
import { GRID_SIZE, gradient } from "@roost/media";
import { ledger } from "./lib/checks.mjs";
import { scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

const sharp = createRequire(join(import.meta.dirname, "../packages/media/"))("sharp");

/**
 * Two photographs drawn as a build before this one drew them: landscape
 * pictures and landscape numbers, dated long enough ago that the new address
 * cannot be the old one.
 */
async function library(where) {
  const incoming = join(where, "incoming");
  await mkdir(incoming, { recursive: true });
  const tagged = await sharp(await gradient(400, 300, 3, "png"))
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  await writeFile(join(incoming, "asked.jpg"), tagged);

  const path = join(where, "Orientation.roost");
  const made = await Library.create(path, "Orientation");
  try {
    const report = await importInto(made, [join(incoming, "asked.jpg")]);
    await writeFile(
      join(incoming, "left.jpg"),
      await sharp(await gradient(400, 300, 4, "png"))
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer(),
    );
    const second = await importInto(made, [join(incoming, "left.jpg")]);
    await runDerives(made, { sizes: [GRID_SIZE] });

    // Queued and undrawn, with the numbers a build before this one read: the
    // window draws it upright as it opens, and its card must not move for that.
    await writeFile(
      join(incoming, "late.jpg"),
      await sharp(await gradient(400, 300, 5, "png"))
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer(),
    );
    const late = await importInto(made, [join(incoming, "late.jpg")]);
    for (const id of late.importedIds) {
      const known = made.db.repo.assetDetail(id);
      made.db.repo.putDerived(id, { size: known.size, width: 400, height: 300 }, 1);
    }
    await made.updateSettings({ matchImageProportions: true });

    const sideways = await gradient(256, 192, 9, "webp");
    const then = Math.floor(Date.now() / 1000) - 1000;
    for (const id of [...report.importedIds, ...second.importedIds]) {
      const source = made.db.repo.pictureSource(id);
      const metadata = { ...source.metadata, width: 400, height: 300 };
      made.db.repo.putThumbnail(id, GRID_SIZE, 256, 192, sideways);
      made.db.repo.putPictureSource(id, { ...source, metadata });
      made.db.repo.putDerived(id, metadata, then);
    }
  } finally {
    await made.close();
  }
  return path;
}

const { dir, dispose } = await scratch("check-orientation");
const window = await launch({ library: await library(dir) });
const { cdp } = window;
const { check, section, report } = ledger();

const cell = (name) => `.cell[aria-label="${name}"]`;

/** The picture one cell has loaded, in one round trip. */
const drawn = (name) =>
  cdp.evaluate(`(() => {
    const image = document.querySelector(${JSON.stringify(cell(name))} + " .cell-image");
    return {
      src: image?.getAttribute("src") ?? null,
      width: image?.naturalWidth ?? 0,
      height: image?.naturalHeight ?? 0,
    };
  })()`);

/** A cell's size on screen, which Masonry takes from the file's numbers. */
const shape = (name) =>
  cdp.evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(cell(name))}).getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height) };
  })()`);

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

/** What the inspector says of the selected file's dimensions. */
const dimensions = () =>
  cdp
    .settle(
      `document.querySelector(".inspector")?.textContent.match(/\\d+ × \\d+/)?.[0] ?? null`,
      (text) => text !== null,
      { attempts: 30 },
    )
    .catch(() => null);

try {
  await cdp.send("Page.bringToFront");

  section("An old picture is left as it was");
  const before = await until("asked", (seen) => seen.width > 0);
  const untouched = await until("left", (seen) => seen.width > 0);
  check("the sweep at open did not redraw it", before.width === 256 && before.height === 192);
  check("nor its neighbour", untouched.width === 256 && untouched.height === 192);

  section("A picture arriving");
  const late = await until("late", (seen) => seen.height > seen.width);
  check("a new picture is drawn upright", late.height > late.width, JSON.stringify(late));
  const lateShape = await shape("late");
  const leftShape = await shape("left");
  check(
    "its card keeps the shape it had, so nothing moves",
    lateShape.height === leftShape.height,
    `${JSON.stringify(lateShape)} against ${JSON.stringify(leftShape)}`,
  );

  section("Refresh thumbnail");
  const box = await cdp.box(cell("asked"));
  await cdp.mouse.click(box.x, box.y);
  check("the inspector has the old shape", (await dimensions()) === "400 × 300");
  // Read again, because the cell was no longer under the first position here.
  const held = await cdp.box(cell("asked"));
  await cdp.mouse.click(held.x, held.y, { button: "right" });
  const row = await cdp.settle(
    `(() => {
      const item = [...document.querySelectorAll('[role=menuitem]')].find((i) => i.textContent === "Refresh thumbnail");
      if (!item) return null;
      const r = item.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`,
    (found) => found !== null,
  );
  await cdp.mouse.click(row.x, row.y);
  const line = await cdp.settle(
    `document.querySelector(".status-note")?.textContent ?? ""`,
    (text) => text.length > 0,
    { attempts: 50 },
  );
  check("the status bar says so", line === "Drawing the thumbnail again", line);

  const after = await until("asked", (seen) => seen.src !== before.src && seen.height > seen.width);
  check(
    "the cell draws it upright",
    after.width === 192 && after.height === 256,
    JSON.stringify(after),
  );
  check("the neighbour is still as it was", (await drawn("left")).width === 256);
  const reshaped = await cdp
    .settle(
      `document.querySelector(${JSON.stringify(cell("asked"))}).getBoundingClientRect().height`,
      (height) => height > leftShape.height,
      { attempts: 30 },
    )
    .catch(() => 0);
  check(
    "and asked for, the card takes the new shape",
    reshaped > leftShape.height,
    `${reshaped}px`,
  );

  // The inspector reads a file's detail when the selection changes.
  const other = await cdp.box(cell("left"));
  await cdp.mouse.click(other.x, other.y);
  await cdp.mouse.click((await cdp.box(cell("asked"))).x, (await cdp.box(cell("asked"))).y);
  const measured = await cdp
    .settle(
      `document.querySelector(".inspector")?.textContent.match(/\\d+ × \\d+/)?.[0] ?? null`,
      (text) => text === "300 × 400",
      { attempts: 30 },
    )
    .catch(() => null);
  check("the inspector has the new shape", measured === "300 × 400", String(measured));
} catch (error) {
  console.error(error);
  process.exitCode = 2;
} finally {
  await window.close();
  await dispose();
  report();
}
