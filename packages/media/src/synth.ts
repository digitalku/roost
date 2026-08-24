import { encodeRaw } from "./decoder.js";
import { type Format, formatFromExtension } from "./format.js";

/**
 * Synthetic images for fixtures and benchmarks.
 *
 * Gradients rather than flat colour: flat colour compresses to almost nothing,
 * which would make both the encoder and the thumbnail sizes look implausibly
 * good and turn every benchmark into a measurement of run-length encoding.
 */

/** The formats {@link gradient} can write. */
export const SYNTHETIC_FORMATS = ["jpeg", "png", "gif", "tiff", "webp"] as const;

export type SyntheticFormat = (typeof SYNTHETIC_FORMATS)[number];

export function isSyntheticFormat(format: Format): format is SyntheticFormat {
  return (SYNTHETIC_FORMATS as readonly Format[]).includes(format);
}

/**
 * Which encoder a Roost extension gets, if this build has one.
 *
 * A fixture whose `.webp` files were random bytes made a ninth of every
 * synthetic library permanently unthumbnailable in the Rust build, which read
 * as a pipeline failure in the grid and was only ever the fixture.
 */
export function syntheticFormatForExtension(ext: string): SyntheticFormat | undefined {
  const format = formatFromExtension(ext);
  return isSyntheticFormat(format) ? format : undefined;
}

/**
 * Raw RGBA pixels of a deterministic gradient.
 *
 * `seed` shifts the gradient so that two images of the same size still differ.
 * **The three offsets are taken modulo distinct primes, not `seed % 256`.**
 * That earlier form yielded only 256 distinct images, and a 3,000-image fixture
 * deduplicated down to 1,824 assets because most of it was accidentally
 * identical — which is exactly the bug a content-addressed store is supposed to
 * find, arriving as a benchmark that measured the wrong thing.
 */
export function gradientPixels(width: number, height: number, seed: number): Buffer {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const ox = seed % 1021;
  const oy = Math.floor(seed / 1021) % 1019;
  const oz = Math.floor(seed / (1021 * 1019)) % 1013;

  const pixels = Buffer.allocUnsafe(w * h * 4);
  let at = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      pixels[at] = Math.floor(((x + ox) * 255) / w) & 0xff;
      pixels[at + 1] = Math.floor(((y + oy) * 255) / h) & 0xff;
      pixels[at + 2] = (x * 3 + y * 5 + oz) % 256;
      pixels[at + 3] = 255;
      at += 4;
    }
  }
  return pixels;
}

/** A deterministic gradient, encoded. */
export async function gradient(
  width: number,
  height: number,
  seed: number,
  format: SyntheticFormat,
): Promise<Buffer> {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return encodeRaw(gradientPixels(w, h, seed), w, h, format);
}
