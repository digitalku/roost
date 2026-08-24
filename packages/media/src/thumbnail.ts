import { isRenderable, renderThumbnails, type Thumbnail } from "./decoder.js";
import { sniffFile } from "./probe.js";

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

export { isRenderable, type Thumbnail, WEBP_QUALITY } from "./decoder.js";

/**
 * Generates thumbnails for a file, or returns none.
 *
 * **An unrenderable format is not an error.** A PDF, a video, and a font all
 * import normally and simply have no thumbnail until the backend that draws
 * them arrives (M4). Returning an empty array rather than throwing is what lets
 * the importer stay a straight line — `ARCHITECTURE.md` §3.3 makes the same
 * promise about missing backends.
 *
 * The format is decided from the bytes, not from the caller's word for it, for
 * the same reason `probe` does: a file named `.jpg` that is really a PNG is
 * ordinary, and a thumbnailer that trusted the name would produce a wrong image
 * or none.
 */
export async function generateThumbnails(
  path: string,
  sizes: readonly number[] = EAGER_SIZES,
): Promise<Thumbnail[]> {
  const format = await sniffFile(path);
  if (!isRenderable(format)) return [];
  return renderThumbnails(path, sizes);
}
