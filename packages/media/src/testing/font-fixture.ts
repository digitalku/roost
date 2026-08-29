/**
 * A TrueType font small enough to write by hand, for tests.
 *
 * The specimen path composes glyph outlines into markup and rasterises it, so
 * testing it needs a font — and a real one would mean committing someone else's
 * licence into the repository for the sake of a picture of the word
 * "Handgloves". This builds the smallest thing fontkit will parse: two glyphs,
 * one of them a filled box every character maps to, and the tables required to
 * make that legal.
 *
 * It is deliberately not a font anyone would use. What it has to be is
 * *correct enough* that fontkit reports the names, lays out a string, and hands
 * back outlines — which is exactly the surface the specimen depends on.
 */

/** Font units per em. A round number keeps the expected geometry readable. */
const UNITS_PER_EM = 1000;

/** The box glyph's advance and its outline, in font units. */
const ADVANCE = 600;
const BOX = { left: 50, bottom: 0, right: 550, top: 700 } as const;

/** The characters the fixture maps to its one drawable glyph. */
const COVERED = " 0123456789Handgloves";

export interface FontFixtureOptions {
  readonly family?: string;
  readonly style?: string;
  /**
   * Which characters the font covers. An empty string builds a font that maps
   * nothing — an icon font or a subset, from the specimen's point of view.
   */
  readonly covered?: string;
}

/** Builds a parseable TrueType font whose every covered character is a box. */
export function makeFont(options: FontFixtureOptions = {}): Buffer {
  const family = options.family ?? "Roost Fixture";
  const style = options.style ?? "Regular";

  const glyf = buildGlyf();
  const tables: [string, Buffer][] = [
    ["cmap", buildCmap(options.covered ?? COVERED)],
    ["glyf", glyf.table],
    ["head", buildHead()],
    ["hhea", buildHhea()],
    ["hmtx", buildHmtx()],
    ["loca", glyf.loca],
    ["maxp", buildMaxp()],
    ["name", buildName(family, style)],
    ["post", buildPost()],
  ];

  return assemble(tables);
}

/** Glyph 0 is `.notdef` and empty; glyph 1 is the box. */
function buildGlyf(): { table: Buffer; loca: Buffer } {
  const box = simpleGlyph([
    [BOX.left, BOX.bottom],
    [BOX.right, BOX.bottom],
    [BOX.right, BOX.top],
    [BOX.left, BOX.top],
  ]);

  // `.notdef` is zero-length, which is legal and is how an empty glyph is
  // spelled: two identical `loca` entries. `loca` is written in short format,
  // so every offset is halved and every glyph has to start on an even byte —
  // which is what `simpleGlyph` pads for.
  const loca = Buffer.alloc(3 * 2);
  loca.writeUInt16BE(0, 0);
  loca.writeUInt16BE(0, 2);
  loca.writeUInt16BE(box.length / 2, 4);

  return { table: box, loca };
}

/** One closed contour of on-curve points. */
function simpleGlyph(points: readonly (readonly [number, number])[]): Buffer {
  const header = Buffer.alloc(10);
  header.writeInt16BE(1, 0); // one contour
  header.writeInt16BE(BOX.left, 2);
  header.writeInt16BE(BOX.bottom, 4);
  header.writeInt16BE(BOX.right, 6);
  header.writeInt16BE(BOX.top, 8);

  const endPoints = Buffer.alloc(2);
  endPoints.writeUInt16BE(points.length - 1, 0);

  const instructions = Buffer.alloc(2); // length 0

  // 0x01 is "on curve". No repeat flags and no short coordinates: the point of
  // this fixture is to be readable, not compact.
  const flags = Buffer.alloc(points.length, 0x01);

  const xs = Buffer.alloc(points.length * 2);
  const ys = Buffer.alloc(points.length * 2);
  let previousX = 0;
  let previousY = 0;
  for (const [index, [x, y]] of points.entries()) {
    xs.writeInt16BE(x - previousX, index * 2);
    ys.writeInt16BE(y - previousY, index * 2);
    previousX = x;
    previousY = y;
  }

  return pad4(Buffer.concat([header, endPoints, instructions, flags, xs, ys]));
}

/** A format 4 subtable mapping the covered characters to glyph 1. */
function buildCmap(covered: string): Buffer {
  const codes = [...new Set([...covered])]
    .map((character) => character.charCodeAt(0))
    .sort((a, b) => a - b);

  // One segment per character keeps the arithmetic obvious; a real font would
  // merge runs.
  const segments = codes.map((code) => ({ start: code, end: code }));
  segments.push({ start: 0xffff, end: 0xffff });

  const segCount = segments.length;
  const subtable = Buffer.alloc(16 + segCount * 8);
  subtable.writeUInt16BE(4, 0); // format
  subtable.writeUInt16BE(subtable.length, 2);
  subtable.writeUInt16BE(0, 4); // language
  subtable.writeUInt16BE(segCount * 2, 6);
  const entrySelector = Math.floor(Math.log2(segCount));
  subtable.writeUInt16BE(2 ** entrySelector * 2, 8);
  subtable.writeUInt16BE(entrySelector, 10);
  subtable.writeUInt16BE(segCount * 2 - 2 ** entrySelector * 2, 12);

  const endsAt = 14;
  const startsAt = endsAt + segCount * 2 + 2;
  const deltasAt = startsAt + segCount * 2;
  const rangesAt = deltasAt + segCount * 2;

  for (const [index, segment] of segments.entries()) {
    subtable.writeUInt16BE(segment.end, endsAt + index * 2);
    subtable.writeUInt16BE(segment.start, startsAt + index * 2);
    // idDelta maps the character straight onto glyph 1, except for the
    // terminating segment, which must map 0xffff to glyph 0.
    const delta = segment.start === 0xffff ? 1 : 1 - segment.start;
    subtable.writeInt16BE(delta, deltasAt + index * 2);
    subtable.writeUInt16BE(0, rangesAt + index * 2);
  }

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // version
  header.writeUInt16BE(1, 2); // one encoding record
  header.writeUInt16BE(3, 4); // platform: Windows
  header.writeUInt16BE(1, 6); // encoding: Unicode BMP
  header.writeUInt32BE(12, 8); // offset to the subtable

  return Buffer.concat([header, subtable]);
}

function buildHead(): Buffer {
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0); // version
  head.writeUInt32BE(0x00010000, 4); // fontRevision
  head.writeUInt32BE(0, 8); // checkSumAdjustment, not validated by readers
  head.writeUInt32BE(0x5f0f3cf5, 12); // magic
  head.writeUInt16BE(0, 16); // flags
  head.writeUInt16BE(UNITS_PER_EM, 18);
  // created / modified: zero is 1904-01-01, which is a date and therefore fine.
  head.writeInt16BE(BOX.left, 36); // xMin
  head.writeInt16BE(BOX.bottom, 38); // yMin
  head.writeInt16BE(BOX.right, 40); // xMax
  head.writeInt16BE(BOX.top, 42); // yMax
  head.writeUInt16BE(0, 44); // macStyle
  head.writeUInt16BE(8, 46); // lowestRecPPEM
  head.writeInt16BE(2, 48); // fontDirectionHint
  head.writeInt16BE(0, 50); // indexToLocFormat: short
  head.writeInt16BE(0, 52); // glyphDataFormat
  return head;
}

function buildHhea(): Buffer {
  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(800, 4); // ascender
  hhea.writeInt16BE(-200, 6); // descender
  hhea.writeInt16BE(0, 8); // lineGap
  hhea.writeUInt16BE(ADVANCE, 10); // advanceWidthMax
  hhea.writeInt16BE(BOX.left, 12); // minLeftSideBearing
  hhea.writeInt16BE(ADVANCE - BOX.right, 14); // minRightSideBearing
  hhea.writeInt16BE(BOX.right, 16); // xMaxExtent
  hhea.writeInt16BE(1, 18); // caretSlopeRise
  hhea.writeInt16BE(0, 20); // caretSlopeRun
  hhea.writeInt16BE(0, 34); // metricDataFormat is at 32; numberOfHMetrics at 34
  hhea.writeUInt16BE(2, 34);
  return hhea;
}

function buildHmtx(): Buffer {
  const hmtx = Buffer.alloc(2 * 4);
  hmtx.writeUInt16BE(ADVANCE, 0); // .notdef
  hmtx.writeInt16BE(0, 2);
  hmtx.writeUInt16BE(ADVANCE, 4); // the box
  hmtx.writeInt16BE(BOX.left, 6);
  return hmtx;
}

function buildMaxp(): Buffer {
  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(2, 4); // numGlyphs
  maxp.writeUInt16BE(4, 6); // maxPoints
  maxp.writeUInt16BE(1, 8); // maxContours
  return maxp;
}

/** Family and subfamily, in the two records every reader looks for. */
function buildName(family: string, style: string): Buffer {
  const entries: { id: number; text: string }[] = [
    { id: 1, text: family },
    { id: 2, text: style },
    { id: 4, text: `${family} ${style}` },
    { id: 6, text: `${family}-${style}`.replace(/\s+/g, "") },
  ];

  const strings: Buffer[] = [];
  const records = Buffer.alloc(entries.length * 12);
  let stringOffset = 0;

  for (const [index, entry] of entries.entries()) {
    const bytes = Buffer.from(entry.text, "utf16le").swap16();
    strings.push(bytes);
    const at = index * 12;
    records.writeUInt16BE(3, at); // platform: Windows
    records.writeUInt16BE(1, at + 2); // encoding: Unicode BMP
    records.writeUInt16BE(0x0409, at + 4); // language: en-US
    records.writeUInt16BE(entry.id, at + 6);
    records.writeUInt16BE(bytes.length, at + 8);
    records.writeUInt16BE(stringOffset, at + 10);
    stringOffset += bytes.length;
  }

  const header = Buffer.alloc(6);
  header.writeUInt16BE(0, 0); // format
  header.writeUInt16BE(entries.length, 2);
  header.writeUInt16BE(6 + entries.length * 12, 4);

  return Buffer.concat([header, records, ...strings]);
}

function buildPost(): Buffer {
  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0); // version 3.0: no glyph names
  post.writeInt16BE(0, 8); // underlinePosition
  return post;
}

/** Writes the sfnt directory around the tables, with each one's checksum. */
function assemble(tables: readonly [string, Buffer][]): Buffer {
  const sorted = [...tables].sort(([a], [b]) => (a < b ? -1 : 1));
  const count = sorted.length;
  const directory = Buffer.alloc(12 + count * 16);

  directory.writeUInt32BE(0x00010000, 0);
  directory.writeUInt16BE(count, 4);
  const entrySelector = Math.floor(Math.log2(count));
  directory.writeUInt16BE(2 ** entrySelector * 16, 6);
  directory.writeUInt16BE(entrySelector, 8);
  directory.writeUInt16BE(count * 16 - 2 ** entrySelector * 16, 10);

  let offset = directory.length;
  const bodies: Buffer[] = [];

  for (const [index, [tag, body]] of sorted.entries()) {
    const at = 12 + index * 16;
    directory.write(tag, at, 4, "latin1");
    directory.writeUInt32BE(checksum(body), at + 4);
    directory.writeUInt32BE(offset, at + 8);
    directory.writeUInt32BE(body.length, at + 12);

    const padded = pad4(body);
    bodies.push(padded);
    offset += padded.length;
  }

  return Buffer.concat([directory, ...bodies]);
}

function checksum(table: Buffer): number {
  const padded = pad4(table);
  let sum = 0;
  for (let at = 0; at < padded.length; at += 4) {
    sum = (sum + padded.readUInt32BE(at)) >>> 0;
  }
  return sum;
}

function pad4(buffer: Buffer): Buffer {
  const remainder = buffer.length % 4;
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(4 - remainder)]);
}
