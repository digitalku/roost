/**
 * Draws the application icon at the sizes a window and a desktop entry want.
 *
 *   node scripts/build-brand.mjs
 *
 * The SVGs in `assets/brand/` are the source of record, delivered by the user.
 * Everything here is derived from `roost-icon.svg` and committed beside it,
 * because an icon is needed before any build step runs — Electron reads it when
 * the window opens, and a packaged desktop entry reads it from disk.
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

const source = fileURLToPath(new URL("../assets/brand/roost-icon.svg", import.meta.url));

for (const size of SIZES) {
  const raster = await rasteriseSvgFile(source, size);
  const out = fileURLToPath(new URL(`../assets/brand/icon-${size}.png`, import.meta.url));
  await writeFile(out, raster.png);
  console.log(`icon-${size}.png  ${raster.width}×${raster.height}  ${raster.png.length} B`);
}
