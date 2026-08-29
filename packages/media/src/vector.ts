import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { packageVersion } from "./manifest.js";

/**
 * Rasterising vectors, in WebAssembly (ADR-0015).
 *
 * The security property is the reason this is not the native binding: a WASM
 * module has no filesystem and no sockets unless the host wires them in, and
 * nothing here wires them in. Measured against the alternatives — the native
 * resvg binding read a neighbouring file with default options, and librsvg
 * reads one whenever it is handed a path — so an SVG that points at
 * `../../.ssh/id_rsa.png` draws nothing here rather than drawing the file.
 *
 * The instance is initialised once per process, lazily: initialisation costs
 * 46–52 ms and a CLI command that never touches a vector must not pay it.
 */

const require = createRequire(import.meta.url);

/** How wide a rasterised vector is before it is downscaled to thumbnails. */
export const VECTOR_RENDER_WIDTH = 512;

let ready: Promise<void> | undefined;

/**
 * Initialises the rasteriser, once.
 *
 * The promise is cached rather than a boolean flag, so two callers racing on
 * the first vector both wait for the same initialisation instead of starting
 * two.
 */
async function initialise(): Promise<void> {
  ready ??= (async () => {
    const wasm = await readFile(require.resolve("@resvg/resvg-wasm/index_bg.wasm"));
    await initWasm(wasm);
  })();
  return ready;
}

/** What a rasterised vector came out as. */
export interface Raster {
  readonly png: Buffer;
  /** The rendered bitmap's size. */
  readonly width: number;
  readonly height: number;
  /**
   * The drawing's own size, in its own units.
   *
   * What an inspector should show: a 120×60 logo is 120×60 however wide it was
   * rasterised. resvg resolves it from `width`/`height` or from the `viewBox`,
   * so even an SVG sized in percentages reports the shape it was drawn in.
   */
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
}

/**
 * Draws SVG markup to PNG bytes.
 *
 * Takes markup rather than a path on purpose. There is nothing for a base
 * directory to resolve against, which is the same protection stated twice:
 * once by the sandbox and once by the interface.
 *
 * **Text in a user's SVG renders without its font.** No system fonts are
 * loaded, because loading them would mean reading files on an asset's behalf —
 * the thing this module exists to prevent. Specimens are unaffected: they are
 * outlines by the time they get here (see `font.ts`).
 */
export async function rasteriseSvg(svg: string, width = VECTOR_RENDER_WIDTH): Promise<Raster> {
  await initialise();

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: false },
  });
  const rendered = resvg.render();
  return {
    png: Buffer.from(rendered.asPng()),
    width: rendered.width,
    height: rendered.height,
    intrinsicWidth: Math.round(resvg.width),
    intrinsicHeight: Math.round(resvg.height),
  };
}

/** Reads an SVG file and draws it. The bytes are text; nothing else is read. */
export async function rasteriseSvgFile(path: string, width = VECTOR_RENDER_WIDTH): Promise<Raster> {
  return rasteriseSvg(await readFile(path, "utf8"), width);
}

/** The rasteriser's version, for `roost doctor`. */
export function vectorVersion(): string {
  return packageVersion("@resvg/resvg-wasm/index_bg.wasm", require.resolve);
}
