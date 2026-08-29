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
 * **Images only.** Since M4 the other formats have backends of their own and
 * are reached through `derive`, which picks between them; this is the narrow
 * path for a caller that has an image and wants its thumbnails. An
 * unrenderable format is still not an error — it returns no thumbnails rather
 * than throwing, which is what lets a caller stay a straight line.
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
  return renderThumbnails({ path }, sizes);
}
