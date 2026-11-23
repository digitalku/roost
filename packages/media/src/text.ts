import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import { type Raster, rasteriseSvg } from "./vector.js";

/**
 * Markdown and plain text: reading what a file says, and drawing its first
 * lines as a thumbnail (ADR-0070).
 *
 * Text has no signature, so the format is named by the extension and then
 * confirmed by the bytes — {@link looksLikeText} — which is the one exception to
 * deciding a format from the bytes alone.
 *
 * The thumbnail is drawn as a font's specimen is (`font.ts`): fontkit lays the
 * lines out in the font Roost ships, and only outlines reach the rasteriser. No
 * `<text>` element, no system font, nothing read on the file's behalf.
 */

/** How the bytes were read, which is also whether they may be written back. */
export const TEXT_ENCODINGS = [
  "utf-8",
  "utf-8-bom",
  "utf-16le",
  "utf-16be",
  "windows-1252",
] as const;
export type TextEncoding = (typeof TEXT_ENCODINGS)[number];

/** What a file's bytes say, decoded. */
export interface DecodedText {
  readonly text: string;
  readonly encoding: TextEncoding;
  /** Whether a line ended in CRLF, which a save puts back (ADR-0070 §3.4). */
  readonly crlf: boolean;
}

/**
 * Whether bytes are text rather than a binary file wearing a text extension.
 *
 * A NUL is the test, as `git` and `grep` use it: no text encoding but UTF-16
 * writes one, and UTF-16 announces itself with a byte-order mark first.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (hasUtf16Bom(bytes)) return true;
  return !bytes.includes(0);
}

/**
 * Decodes a file's bytes, or `undefined` when they are not text.
 *
 * A byte-order mark is believed; valid UTF-8 is UTF-8; anything else is
 * Windows-1252, which is what most text written on Windows is and which decodes
 * every byte. `complete` is false for a window into a longer file: a character
 * cut in half at its end is then held back rather than making the whole read
 * look like something other than UTF-8.
 */
export function decodeText(bytes: Uint8Array, complete = true): DecodedText | undefined {
  if (!looksLikeText(bytes)) return undefined;

  const decoded = ((): { text: string; encoding: TextEncoding } => {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { text: utf8(bytes.subarray(3), complete) ?? "", encoding: "utf-8-bom" };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
    }
    const text = utf8(bytes, complete);
    if (text !== undefined) return { text, encoding: "utf-8" };
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  })();

  return { ...decoded, crlf: decoded.text.includes("\r\n") };
}

/** Whether a file read this way may be written back as UTF-8 (ADR-0070 §3.4). */
export function isWritableEncoding(encoding: TextEncoding): boolean {
  return encoding === "utf-8" || encoding === "utf-8-bom";
}

/**
 * The bytes a save writes: UTF-8, with the byte-order mark and the line endings
 * the file was read with. A `<textarea>` hands back `\n` whatever it was given.
 */
export function encodeText(text: string, options: { bom: boolean; crlf: boolean }): Uint8Array {
  const lines = text.replace(/\r\n/g, "\n");
  const body = new TextEncoder().encode(options.crlf ? lines.replace(/\n/g, "\r\n") : lines);
  if (!options.bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

function hasUtf16Bom(bytes: Uint8Array): boolean {
  return (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
}

function utf8(bytes: Uint8Array, complete: boolean): string | undefined {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return complete ? decoder.decode(bytes) : decoder.decode(bytes, { stream: true });
  } catch {
    return undefined;
  }
}

/** How much of a file a thumbnail reads: far more than fourteen lines need. */
export const TEXT_PREVIEW_BYTES = 4096;

/** The lines a thumbnail draws, and how wide each may be before it wraps. */
export const TEXT_PREVIEW_LINES = 14;
export const TEXT_PREVIEW_COLUMNS = 32;

/** Units a line is laid out in before the whole sheet is fitted to a width. */
const EM = 100;
const LINE_HEIGHT = 1.4;
const PADDING = 60;
/** A Markdown heading is drawn this much larger, without its `#`. */
const HEADING_SCALE = 1.5;

/** The font Roost ships for this, and only for this (`THIRD-PARTY-NOTICES.md` §4). */
const FONT_PATH = fileURLToPath(new URL("../fonts/NotoSansMono-Regular.ttf", import.meta.url));

let font: Promise<fontkit.Font> | undefined;

/** Loaded once per process: parsing half a megabyte of font per file is waste. */
async function previewFont(): Promise<fontkit.Font> {
  font ??= (async () => {
    const opened = await fontkit.open(FONT_PATH);
    // One face in one file, which `fontkit` types as either; the bundled file
    // is a single TrueType font.
    if ("fonts" in opened) throw new Error("the preview font is a collection");
    return opened;
  })();
  return font;
}

/** One line of the sheet: what it says, and the size it is drawn at. */
interface SheetLine {
  readonly text: string;
  readonly scale: number;
}

/**
 * The lines a thumbnail draws: the first ones, wrapped, with Markdown headings
 * picked out. Exported for its tests; the layout is the part worth pinning.
 */
export function sheetLines(text: string, markdown: boolean): SheetLine[] {
  const lines: SheetLine[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (lines.length >= TEXT_PREVIEW_LINES) break;
    const expanded = raw.replace(/\t/g, "    ").trimEnd();
    const heading = markdown ? /^#{1,6}\s+(.*)$/.exec(expanded) : null;
    const scale = heading === null ? 1 : HEADING_SCALE;
    const words = heading === null ? expanded : (heading[1] ?? "");
    const columns = Math.floor(TEXT_PREVIEW_COLUMNS / scale);
    const chars = [...words];
    if (chars.length === 0) {
      lines.push({ text: "", scale: 1 });
      continue;
    }
    let at = 0;
    while (at < chars.length && lines.length < TEXT_PREVIEW_LINES) {
      // At the last space that fits, as a reader would wrap; mid-word only for
      // a word longer than the line.
      let end = Math.min(at + columns, chars.length);
      if (end < chars.length) {
        const space = chars.lastIndexOf(" ", end);
        if (space > at) end = space;
      }
      lines.push({ text: chars.slice(at, end).join("").trimEnd(), scale });
      at = end;
      while (chars[at] === " ") at += 1;
    }
  }
  // Blank lines at the end draw nothing and only push the text up the sheet.
  while (lines.length > 0 && lines.at(-1)?.text === "") lines.pop();
  return lines;
}

/**
 * Draws the first lines of a text file, or `undefined` when there is nothing to
 * draw: an empty file, or one whose every character the font lacks.
 */
export async function renderTextPreview(
  text: string,
  markdown: boolean,
  width: number,
): Promise<Raster | undefined> {
  const lines = sheetLines(text, markdown);
  const face = await previewFont();
  const unit = EM / face.unitsPerEm;
  const advance = face.glyphForCodePoint(0x20).advanceWidth * unit;
  // Square, whatever the text: a grid cell with no dimensions lays out square,
  // and a sheet that grew with its lines would draw a short note smaller than a
  // long one.
  const side = Math.ceil(PADDING * 2 + advance * TEXT_PREVIEW_COLUMNS);

  const parts: string[] = [];
  let baseline = PADDING;
  for (const line of lines) {
    const size = line.scale;
    baseline += EM * LINE_HEIGHT * size;
    // Headings make some sheets taller than they are wide; what does not fit
    // is left off rather than cut through.
    if (baseline > side - PADDING) break;
    if (line.text === "") continue;
    const run = face.layout(line.text);
    let pen = 0;
    for (const [index, glyph] of run.glyphs.entries()) {
      const outline = glyph.path.toSVG();
      // Glyph 0 is `.notdef`, which in this font is a box: a character the font
      // does not have (CJK, emoji) is left out rather than drawn as a tofu.
      if (glyph.id !== 0 && outline !== "") {
        const scale = (unit * size).toFixed(4);
        parts.push(
          `<path transform="translate(${(PADDING + pen).toFixed(2)} ${(baseline - EM * 0.3 * size).toFixed(2)}) scale(${scale} -${scale})" d="${outline}"/>`,
        );
      }
      pen += (run.positions[index]?.xAdvance ?? glyph.advanceWidth) * unit * size;
    }
  }
  if (parts.length === 0) return undefined;
  // Grey on nothing, as a specimen is: the WebP keeps its alpha, so the sheet
  // reads in both themes.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" ` +
    `viewBox="0 0 ${side} ${side}"><g fill="#8a8a8a">${parts.join("")}</g></svg>`;
  return rasteriseSvg(svg, width);
}

/** Reads the start of a file, which is all a thumbnail looks at. */
export async function readTextStart(path: string, bytes = TEXT_PREVIEW_BYTES): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
