import { describe, expect, it } from "vitest";
import {
  decodeText,
  encodeText,
  isWritableEncoding,
  looksLikeText,
  renderTextPreview,
  sheetLines,
  TEXT_PREVIEW_COLUMNS,
  TEXT_PREVIEW_LINES,
} from "./text.js";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("reading a text file's bytes (ADR-0070 §3.4)", () => {
  it("reads UTF-8, and says so", () => {
    expect(decodeText(utf8("Café\n"))).toEqual({ text: "Café\n", encoding: "utf-8", crlf: false });
  });

  it("believes a byte-order mark, and remembers it", () => {
    const decoded = decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("hi")]));
    expect(decoded).toMatchObject({ text: "hi", encoding: "utf-8-bom" });
    expect(decodeText(bytes(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00))).toMatchObject({
      text: "hi",
      encoding: "utf-16le",
    });
  });

  it("reads what is not UTF-8 as Windows-1252, which cannot be written back", () => {
    const decoded = decodeText(bytes(0x43, 0x61, 0x66, 0xe9));
    expect(decoded).toMatchObject({ text: "Café", encoding: "windows-1252" });
    expect(isWritableEncoding("windows-1252")).toBe(false);
    expect(isWritableEncoding("utf-8-bom")).toBe(true);
  });

  it("holds back a character cut in half at the end of a window, and only there", () => {
    const cut = utf8("Café").subarray(0, 4);
    expect(decodeText(cut, false)).toMatchObject({ text: "Caf", encoding: "utf-8" });
    // A whole file ending mid-character is not UTF-8.
    expect(decodeText(cut, true)?.encoding).toBe("windows-1252");
  });

  it("refuses bytes with a NUL in them, unless UTF-16 announced itself", () => {
    expect(looksLikeText(bytes(0x41, 0x00))).toBe(false);
    expect(decodeText(bytes(0x41, 0x00))).toBeUndefined();
    expect(looksLikeText(bytes(0xfe, 0xff, 0x00, 0x41))).toBe(true);
  });

  it("notices CRLF, and writes back the endings and the mark it read", () => {
    expect(decodeText(utf8("a\r\nb"))?.crlf).toBe(true);
    const written = encodeText("a\nb\n", { bom: true, crlf: true });
    expect([...written.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(written.subarray(3))).toBe("a\r\nb\r\n");
    expect(new TextDecoder().decode(encodeText("a\r\nb", { bom: false, crlf: false }))).toBe(
      "a\nb",
    );
  });
});

describe("the sheet a thumbnail draws (ADR-0070 §3.5)", () => {
  it("picks out a Markdown heading and drops its marks, and leaves text alone", () => {
    expect(sheetLines("# Title\nbody", true)).toEqual([
      { text: "Title", scale: 1.5 },
      { text: "body", scale: 1 },
    ]);
    expect(sheetLines("# Title", false)).toEqual([{ text: "# Title", scale: 1 }]);
  });

  it("wraps a long line and stops at the last line it draws", () => {
    const long = "x".repeat(TEXT_PREVIEW_COLUMNS + 3);
    expect(sheetLines(long, false).map((line) => line.text.length)).toEqual([
      TEXT_PREVIEW_COLUMNS,
      3,
    ]);
    expect(sheetLines(`${"word ".repeat(7)}end`, false).map((line) => line.text)).toEqual([
      "word word word word word word",
      "word end",
    ]);
    const many = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    expect(sheetLines(many, false)).toHaveLength(TEXT_PREVIEW_LINES);
  });

  it("draws something for text, and nothing for nothing", async () => {
    const raster = await renderTextPreview("hello\nworld", false, 256);
    expect(raster?.width).toBe(256);
    expect(raster?.height).toBe(256);
    expect(await renderTextPreview("\n\n", false, 256)).toBeUndefined();
    // A script the font does not cover is left out, not drawn as boxes.
    expect(await renderTextPreview("中文", false, 256)).toBeUndefined();
  });
});
