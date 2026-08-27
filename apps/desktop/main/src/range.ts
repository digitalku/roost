/**
 * `Range: bytes=…`, resolved against a known size.
 *
 * ADR-0008's reason for streaming originals is that video and audio seek by
 * asking for ranges. `roost-old` hand-rolled 8 MB chunks because Tauri could
 * not stream at all; here the file is streamed and this decides which part of
 * it, which is the only arithmetic involved.
 *
 * Kept pure and separate from the handler so the edge cases — a suffix range, a
 * range that runs past the end, a range over an empty file — are asserted
 * without an Electron process.
 */
export interface Slice {
  readonly start: number;
  /** Inclusive, the way `Content-Range` and `createReadStream` both mean it. */
  readonly end: number;
}

export type Requested =
  | { readonly kind: "whole" }
  | { readonly kind: "partial"; readonly slice: Slice }
  /** RFC 9110 §14.4: answer 416 and say what the size actually is. */
  | { readonly kind: "unsatisfiable" };

const WHOLE: Requested = { kind: "whole" };

/**
 * A header this cannot make sense of is **ignored**, not rejected.
 *
 * That is what RFC 9110 §14.2 asks for, and it is also the safer failure: a
 * malformed range from a webview should produce the file, not a 400 that leaves
 * a video element with nothing to play. Only a syntactically valid range that
 * falls outside the file is refused, because there a 200 would be a lie.
 */
export function parseRange(header: string | null | undefined, size: number): Requested {
  if (header === null || header === undefined || header.trim() === "") return WHOLE;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return WHOLE;

  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") return WHOLE;

  // An empty file can satisfy no range at all — not even `bytes=0-`, because
  // there is no byte zero.
  if (size === 0) return { kind: "unsatisfiable" };

  if (rawStart === "") {
    // A suffix range: the *last* n bytes. `bytes=-0` asks for nothing, which is
    // unsatisfiable rather than an empty body.
    const suffix = Number(rawEnd);
    if (suffix === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", slice: { start: Math.max(0, size - suffix), end: size - 1 } };
  }

  const start = Number(rawStart);
  if (start >= size) return { kind: "unsatisfiable" };

  // Running past the end is normal, not an error: a player that asks for a
  // megabyte from near the end gets what is there.
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return { kind: "unsatisfiable" };
  return { kind: "partial", slice: { start, end } };
}

/** The `Content-Range` value for a slice, which must state the full size. */
export function contentRange(slice: Slice, size: number): string {
  return `bytes ${slice.start}-${slice.end}/${size}`;
}
