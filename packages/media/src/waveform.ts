/**
 * Drawing a waveform, in pixels, with no library.
 *
 * An audio file has nothing to photograph, so its thumbnail is a picture of its
 * own amplitude. Drawn directly into an RGBA buffer rather than composed as an
 * SVG and rasterised: it is a filled rectangle per column, the geometry is two
 * integers, and routing it through a vector rasteriser would cost a parse to
 * produce the same pixels.
 */

/** Raw pixels, ready for the encoder. */
export interface Pixels {
  readonly pixels: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * A mid grey at full alpha, on a transparent ground.
 *
 * Deliberately not a theme colour. A thumbnail is stored bytes, so it cannot
 * follow the theme the way the interface does; a mid tone reads against both
 * the light and the dark cell background, and the transparency lets the cell
 * supply the ground. Painting a white sheet here would bake light mode into the
 * library.
 */
const INK = { r: 0x8a, g: 0x8a, b: 0x8a } as const;

/** The thinnest a bar may be drawn, so silence is a line rather than nothing. */
const MIN_BAR_PIXELS = 1;

/**
 * Draws peaks as a symmetric waveform.
 *
 * `peaks` runs from 0 to 1 and is one value per column; the image is that many
 * pixels wide, so nothing is interpolated and no peak is invented. A column is
 * mirrored around the centre line, which is what makes it read as audio rather
 * than as a bar chart.
 */
export function drawWaveform(peaks: Float32Array, height: number): Pixels {
  const width = peaks.length;
  const pixels = Buffer.alloc(width * height * 4);
  const centre = (height - 1) / 2;

  for (let x = 0; x < width; x += 1) {
    const peak = Math.max(0, Math.min(1, peaks[x] ?? 0));
    const half = Math.max(MIN_BAR_PIXELS / 2, (peak * (height - 1)) / 2);
    const top = Math.max(0, Math.round(centre - half));
    const bottom = Math.min(height - 1, Math.round(centre + half));

    for (let y = top; y <= bottom; y += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = INK.r;
      pixels[offset + 1] = INK.g;
      pixels[offset + 2] = INK.b;
      pixels[offset + 3] = 0xff;
    }
  }

  return { pixels, width, height };
}
