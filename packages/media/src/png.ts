import { deflateSync } from "node:zlib";

/**
 * A PNG encoder, in one function, using nothing but `node:zlib`.
 *
 * `sharp` encodes everything else here, so this exists for the one caller that
 * must not load it: main serves a rendered PDF page over `roost://` (ADR-0008),
 * pdfium hands back raw RGBA, and `dlopen`ing libvips in the process that draws
 * the window is what ADR-0013 and the cold-start budget are about. Handing over
 * an uncompressed bitmap instead would be three megabytes a page for something
 * that compresses to tens of kilobytes, since a document page is mostly one
 * colour.
 *
 * PNG's own format is small enough to write: a signature, three chunks, and one
 * filter byte per row. Deflate is in the standard library. This module imports
 * nothing but `node:zlib`, which is what keeps it reachable from main.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encodes RGBA pixels, eight bits per channel, as a PNG. */
export function encodePng(pixels: Buffer, width: number, height: number): Buffer {
  if (pixels.length < width * height * 4) throw new Error("not enough pixels for that size");

  // One filter byte per scanline. Filter 0 is "none", which leaves the row
  // as-is: the adaptive filters buy little on rendered text and cost a pass.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const from = y * width * 4;
    const to = y * (1 + width * 4);
    raw[to] = 0;
    pixels.copy(raw, to + 1, from, from + width * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // compression: deflate
  header[11] = 0; // filter method
  header[12] = 0; // interlace: none

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** The CRC table, built once. PNG's polynomial, in its reversed form. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
