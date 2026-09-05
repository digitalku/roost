import { describe, expect, it } from "vitest";
import { isConvertible, toWebVtt } from "./subtitle.js";

const SRT = "1\r\n00:00:01,000 --> 00:00:02,500\r\nHello, world\r\n\r\n";

describe("turning a subtitle into WebVTT", () => {
  it("declares the format and dots the timestamps", () => {
    expect(toWebVtt(SRT)).toBe("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHello, world\n\n");
  });

  it("leaves a comma in the words alone", () => {
    // Only inside a timestamp line: a comma in a subtitle's words is a comma.
    expect(toWebVtt(SRT)).toContain("Hello, world");
  });

  it("passes a file that already says WEBVTT straight through", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAlready\n";
    expect(toWebVtt(vtt)).toBe(vtt);
  });

  it("is safe to run twice", () => {
    expect(toWebVtt(toWebVtt(SRT))).toBe(toWebVtt(SRT));
  });

  it("drops a byte-order mark, which would hide the whole track", () => {
    // WEBVTT must be the first thing in the file. A BOM before it makes the
    // track invisible, silently, with no error anywhere.
    expect(toWebVtt(`﻿${SRT}`).startsWith("WEBVTT")).toBe(true);
  });

  it("knows what it can convert without an external tool", () => {
    expect(isConvertible("srt")).toBe(true);
    expect(isConvertible("VTT")).toBe(true);
    // ASS and an embedded stream both need ffmpeg, which may not be there.
    expect(isConvertible("ass")).toBe(false);
  });
});
