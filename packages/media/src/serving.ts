/**
 * What the `roost://` protocol handler needs, and nothing that loads a decoder.
 *
 * The handler runs in Electron's **main** process (ADR-0008), which is the
 * process that draws the window. Importing `@roost/media` there would pull in
 * `decoder.ts`, and with it `sharp` — a native module that `dlopen`s libvips
 * and initialises it, on the one thread whose cold start is an M3 acceptance
 * criterion. Everything here is a constant or a table lookup, so this module
 * has a subpath of its own and a test that runs it in a fresh process and
 * asserts no sharp binary was loaded.
 */
export {
  type Format,
  formatFromExtension,
  isBrowserDrawable,
  isFormat,
  kindOf,
  mediaTypeOf,
} from "./format.js";
// Text in, text out — no decoder, so it belongs on this side of the line
// (ADR-0025).
export { isConvertible, SUBTITLE_EXTENSIONS, toWebVtt } from "./subtitle.js";

/**
 * The size the grid renders, generated for every asset up front.
 */
export const GRID_SIZE = 256;

/**
 * The size the detail panel renders, generated on first use.
 *
 * The Rust build measured it at 24.2 KB against the grid size's 9.4 KB — 72% of
 * the total — for an image only ever needed for the one asset someone is
 * looking at. Generating it eagerly would put roughly 34 GB in `index.db` at a
 * million assets, most of it previews nobody opens.
 */
export const PREVIEW_SIZE = 512;

/** Longest-edge sizes the schema's `thumbs.size` column expects. */
export const THUMBNAIL_SIZES = [GRID_SIZE, PREVIEW_SIZE] as const;

/** The sizes generated for every asset without being asked. */
export const EAGER_SIZES = [GRID_SIZE] as const;
