import { readFile } from "node:fs/promises";
import * as fontkit from "fontkit";
import { type Raster, rasteriseSvg } from "./vector.js";

/**
 * Fonts: what one says about itself, and what it looks like.
 *
 * A specimen is drawn from **outlines**, never from live text. fontkit lays the
 * string out and hands back a path per glyph; those paths are composed into an
 * SVG this module writes and the WASM rasteriser draws (ADR-0015). The
 * consequence worth stating: the specimen carries no external reference and no
 * `<text>` element whatever the font contains, because by the time it reaches
 * the rasteriser there is no font left in it — only geometry.
 */

/**
 * What a specimen spells, one line each.
 *
 * Ascenders, descenders, round and square on the first line; digits on the
 * second. **Two lines rather than one** because a grid cell is clamped to two
 * and a half times wider than tall (`layout.ts`), and a single line of
 * "Handgloves 123" is nearly six — so it was cropped to its middle, which is
 * what a specimen must not be. Seen in a real window.
 */
export const SPECIMEN_LINES = ["Handgloves", "0123456789"] as const;

/** The specimen as one string, for a caller that wants to say what it spells. */
export const SPECIMEN_TEXT = SPECIMEN_LINES.join(" ");

/** The em size a specimen is laid out at, before it is fitted to a width. */
const SPECIMEN_EM = 256;

/** Padding around the outlines, in the same units. */
const SPECIMEN_PADDING = 24;

/** What a font says about itself. */
export interface FontFacts {
  readonly family: string;
  readonly style: string;
  readonly glyphs: number;
  readonly unitsPerEm: number;
}

/**
 * Reads a font's names and glyph count.
 *
 * A collection (`.ttc`) reports its first face. Nothing here throws on a font
 * with no name table: a nameless font is unusual, not invalid, and an empty
 * string is a better answer than a failed derive.
 */
export async function readFont(path: string): Promise<FontFacts> {
  const font = load(await readFile(path));
  return {
    family: font.familyName ?? "",
    style: font.subfamilyName ?? "",
    glyphs: font.numGlyphs,
    unitsPerEm: font.unitsPerEm,
  };
}

/**
 * Draws a specimen sheet for a font.
 *
 * Returns `undefined` when no glyph in the specimen string has an outline — an
 * icon font, a subset, or a script that shares no characters with it. That is a
 * font with no thumbnail rather than an error, and the same promise every other
 * backend makes about a format it cannot draw.
 */
export async function renderSpecimen(path: string, width: number): Promise<Raster | undefined> {
  const bytes = await readFile(path);
  const font = load(bytes);
  const scale = SPECIMEN_EM / font.unitsPerEm;

  const lines: { parts: string[]; width: number }[] = [];
  for (const line of SPECIMEN_LINES) {
    const run = font.layout(line);
    const parts: string[] = [];
    let pen = 0;

    for (const [index, glyph] of run.glyphs.entries()) {
      const outline = glyph.path.toSVG();
      // A space has no outline and still advances. Skipping the empty path
      // keeps the markup honest rather than emitting `d=""`.
      if (outline !== "") {
        // The Y axis is flipped, because font units grow upward and an SVG's
        // grow down. Doing it per glyph rather than on the group keeps each
        // transform independent of the order they are emitted in.
        parts.push(
          `<path transform="translate(${round(pen * scale)} 0) scale(${round(scale)} ${round(-scale)})" d="${outline}"/>`,
        );
      }
      pen += run.positions[index]?.xAdvance ?? glyph.advanceWidth;
    }

    lines.push({ parts, width: pen * scale });
  }

  // Laying out is not the same as drawing something. A font that covers none of
  // the specimen string still returns a glyph per character — `.notdef`, with
  // an advance and no outline — so the test for "nothing to show" is whether
  // any glyph contributed geometry, never how many glyphs came back.
  if (lines.every((line) => line.parts.length === 0)) return undefined;

  const contentWidth = Math.ceil(Math.max(...lines.map((line) => line.width)));
  const lineHeight = Math.round(SPECIMEN_EM * 1.25);
  const svgWidth = contentWidth + SPECIMEN_PADDING * 2;
  const svgHeight = lineHeight * lines.length + SPECIMEN_PADDING * 2;

  const drawn = lines
    .map((line, index) => {
      const baseline = SPECIMEN_PADDING + Math.round(SPECIMEN_EM * 0.78) + index * lineHeight;
      return `<g transform="translate(${SPECIMEN_PADDING} ${baseline})">${line.parts.join("")}</g>`;
    })
    .join("");

  // No background rectangle: the WebP keeps its alpha, so a specimen sits on
  // whatever the grid cell is painted in and reads in both themes. A white
  // sheet would be a light-mode decision baked into stored bytes.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" ` +
    `viewBox="0 0 ${svgWidth} ${svgHeight}"><g fill="#8a8a8a">${drawn}</g></svg>`;

  return rasteriseSvg(svg, width);
}

/**
 * `fontkit.create` returns a font or a collection, and the two have different
 * shapes. One narrowing, in one place.
 */
function load(bytes: Buffer): fontkit.Font {
  const opened = fontkit.create(bytes);
  if (!("fonts" in opened)) return opened;
  const first = opened.fonts[0];
  // A collection with no faces is a file that claims to be a collection and is
  // not. Nothing downstream can do anything with it, and saying so here is
  // better than handing back a font-shaped null.
  if (first === undefined) throw new Error("font collection contains no faces");
  return first;
}

/** Three decimals is well under a pixel at any size a specimen is drawn at. */
function round(value: number): string {
  return value.toFixed(3);
}
