import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { isRenderable } from "./decoder.js";
import { type Format, isBrowserDrawable } from "./format.js";
import { decodeHeif } from "./heif.js";
import { looksLikeRaw, readRaw } from "./raw.js";
import { rasteriseSvgFile } from "./vector.js";

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

  if (format === "raw") return toJpeg(await rawPreview(path));
  if (format === "tiff") return toJpeg(path);

  throw new Error(`no rendition for ${format}`);
}

/**
 * How wide a vector is drawn for the clipboard.
 *
 * A drawing has no pixels of its own, so some width has to be chosen, and the
 * thumbnail's 512 is too small to paste into anything: a logo copied out of a
 * library is usually going into a document or a slide. The long edge of a
 * large screen is the size nobody has to scale up.
 */
const STILL_VECTOR_WIDTH = 2_048;

/**
 * zlib level for a picture on its way to the clipboard.
 *
 * Measured on a 24-megapixel photograph: level 1 took 555 ms and came to 18 MB,
 * level 6 took 2 047 ms for 12 MB, and level 0 took 122 ms for 72 MB. The first
 * is the one to want. Whatever pastes it has to read the whole thing through a
 * pipe, and a clipboard manager keeps a copy of each one it sees, so the
 * uncompressed 72 MB would cost more after the copy than it saves during it.
 */
const STILL_COMPRESSION = 1;

/**
 * One asset as a PNG, at full size, for putting on the clipboard as a picture.
 *
 * PNG because it is the image format every desktop's clipboard carries, and
 * the only one Chromium offers on Linux. Nothing is scaled down. A copy of a
 * photograph is expected to be the photograph, and the ceiling that stops a
 * scan from exhausting the process is libvips' own limit on input pixels.
 *
 * **A PNG goes through untouched** when its bytes are a PNG: they are already
 * what the clipboard wants, and decoding and encoding them again would lose
 * the colour profile and gain nothing. Everything else is decoded, turned the
 * right way up (a JPEG from a phone is stored on its side, with a tag saying
 * so, and a pasted picture does not carry the tag), and encoded.
 *
 * Throws where the format has no still picture this build can produce: a BMP
 * (libvips has no loader for it), a RAW with no embedded preview, or anything
 * that is not a picture at all.
 */
export async function renderStill(path: string, format: Format): Promise<Buffer> {
  if (format === "png") {
    const bytes = await readFile(path);
    if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return bytes;
    return toPng(bytes);
  }
  if (format === "svg") return (await rasteriseSvgFile(path, STILL_VECTOR_WIDTH)).png;
  if (format === "heic") return toPng(await decodeHeif(path));
  if (format === "raw") return toPng(await rawPreview(path));
  if (isRenderable(format)) return toPng(path);

  throw new Error(`no still picture for ${format}`);
}

/**
 * A thumbnail made small enough to ride under the pointer, as a PNG.
 *
 * What a drag out of the window shows (ADR-0034 §4). Thumbnails are WebP in
 * the index, and Electron's `nativeImage`, which is what a native drag takes,
 * decodes PNG and JPEG and nothing else, so it has to be converted first.
 */
export async function dragPicture(thumbnail: Buffer, edge: number): Promise<Buffer> {
  return sharp(thumbnail, { failOn: "error" })
    .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The camera's own embedded JPEG, which is the only picture a RAW contains —
 * the sensor data is not one. `deriveRawPhoto` draws thumbnails from the same
 * bytes, so the pane, the grid and the clipboard agree about what the file
 * looks like.
 */
async function rawPreview(path: string): Promise<Buffer> {
  const facts = await readRaw(path);
  if (facts === undefined || !looksLikeRaw(facts) || facts.preview === undefined) {
    throw new Error("no picture in this raw file");
  }
  return facts.preview.bytes;
}

async function toPng(source: string | Buffer): Promise<Buffer> {
  return sharp(source, { failOn: "error" })
    .rotate()
    .png({ compressionLevel: STILL_COMPRESSION })
    .toBuffer();
}

async function toJpeg(source: string | Buffer): Promise<Rendition> {
  const bytes = await sharp(source, { failOn: "error" })
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: QUALITY })
    .toBuffer();
  return { bytes, mediaType: "image/jpeg" };
}
