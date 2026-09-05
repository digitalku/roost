/**
 * Serving a caption track to a `<track>` element (ADR-0025).
 *
 * **Chromium accepts WebVTT and nothing else**, and the format people actually
 * have is SubRip. The conversion between them is a header line and a decimal
 * comma, so it is done here rather than by an external tool: a subtitle that
 * needed ffmpeg to be *read* would be one more thing to be blocked on, for a
 * file that is already text.
 */

/**
 * Every subtitle extension Roost recognises, convertible or not.
 *
 * One list, because three places need it and they must agree: the file chooser
 * filters on it, the import heuristic decides what to look for a film beside,
 * and a track that is recognised but not {@link isConvertible} is attached and
 * waits for the backend that can read it.
 */
export const SUBTITLE_EXTENSIONS = ["srt", "vtt", "ass", "ssa"] as const;

/** Extensions this module can turn into WebVTT without help. */
const CONVERTIBLE = new Set(["srt", "vtt", "webvtt"]);

/** Whether a track can be served without an external tool. */
export function isConvertible(ext: string): boolean {
  return CONVERTIBLE.has(ext.toLowerCase());
}

/**
 * SubRip in, WebVTT out.
 *
 * Three differences, and no more: WebVTT declares itself in a first line, its
 * timestamps separate seconds from milliseconds with a **dot** rather than a
 * comma, and it treats what SubRip calls a cue number as an optional
 * identifier — which is left in place, because it is legal there and dropping
 * it would lose what an editor may be using to find a line.
 *
 * A file that already declares `WEBVTT` is passed through untouched. A file
 * that declares nothing but is already dotted converts to itself, which is what
 * makes running this twice safe.
 *
 * **The byte-order mark is dropped**, because WebVTT's own header must be the
 * first thing in the file and a BOM before it makes the whole track invisible —
 * silently, with no error anywhere.
 */
export function toWebVtt(text: string): string {
  const body = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (/^WEBVTT/.test(body)) return body;

  // Only inside a timestamp line: a comma in a subtitle's words is a comma.
  const cues = body.replace(
    /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/g,
    "$1.$2 --> $3.$4",
  );

  return `WEBVTT\n\n${cues.replace(/^\n+/, "")}`;
}
