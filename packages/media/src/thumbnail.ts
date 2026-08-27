import { isRenderable, renderThumbnails, type Thumbnail } from "./decoder.js";
import { sniffFile } from "./probe.js";
import { EAGER_SIZES } from "./serving.js";

export { isRenderable, type Thumbnail, WEBP_QUALITY } from "./decoder.js";
// The sizes live in `serving.ts`, which the protocol handler imports without a
// decoder attached. They are re-exported here so that `@roost/media` still
// answers for them and no caller has to know where they moved.
export {
  EAGER_SIZES,
  GRID_SIZE,
  PREVIEW_SIZE,
  THUMBNAIL_SIZES,
} from "./serving.js";

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
