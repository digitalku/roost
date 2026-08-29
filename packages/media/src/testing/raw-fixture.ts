/**
 * A TIFF-based RAW small enough to write by hand, for tests.
 *
 * Nobody can commit a camera RAW: they are twenty megabytes each and they carry
 * a photograph somebody took. What matters for testing is the *shape* — a TIFF
 * container whose first directory describes the sensor image and whose SubIFD
 * points at an embedded JPEG — and that is exactly what CR2, NEF, ARW, and DNG
 * all are.
 *
 * The two ways a real file points at its preview are both buildable here,
 * because RAW files in the wild use both.
 */

/** Where the preview JPEG's offset and length are recorded. */
export const PREVIEW_POINTERS = ["jpeg-interchange", "strip"] as const;

export type PreviewPointer = (typeof PREVIEW_POINTERS)[number];

export interface RawFixtureOptions {
  /** The photograph's own dimensions, as the sensor directory records them. */
  readonly width?: number;
  readonly height?: number;
  /** JPEG bytes to embed as the camera's preview. */
  readonly preview?: Buffer;
  readonly previewWidth?: number;
  readonly previewHeight?: number;
  readonly pointer?: PreviewPointer;
  /** Writes the header in big-endian order, as a Nikon NEF does. */
  readonly bigEndian?: boolean;
}

const TAG = {
  imageWidth: 0x0100,
  imageLength: 0x0101,
  compression: 0x0103,
  stripOffsets: 0x0111,
  stripByteCounts: 0x0117,
  subIfds: 0x014a,
  jpegOffset: 0x0201,
  jpegLength: 0x0202,
} as const;

const TYPE_SHORT = 3;
const TYPE_LONG = 4;

interface Entry {
  tag: number;
  type: number;
  value: number;
}

/**
 * Builds a TIFF container shaped like a RAW.
 *
 * Layout: header, IFD0 (the sensor image), SubIFD (the preview), then the JPEG
 * bytes. Offsets are computed from the sizes above them, because a RAW reader's
 * job is to follow offsets and a fixture with wrong ones tests nothing.
 */
export function makeRaw(options: RawFixtureOptions = {}): Buffer {
  const width = options.width ?? 6000;
  const height = options.height ?? 4000;
  const preview = options.preview ?? Buffer.alloc(0);
  const pointer = options.pointer ?? "jpeg-interchange";
  const little = options.bigEndian !== true;

  const headerBytes = 8;
  const ifd0Entries: Entry[] = [
    { tag: TAG.imageWidth, type: TYPE_LONG, value: width },
    { tag: TAG.imageLength, type: TYPE_LONG, value: height },
    // 1 is "no compression": this directory is the sensor image, which is what
    // the photograph's dimensions come from.
    { tag: TAG.compression, type: TYPE_SHORT, value: 1 },
    { tag: TAG.subIfds, type: TYPE_LONG, value: 0 },
  ];

  const previewEntries: Entry[] =
    pointer === "jpeg-interchange"
      ? [
          { tag: TAG.jpegOffset, type: TYPE_LONG, value: 0 },
          { tag: TAG.jpegLength, type: TYPE_LONG, value: preview.length },
          { tag: TAG.compression, type: TYPE_SHORT, value: 6 },
        ]
      : [
          { tag: TAG.stripOffsets, type: TYPE_LONG, value: 0 },
          { tag: TAG.stripByteCounts, type: TYPE_LONG, value: preview.length },
          { tag: TAG.compression, type: TYPE_SHORT, value: 7 },
        ];

  if (options.previewWidth !== undefined) {
    previewEntries.push({ tag: TAG.imageWidth, type: TYPE_LONG, value: options.previewWidth });
  }
  if (options.previewHeight !== undefined) {
    previewEntries.push({ tag: TAG.imageLength, type: TYPE_LONG, value: options.previewHeight });
  }
  previewEntries.sort((a, b) => a.tag - b.tag);

  const ifd0At = headerBytes;
  const ifd0Size = 2 + ifd0Entries.length * 12 + 4;
  const previewAt = ifd0At + ifd0Size;
  const previewSize = 2 + previewEntries.length * 12 + 4;
  const jpegAt = previewAt + previewSize;

  // Now that the layout is known, fill in the offsets that point into it.
  patch(ifd0Entries, TAG.subIfds, previewAt);
  patch(previewEntries, pointer === "jpeg-interchange" ? TAG.jpegOffset : TAG.stripOffsets, jpegAt);

  const bytes = Buffer.alloc(jpegAt + preview.length);
  const write16 = (value: number, at: number): void => {
    if (little) bytes.writeUInt16LE(value, at);
    else bytes.writeUInt16BE(value, at);
  };
  const write32 = (value: number, at: number): void => {
    if (little) bytes.writeUInt32LE(value, at);
    else bytes.writeUInt32BE(value, at);
  };

  bytes.write(little ? "II" : "MM", 0, "latin1");
  write16(42, 2);
  write32(ifd0At, 4);

  writeDirectory(ifd0Entries, ifd0At, 0, write16, write32);
  writeDirectory(previewEntries, previewAt, 0, write16, write32);
  preview.copy(bytes, jpegAt);

  return bytes;
}

function patch(entries: Entry[], tag: number, value: number): void {
  const entry = entries.find((candidate) => candidate.tag === tag);
  if (entry !== undefined) entry.value = value;
}

function writeDirectory(
  entries: readonly Entry[],
  at: number,
  next: number,
  write16: (value: number, at: number) => void,
  write32: (value: number, at: number) => void,
): void {
  write16(entries.length, at);
  for (const [index, entry] of entries.entries()) {
    const field = at + 2 + index * 12;
    write16(entry.tag, field);
    write16(entry.type, field + 2);
    write32(1, field + 4);
    // A SHORT is written into the first two bytes of the value field, which is
    // where a reader looks for it — the remaining two are padding.
    if (entry.type === TYPE_SHORT) write16(entry.value, field + 8);
    else write32(entry.value, field + 8);
  }
  write32(next, at + 2 + entries.length * 12);
}
