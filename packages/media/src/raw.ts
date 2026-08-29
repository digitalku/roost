import { readFile } from "node:fs/promises";

/**
 * RAW photographs, through the JPEG the camera already made.
 *
 * Decoding a sensor's mosaic is a colour-science project — demosaicing, white
 * balance, a per-camera profile — and it produces a *different* picture from
 * the one the photographer saw on the back of the camera. Every RAW format
 * carries that picture already, as an ordinary JPEG embedded in the file, and
 * that is what a browser shows, what the camera shows, and what belongs in a
 * grid cell.
 *
 * So this module is a TIFF reader, not a decoder: RAW formats are TIFF
 * containers with vendor tags (CR2, NEF, ARW, DNG, ORF, PEF, SRW), and the
 * preview is found by walking their image file directories and taking the
 * largest JPEG in there.
 */

/** Tags this reader looks for. Everything else in a RAW is somebody else's. */
const TAG = {
  imageWidth: 0x0100,
  imageLength: 0x0101,
  compression: 0x0103,
  stripOffsets: 0x0111,
  stripByteCounts: 0x0117,
  subIfds: 0x014a,
  jpegOffset: 0x0201,
  jpegLength: 0x0202,
  exifIfd: 0x8769,
  dngVersion: 0xc612,
} as const;

/** `Compression` values that mean "these bytes are a JPEG". */
const JPEG_COMPRESSION = new Set([6, 7, 34_892]);

/** Bytes of a TIFF header, which is all it takes to recognise one. */
const HEADER_BYTES = 8;

/** How deep the IFD walk goes. A RAW nests SubIFDs; nothing nests them deeply. */
const MAX_DEPTH = 4;

/** How many directories are read before the file is called malformed. */
const MAX_DIRECTORIES = 64;

/** A JPEG found inside a RAW, and how big it is. */
export interface EmbeddedPreview {
  readonly bytes: Buffer;
  readonly width?: number;
  readonly height?: number;
}

/** What a RAW says about the photograph itself, rather than about its preview. */
export interface RawFacts {
  readonly width?: number;
  readonly height?: number;
  readonly preview?: EmbeddedPreview;
}

/**
 * Whether these leading bytes are a TIFF container.
 *
 * The byte order mark and the answer to life, in the two orders TIFF allows.
 * Every TIFF-based RAW starts this way, which is why sniffing alone cannot tell
 * a NEF from a scanned TIFF — {@link readRaw} is what distinguishes them, by
 * looking for what only a RAW carries.
 */
export function isTiffContainer(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_BYTES) return false;
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!little && !big) return false;
  const magic = little
    ? (bytes[2] ?? 0) | ((bytes[3] ?? 0) << 8)
    : ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  return magic === 42;
}

/**
 * Reads a TIFF-based RAW: the photograph's dimensions, and its largest embedded
 * preview.
 *
 * Returns `undefined` for a file that is not a TIFF container at all. A plain
 * TIFF *is* one, and comes back with no preview and its own dimensions — which
 * is the honest answer, and the caller decides whether that makes it a RAW.
 */
export async function readRaw(path: string): Promise<RawFacts | undefined> {
  return parseRaw(await readFile(path));
}

/** The same, from bytes already in hand. Exported for its own test. */
export function parseRaw(bytes: Buffer): RawFacts | undefined {
  if (!isTiffContainer(bytes)) return undefined;

  const little = bytes[0] === 0x49;
  const reader = new TiffReader(bytes, little);
  const first = reader.uint32(4);

  const candidates: { offset: number; length: number; width?: number; height?: number }[] = [];
  let full: { width?: number; height?: number } = {};

  reader.walk(first, MAX_DEPTH, (directory) => {
    const compression = directory.get(TAG.compression);
    const width = directory.get(TAG.imageWidth);
    const height = directory.get(TAG.imageLength);

    // The largest *uncompressed* image in the file is the photograph itself:
    // the sensor data. Its dimensions are what the asset is, even though its
    // pixels are not something this module will ever draw.
    if (
      width !== undefined &&
      height !== undefined &&
      (compression === undefined || !JPEG_COMPRESSION.has(compression)) &&
      width * height > (full.width ?? 0) * (full.height ?? 0)
    ) {
      full = { width, height };
    }

    // Two ways a JPEG is pointed at, and RAW files in the wild use both: the
    // dedicated JPEGInterchangeFormat pair, and a single strip whose
    // compression says JPEG.
    const jpegOffset = directory.get(TAG.jpegOffset);
    const jpegLength = directory.get(TAG.jpegLength);
    if (jpegOffset !== undefined && jpegLength !== undefined && jpegLength > 0) {
      candidates.push({ offset: jpegOffset, length: jpegLength });
    }

    const stripOffset = directory.get(TAG.stripOffsets);
    const stripLength = directory.get(TAG.stripByteCounts);
    if (
      compression !== undefined &&
      JPEG_COMPRESSION.has(compression) &&
      stripOffset !== undefined &&
      stripLength !== undefined &&
      stripLength > 0
    ) {
      const found: { offset: number; length: number; width?: number; height?: number } = {
        offset: stripOffset,
        length: stripLength,
      };
      if (width !== undefined) Object.assign(found, { width });
      if (height !== undefined) Object.assign(found, { height });
      candidates.push(found);
    }
  });

  // The largest embedded JPEG, which is the full-size preview rather than the
  // 160×120 thumbnail every camera also writes.
  const best = candidates
    .filter((candidate) => candidate.offset + candidate.length <= bytes.length)
    .sort((a, b) => b.length - a.length)[0];

  const facts: RawFacts = {
    ...(full.width === undefined ? {} : { width: full.width }),
    ...(full.height === undefined ? {} : { height: full.height }),
  };

  if (best === undefined) return facts;

  const preview = bytes.subarray(best.offset, best.offset + best.length);
  // A pointer into a RAW is a number a camera wrote, and a truncated file is
  // ordinary. Checking the bytes costs nothing and is the difference between a
  // thumbnail and a decoder error.
  if (!isSelfContainedJpeg(preview)) return facts;

  return {
    ...facts,
    preview: {
      bytes: Buffer.from(preview),
      ...(best.width === undefined ? {} : { width: best.width }),
      ...(best.height === undefined ? {} : { height: best.height }),
    },
  };
}

/**
 * Whether these bytes are a JPEG that can be decoded on their own.
 *
 * The signature is not enough, and finding that out cost a test: TIFF has an
 * **abbreviated JPEG** form where the strips start with `FFD8` and the
 * quantisation tables live in a separate `JPEGTables` tag, so the bytes look
 * like a JPEG, extract like a JPEG, and fail to decode with "Quantization table
 * 0x00 was not defined". That is what an ordinary JPEG-compressed TIFF scan
 * looks like from here, and it is exactly the file that must *not* be mistaken
 * for a camera preview.
 *
 * A camera's preview is a complete JPEG: it carries its own tables, because it
 * is meant to be handed to anything that can show a picture.
 */
function isSelfContainedJpeg(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;

  // Walk the marker segments to the first scan, looking for a quantisation
  // table on the way. Bounded by the header rather than by the image data: the
  // tables are always before the scan, and the scan is the rest of the file.
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return false;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xdb) return true; // DQT
    if (marker === 0xda || marker === 0xd9) return false; // SOS or EOI: too late
    at += 2 + ((bytes[at + 2] ?? 0) << 8) + (bytes[at + 3] ?? 0);
  }
  return false;
}

/** Whether a parsed TIFF looks like a RAW rather than a photograph of paper. */
export function looksLikeRaw(facts: RawFacts): boolean {
  // A scanned TIFF has no embedded, self-contained JPEG preview; a RAW's whole
  // point is that it does. This is a heuristic and is meant to be: the cost of
  // being wrong is a thumbnail made from the wrong image inside the same file,
  // not a lost asset.
  return facts.preview !== undefined;
}

/** Reads the numbers out of a TIFF's directories, in whichever byte order. */
class TiffReader {
  readonly #bytes: Buffer;
  readonly #little: boolean;
  #directories = 0;

  constructor(bytes: Buffer, little: boolean) {
    this.#bytes = bytes;
    this.#little = little;
  }

  uint16(at: number): number {
    if (at + 2 > this.#bytes.length) return 0;
    return this.#little ? this.#bytes.readUInt16LE(at) : this.#bytes.readUInt16BE(at);
  }

  uint32(at: number): number {
    if (at + 4 > this.#bytes.length) return 0;
    return this.#little ? this.#bytes.readUInt32LE(at) : this.#bytes.readUInt32BE(at);
  }

  /**
   * Visits every image file directory, following SubIFDs and the Exif pointer.
   *
   * Bounded in both directions — depth and count — because the offsets come
   * from the file and a loop in them is a hang. Neither bound is reached by a
   * real photograph.
   */
  walk(offset: number, depth: number, visit: (directory: Map<number, number>) => void): void {
    let at = offset;
    const seen = new Set<number>();

    while (at > 0 && at + 2 <= this.#bytes.length && depth > 0) {
      if (seen.has(at) || this.#directories >= MAX_DIRECTORIES) return;
      seen.add(at);
      this.#directories += 1;

      const entries = this.uint16(at);
      const directory = new Map<number, number>();
      const children: number[] = [];

      for (let index = 0; index < entries; index += 1) {
        const entry = at + 2 + index * 12;
        if (entry + 12 > this.#bytes.length) break;

        const tag = this.uint16(entry);
        const type = this.uint16(entry + 2);
        const count = this.uint32(entry + 4);
        const value = entry + 8;

        if (tag === TAG.subIfds || tag === TAG.exifIfd) {
          // A pointer, or several: four bytes hold one, and more live at the
          // offset those four bytes name.
          if (count <= 1) children.push(this.uint32(value));
          else {
            const list = this.uint32(value);
            for (let index = 0; index < Math.min(count, 16); index += 1) {
              children.push(this.uint32(list + index * 4));
            }
          }
          continue;
        }

        // Only the scalar numeric types matter here, and only the first value:
        // every tag this module reads is a single number.
        if (count !== 1) continue;
        if (type === 3) directory.set(tag, this.uint16(value));
        else if (type === 4 || type === 9) directory.set(tag, this.uint32(value));
        else if (type === 1) directory.set(tag, this.#bytes[value] ?? 0);
      }

      visit(directory);
      for (const child of children) {
        if (child > 0) this.walk(child, depth - 1, visit);
      }

      at = this.uint32(at + 2 + entries * 12);
    }
  }
}

/** Whether a parsed directory carried the tag that only a DNG has. */
export function hasDngVersion(bytes: Buffer): boolean {
  if (!isTiffContainer(bytes)) return false;
  const reader = new TiffReader(bytes, bytes[0] === 0x49);
  let found = false;
  reader.walk(reader.uint32(4), 1, (directory) => {
    if (directory.has(TAG.dngVersion)) found = true;
  });
  return found;
}
