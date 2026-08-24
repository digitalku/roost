import sharp from "sharp";
import type { Format } from "./format.js";

/**
 * The one module in the workspace that imports `sharp`.
 *
 * Not an abstraction for its own sake: ADR-0013 leaves open whether `sharp`
 * survives Linux packaging, and keeping the import to one file is what makes
 * answering that cheap. Everything above this module speaks in {@link Format}
 * and {@link Thumbnail}, neither of which mentions a library.
 *
 * `sharp`'s asynchronous API runs on libuv's threadpool, so image work does not
 * occupy the engine's event loop. The default pool of four is a silent ceiling
 * on import throughput — measured at 623 thumbnails/sec with the pool at the
 * core count — so the engine raises `UV_THREADPOOL_SIZE` at start
 * (`ARCHITECTURE.md` §3.3).
 */

/** A generated thumbnail, ready for the `thumbs` table. */
export interface Thumbnail {
  /** The requested longest edge, and the `thumbs.size` key. */
  readonly size: number;
  /** Actual dimensions, which differ from `size` on the short edge. */
  readonly width: number;
  readonly height: number;
  /** WebP bytes, straight into the BLOB. */
  readonly data: Buffer;
}

/**
 * Formats this build can turn into pixels.
 *
 * Two of them are absent for reasons worth keeping visible, because both would
 * otherwise read as oversights:
 *
 * - **`bmp`** — libvips has no BMP loader, measured against 8.18.3. The Rust
 *   build's `image` crate did, so a `.bmp` that had a thumbnail there has none
 *   here. It still imports, still carries tags, and still opens elsewhere.
 * - **`svg`** — libvips renders SVG through librsvg, and **librsvg follows
 *   external references**. Measured: an `<image xlink:href="secret.png">`
 *   beside the SVG is loaded and drawn. That makes an imported SVG a way to
 *   read arbitrary local files through the thumbnailer, and the same code path
 *   reaches remote URLs, which invariant 7 forbids outright. SVG stays
 *   recognised, previewable by the renderer's own engine, and unrendered here
 *   until it can be rasterised somewhere that cannot reach the filesystem.
 */
const RENDERABLE: ReadonlySet<Format> = new Set<Format>([
  "jpeg",
  "png",
  "webp",
  "gif",
  "tiff",
  "avif",
]);

/** Whether this build can decode `format` into pixels. */
export function isRenderable(format: Format): boolean {
  return RENDERABLE.has(format);
}

/** WebP quality, as `STORAGE_SPEC.md` specifies. */
export const WEBP_QUALITY = 80;

/** Which decoder is loaded, for `roost doctor` and for bug reports. */
export function decoderVersions(): { sharp: string; libvips: string } {
  return { sharp: sharp.versions.sharp, libvips: sharp.versions.vips };
}

/**
 * Pixel dimensions from a file's header, without decoding it.
 *
 * `undefined` rather than an error when the header cannot be read: an asset
 * whose dimensions are unknown imports perfectly well and simply has no cell
 * shape to reserve until it has a thumbnail.
 */
export async function readDimensions(
  path: string,
): Promise<{ width: number; height: number } | undefined> {
  try {
    const { width, height } = await sharp(path, { failOn: "error" }).metadata();
    if (typeof width !== "number" || typeof height !== "number") return undefined;
    return { width, height };
  } catch {
    return undefined;
  }
}

/**
 * Renders `path` at every requested size.
 *
 * Each size is produced **from the original**, not by shrinking the previous
 * thumbnail. The Rust build chained, and could: it held decoded pixels and
 * resized those. Chaining here would mean re-encoding one lossy WebP into
 * another, compounding artefacts to save a decode — and libvips shrinks on load
 * (a JPEG is scaled during its DCT pass), so the decode being saved is most of
 * the cheap part. The common case is one size anyway: only 256 is generated
 * eagerly, and 512 only for an asset someone opened.
 *
 * **Never enlarges.** Upscaling would inflate the stored BLOB while adding no
 * detail, and would make a 64px icon claim to be a 512px thumbnail.
 */
export async function renderThumbnails(
  path: string,
  sizes: readonly number[],
): Promise<Thumbnail[]> {
  const thumbnails: Thumbnail[] = [];

  for (const size of [...new Set(sizes)].sort((a, b) => b - a)) {
    // `failOn: "error"` rather than the default `"warning"`: a JPEG whose last
    // scan is missing is ordinary in a real library, and refusing to thumbnail
    // it would be a worse answer than an image a few rows short.
    const { data, info } = await sharp(path, { failOn: "error" })
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });

    thumbnails.push({ size, width: info.width, height: info.height, data });
  }

  return thumbnails;
}

/** Encodes raw RGBA pixels as WebP. Used by the synthetic-image generator. */
export async function encodeWebp(pixels: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}

/** Encodes raw RGBA pixels in one of the formats a synthetic corpus needs. */
export async function encodeRaw(
  pixels: Buffer,
  width: number,
  height: number,
  format: "jpeg" | "png" | "gif" | "tiff" | "webp",
): Promise<Buffer> {
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .toFormat(format, format === "webp" ? { quality: WEBP_QUALITY } : {})
    .toBuffer();
}
