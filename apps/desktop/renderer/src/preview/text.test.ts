import { describe, expect, it } from "vitest";
import { decodeText } from "./text.js";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("decoding a text asset", () => {
  it("believes a byte-order mark, and does not show it", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("Hello.")]);
    const decoded = decodeText(bytes);
    expect(decoded).toEqual({ text: "Hello.", encoding: "utf-8", guessed: false });
  });

  it("reads UTF-16 when a mark declares it", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    expect(decodeText(bytes)).toEqual({ text: "Hi", encoding: "utf-16le", guessed: false });
  });

  it("reads valid UTF-8 as UTF-8, and says it was inferred", () => {
    const decoded = decodeText(utf8("Café — naïve"));
    expect(decoded.text).toBe("Café — naïve");
    expect(decoded.encoding).toBe("utf-8");
    // No mark, so this is a decision made from the bytes rather than a fact the
    // file stated. The viewer says which it was.
    expect(decoded.guessed).toBe(true);
  });

  it("falls back to Windows-1252, which is what most subtitles are", () => {
    // 0xe9 is a bare é in Windows-1252 and is not valid UTF-8 anywhere.
    const decoded = decodeText(new Uint8Array([0x43, 0x61, 0x66, 0xe9]));
    expect(decoded.text).toBe("Café");
    expect(decoded.encoding).toBe("windows-1252");
  });

  it("does not condemn a file for where the read stopped", () => {
    // The preview reads a range, so the window can end mid-character. Treating
    // that as invalid would send a perfectly good UTF-8 file down the legacy
    // path on nothing but its length.
    const whole = utf8("Café");
    const cut = whole.subarray(0, whole.length - 1);
    const decoded = decodeText(cut, true);
    expect(decoded.encoding).toBe("utf-8");
    expect(decoded.text).toBe("Caf");
  });
});
