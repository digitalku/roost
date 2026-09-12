/**
 * Draws the application icon at the sizes a window, a desktop entry and a
 * Windows shortcut want.
 *
 *   node scripts/build-brand.mjs
 *
 * The SVGs in `assets/brand/` are the source of record, delivered by the user.
 * Everything here is derived from `roost-icon.svg` and committed beside it,
 * because an icon is needed before any build step runs — Electron reads it when
 * the window opens, and a launcher reads it from disk.
 *
 * **It rasterises with Roost's own vector backend** (ADR-0015: resvg in
 * WebAssembly, no filesystem access, no system fonts) rather than reaching for
 * another tool. One rasteriser in the project means an icon that looks like
 * what the application would draw for the same file.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { rasteriseSvgFile } from "@roost/media";

/** The sizes a Linux desktop entry and a Windows taskbar actually ask for. */
const SIZES = [512, 256, 128, 64, 32];

/**
 * What goes inside `roost.ico`, largest first.
 *
 * Windows picks a different member for the Start Menu, the taskbar, Alt+Tab and
 * a small list, and it scales the nearest one when the size it wants is absent
 * — which is how an icon ends up looking soft in exactly one place. 48 and 16
 * are not in `SIZES` because nothing else asks for them.
 */
const ICO_SIZES = [256, 128, 64, 48, 32, 16];

const source = fileURLToPath(new URL("../assets/brand/roost-icon.svg", import.meta.url));

/** Rasterised once per size, because the two outputs overlap in four of them. */
const rasters = new Map();

for (const size of SIZES) {
  const raster = await rasterise(size);
  const out = fileURLToPath(new URL(`../assets/brand/icon-${size}.png`, import.meta.url));
  await writeFile(out, raster.png);
  console.log(`icon-${size}.png  ${raster.width}×${raster.height}  ${raster.png.length} B`);
}

const members = [];
for (const size of ICO_SIZES) members.push({ size, png: (await rasterise(size)).png });
const icon = ico(members);
await writeFile(fileURLToPath(new URL("../assets/brand/roost.ico", import.meta.url)), icon);
console.log(`roost.ico       ${ICO_SIZES.join(", ")}  ${icon.length} B`);

async function rasterise(size) {
  const cached = rasters.get(size);
  if (cached !== undefined) return cached;
  const raster = await rasteriseSvgFile(source, size);
  rasters.set(size, raster);
  return raster;
}

/**
 * An `.ico`, which is a directory of images rather than an image.
 *
 * The members are PNGs: an icon file has been allowed to carry them since
 * Vista, and the alternative is writing a bottom-up BMP with a separate mask
 * plane for no gain. A shortcut cannot point at a `.png` (`SETUP.md` §4), which
 * is the whole reason this file exists.
 */
function ico(members) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // 1 = icon, 2 = cursor
  header.writeUInt16LE(members.length, 4);

  const directory = [];
  let offset = header.length + members.length * 16;
  for (const { size, png } of members) {
    const entry = Buffer.alloc(16);
    // A byte cannot hold 256, so the format spells it 0 — the one size that
    // reads as a bug and is the format working as written.
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel, which is what makes it truecolour
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    directory.push(entry);
  }

  return Buffer.concat([header, ...directory, ...members.map(({ png }) => Buffer.from(png))]);
}
