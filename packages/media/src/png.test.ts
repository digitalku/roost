import { describe, expect, it } from "vitest";
import { encodePng } from "./png.js";

/** Two pixels: opaque red, then opaque blue. */
function pixels(): Buffer {
  return Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]);
}

describe("encoding a PNG without an image library", () => {
  it("writes a file a decoder recognises", async () => {
    const png = encodePng(pixels(), 2, 1);

    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(1);
    // Decoded by something that is not this encoder, which is the only way to
    // know the chunks, the CRCs, and the filter bytes are all right.
    const sharp = (await import("sharp")).default;
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });

    expect([info.width, info.height, info.channels]).toEqual([2, 1, 4]);
    expect([...data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...data.subarray(4, 8)]).toEqual([0, 0, 255, 255]);
  });

  it("compresses what a document page is mostly made of", () => {
    // A page is mostly one colour, and that is the whole reason this encodes
    // rather than handing over a bitmap: three megabytes against tens of
    // kilobytes.
    const white = Buffer.alloc(512 * 700 * 4, 0xff);

    expect(encodePng(white, 512, 700).length).toBeLessThan(white.length / 100);
  });

  it("refuses pixels that do not fill the size they claim", () => {
    expect(() => encodePng(pixels(), 4, 4)).toThrow("not enough pixels");
  });
});
