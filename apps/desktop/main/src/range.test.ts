import { describe, expect, it } from "vitest";
import { contentRange, parseRange } from "./range.js";

const SIZE = 1000;

describe("resolving a Range header", () => {
  it("serves the whole file when nothing was asked for", () => {
    for (const header of [null, undefined, "", "   "]) {
      expect(parseRange(header, SIZE)).toEqual({ kind: "whole" });
    }
  });

  it("reads the three forms a player sends", () => {
    expect(parseRange("bytes=0-499", SIZE)).toEqual({
      kind: "partial",
      slice: { start: 0, end: 499 },
    });
    // Open-ended: everything from here on, which is what a `<video>` asks for
    // after a seek.
    expect(parseRange("bytes=500-", SIZE)).toEqual({
      kind: "partial",
      slice: { start: 500, end: 999 },
    });
    // A suffix range asks for the last n bytes — how a player finds an MP4
    // whose moov atom is at the end.
    expect(parseRange("bytes=-200", SIZE)).toEqual({
      kind: "partial",
      slice: { start: 800, end: 999 },
    });
  });

  it("clamps a range that runs past the end rather than refusing it", () => {
    expect(parseRange("bytes=900-99999", SIZE)).toEqual({
      kind: "partial",
      slice: { start: 900, end: 999 },
    });
    expect(parseRange("bytes=-99999", SIZE)).toEqual({
      kind: "partial",
      slice: { start: 0, end: 999 },
    });
  });

  it("refuses only a range that is entirely outside the file", () => {
    // A 200 here would be a lie: the client asked for bytes that do not exist.
    expect(parseRange("bytes=1000-", SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=1200-1300", SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-0", SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=500-499", SIZE)).toEqual({ kind: "unsatisfiable" });
    // An empty file satisfies no range, not even byte zero.
    expect(parseRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("ignores a header it cannot parse, rather than failing the request", () => {
    // RFC 9110 §14.2. A 400 here would leave a video element with nothing to
    // play because of a header it could have done without.
    for (const header of ["items=0-10", "bytes=abc-def", "bytes=0-10, 20-30", "bytes", "0-10"]) {
      expect(parseRange(header, SIZE)).toEqual({ kind: "whole" });
    }
  });

  it("states the full size in Content-Range, which is what makes seeking work", () => {
    expect(contentRange({ start: 500, end: 999 }, SIZE)).toBe("bytes 500-999/1000");
  });
});
