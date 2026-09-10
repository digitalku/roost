import sharp from "sharp";
import { type Format, isBrowserDrawable } from "./format.js";
import { decodeHeif } from "./heif.js";
import { looksLikeRaw, readRaw } from "./raw.js";

/**
 * A picture a browser can actually draw, for the formats where the original is
 * not one (ADR-0040 §7).
 *
 * The preview pane loads an asset's own bytes into an `<img>`, which is right
 * for a JPEG and wrong for three formats Roost imports happily and Chromium
 * decodes not at all: **HEIC** (HEVC, and no browser ships a decoder for it),
 * **RAW** (a sensor mosaic, which is not an image in the sense an `<img>`
 * means), and **TIFF** (which browsers dropped decades ago). All three used to
 * open as an empty pane — the thumbnail in the grid, and then nothing.
 *
 * This is a **rendition**, not the original, and it is served under its own
 * route for the reason the subtitle conversion is (`route.ts`): an address that
 * promises the file's bytes has to hand back the file's bytes.
 */

/** A rendered picture, and what it is. */
export interface Rendition {
  readonly bytes: Buffer;
  readonly mediaType: string;
}

/**
 * How wide a rendition may be.
 *
 * Full resolution, up to a ceiling: a 12-megapixel photograph is the point —
 * the pane zooms, and a preview that could not be zoomed into would be the
 * thumbnail again — while a 100-megapixel scan re-encoded whole would put
 * hundreds of megabytes through a process that draws the window. Above this the
 * picture is scaled down, which is invisible at any zoom a screen can show.
 */
const MAX_EDGE = 6_000;

/** JPEG quality for a rendition. High: this is what a person zooms into. */
const QUALITY = 92;

/**
 * Renders one asset into something an `<img>` can show.
 *
 * Throws where the format has no rendition — which is every format
 * {@link isBrowserDrawable} already accepts, and any that arrives here by
 * mistake. The caller answers that with a 415 rather than a broken picture.
 */
export async function renderForBrowser(path: string, format: Format): Promise<Rendition> {
  if (isBrowserDrawable(format)) throw new Error(`${format} needs no rendition`);
  if (format === "heic") return toJpeg(await decodeHeif(path));

  if (format === "raw") {
    const facts = await readRaw(path);
    // The camera's own embedded JPEG, which is the only picture a RAW contains
    // — the sensor data is not one. `deriveRawPhoto` draws thumbnails from the
    // same bytes, so the pane and the grid agree about what the file looks like.
    if (facts === undefined || !looksLikeRaw(facts) || facts.preview === undefined) {
      throw new Error(`no rendition for ${format}`);
    }
    return toJpeg(facts.preview.bytes);
  }

  if (format === "tiff") return toJpeg(path);

  throw new Error(`no rendition for ${format}`);
}

async function toJpeg(source: string | Buffer): Promise<Rendition> {
  const bytes = await sharp(source, { failOn: "error" })
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: QUALITY })
    .toBuffer();
  return { bytes, mediaType: "image/jpeg" };
}
