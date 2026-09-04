import { describe, expect, it } from "vitest";
import {
  FORMATS,
  type Format,
  formatFromExtension,
  isFormat,
  kindOf,
  mediaTypeOf,
  sniff,
} from "./format.js";

const bytes = (...parts: (number | string)[]): Uint8Array => {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "number") out.push(part);
    else for (const character of part) out.push(character.charCodeAt(0));
  }
  return Uint8Array.from(out);
};

/** One header per format the sniffer claims to recognise. */
const HEADERS: [Format, Uint8Array][] = [
  ["jpeg", bytes(0xff, 0xd8, 0xff, 0xe0)],
  ["png", bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a)],
  ["gif", bytes("GIF89a")],
  ["webp", bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 ")],
  ["wav", bytes("RIFF", 0, 0, 0, 0, "WAVEfmt ")],
  ["bmp", bytes("BM", 0, 0, 0, 0)],
  ["tiff", bytes(0x49, 0x49, 0x2a, 0x00)],
  ["tiff", bytes(0x4d, 0x4d, 0x00, 0x2a)],
  ["pdf", bytes("%PDF-1.7")],
  ["ogg", bytes("OggS")],
  ["flac", bytes("fLaC")],
  ["mp3", bytes("ID3")],
  ["mp3", bytes(0xff, 0xfb, 0x90)],
  ["mkv", bytes(0x1a, 0x45, 0xdf, 0xa3, "matroska")],
  ["webm", bytes(0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, "webm")],
  ["mp4", bytes(0, 0, 0, 0x20, "ftypisom")],
  ["avif", bytes(0, 0, 0, 0x20, "ftypavif")],
  ["ttf", bytes(0x00, 0x01, 0x00, 0x00)],
  ["ttf", bytes("true")],
  ["otf", bytes("OTTO")],
  ["woff", bytes("wOFF")],
  ["woff2", bytes("wOF2")],
  ["zip", bytes("PK", 0x03, 0x04)],
  ["svg", bytes('<?xml version="1.0"?> <svg xmlns="http')],
];

describe("sniffing a header", () => {
  it.each(HEADERS)("recognises %s", (expected, header) => {
    expect(sniff(header)).toBe(expected);
  });

  it("does not trust the extension", () => {
    // The whole reason detection is by magic bytes. A PNG named `.jpg` is
    // ordinary in a downloads folder, and believing the name would mean a wrong
    // thumbnail, wrong dimensions, and a wrong media type on the wire.
    const png = bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a);
    expect(sniff(png)).toBe("png");
    expect(formatFromExtension("jpg")).toBe("jpeg");
  });

  it("reads a short file as unknown rather than failing", () => {
    // A three-byte file is a perfectly valid asset that matches no signature.
    expect(sniff(bytes("abc"))).toBe("unknown");
    expect(sniff(new Uint8Array(0))).toBe("unknown");
  });

  it("leaves a text file to the application that owns it", () => {
    // A `text` format and kind were added on 2026-09-03 and withdrawn on
    // 2026-09-04: showing a text file means owning an editor to go with it, and
    // an external editor is enough. So `.txt` sniffs as unknown and its
    // extension names nothing.
    expect(sniff(bytes("1\n00:00:01,000 --> 00:00:02,000\nHello.\n"))).toBe("unknown");
    expect(formatFromExtension("txt")).toBe("unknown");
    expect(formatFromExtension("srt")).toBe("unknown");
    // SVG stays what it was: text underneath, and an image here.
    expect(formatFromExtension("svg")).toBe("svg");
  });

  it("does not mistake a RIFF container for the wrong kind of RIFF", () => {
    // `RIFF` alone says nothing: WebP and WAV share it and differ at offset 8,
    // and a truncated header carries neither.
    expect(sniff(bytes("RIFF", 0, 0, 0, 0))).toBe("unknown");
  });

  it("keeps the SVG probe from claiming a binary that happens to contain the marker", () => {
    // The SVG check scans a window rather than matching a prefix, so it has to
    // run last or it would steal files whose payload merely mentions it.
    const zipContainingSvg = bytes("PK", 0x03, 0x04, 0, 0, "<svg");
    expect(sniff(zipContainingSvg)).toBe("zip");
  });
});

describe("the vocabulary", () => {
  it("gives every format a kind and a media type", () => {
    // A missing entry would be an `undefined` reaching a `Content-Type` header.
    for (const format of FORMATS) {
      expect(kindOf(format)).toBeTruthy();
      expect(mediaTypeOf(format)).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
      expect(isFormat(format)).toBe(true);
    }
  });

  it("maps an unknown format to a type that makes a webview offer to save", () => {
    expect(mediaTypeOf("unknown")).toBe("application/octet-stream");
    expect(kindOf("unknown")).toBe("other");
  });

  it("folds the extensions that name one format", () => {
    expect(formatFromExtension("jpeg")).toBe(formatFromExtension("jpg"));
    expect(formatFromExtension("tif")).toBe(formatFromExtension("tiff"));
    expect(formatFromExtension("JPG")).toBe("jpeg");
    expect(formatFromExtension("xyz")).toBe("unknown");
  });
});
