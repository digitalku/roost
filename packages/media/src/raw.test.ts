import { describe, expect, it } from "vitest";
import { sniff } from "./format.js";
import { isTiffContainer, looksLikeRaw, parseRaw } from "./raw.js";
import { gradient } from "./synth.js";
import { makeRaw } from "./testing/raw-fixture.js";

const jpeg = await gradient(320, 213, 5, "jpeg");

describe("reading a RAW", () => {
  it("finds the preview a camera embedded, however it is pointed at", () => {
    for (const pointer of ["jpeg-interchange", "strip"] as const) {
      const facts = parseRaw(makeRaw({ preview: jpeg, pointer }));

      expect(facts?.preview?.bytes.equals(jpeg)).toBe(true);
    }
  });

  it("reports the photograph's size, not the preview's", () => {
    // A 24-megapixel RAW whose preview is 320 pixels wide is a 24-megapixel
    // photograph. An inspector that showed the preview's size would be
    // describing a thumbnail.
    const facts = parseRaw(
      makeRaw({ width: 6000, height: 4000, preview: jpeg, previewWidth: 320, previewHeight: 213 }),
    );

    expect(facts).toMatchObject({ width: 6000, height: 4000 });
  });

  it("reads a big-endian container, which is what a Nikon writes", () => {
    const facts = parseRaw(makeRaw({ bigEndian: true, width: 4000, height: 3000, preview: jpeg }));

    expect(facts).toMatchObject({ width: 4000, height: 3000 });
    expect(facts?.preview?.bytes.equals(jpeg)).toBe(true);
  });

  it("takes the largest preview when a file carries several", async () => {
    // Cameras write a small thumbnail *and* a full-size preview. The grid wants
    // the second one.
    const small = await smallJpeg();
    const container = Buffer.concat([
      makeRaw({ preview: jpeg }),
      // A second file appended is not a real layout, but the reader's rule —
      // take the largest JPEG it can reach — is what this checks.
      makeRaw({ preview: small }),
    ]);

    expect(parseRaw(container)?.preview?.bytes.length).toBe(jpeg.length);
  });

  it("refuses a pointer that leaves the file, rather than reading past the end", () => {
    const truncated = makeRaw({ preview: jpeg }).subarray(0, 60);

    // Still a TIFF header, so still parsed — and the preview it names is no
    // longer there, which is what a half-copied file looks like.
    expect(parseRaw(truncated)?.preview).toBeUndefined();
  });

  it("refuses a pointer that does not lead to a JPEG", () => {
    const notJpeg = Buffer.from("this is not a JPEG at all, it is a sentence");

    expect(parseRaw(makeRaw({ preview: notJpeg }))?.preview).toBeUndefined();
  });

  it("is not a RAW when a TIFF carries no preview, which is what a scan is", () => {
    const scan = parseRaw(makeRaw({ width: 2480, height: 3508 }));

    expect(scan).toMatchObject({ width: 2480, height: 3508 });
    expect(looksLikeRaw(scan ?? {})).toBe(false);
  });

  it("says nothing about a file that is not a TIFF container", () => {
    expect(parseRaw(Buffer.from("%PDF-1.7"))).toBeUndefined();
    expect(isTiffContainer(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });

  it("does not hang on a directory that points at itself", () => {
    // Offsets come from the file, and a loop in them is a hang rather than a
    // wrong answer. The walk is bounded in depth and in count.
    const looped = makeRaw({ preview: jpeg });
    // Point IFD0's "next directory" back at IFD0.
    looped.writeUInt32LE(8, 8 + 2 + 4 * 12);

    expect(() => parseRaw(looped)).not.toThrow();
  });
});

describe("recognising a RAW from its first bytes", () => {
  it("knows a CR2 by the marker Canon puts at offset 8", () => {
    const cr2 = Buffer.alloc(64);
    cr2.write("II", 0, "latin1");
    cr2.writeUInt16LE(42, 2);
    cr2.write("CR", 8, "latin1");

    expect(sniff(cr2)).toBe("raw");
  });

  it("knows Canon's CR3, which is an ISO base media file and not a video", () => {
    const cr3 = Buffer.alloc(64);
    cr3.write("ftyp", 4, "latin1");
    cr3.write("crx ", 8, "latin1");

    expect(sniff(cr3)).toBe("raw");
  });

  it("leaves a plain TIFF header alone, because a NEF looks exactly like one", () => {
    const tiff = Buffer.alloc(64);
    tiff.write("II", 0, "latin1");
    tiff.writeUInt16LE(42, 2);

    // Sniffing is a header question, and this one is not answerable from 64
    // bytes: what separates them is a directory further into the file.
    expect(sniff(tiff)).toBe("tiff");
  });
});

async function smallJpeg(): Promise<Buffer> {
  return gradient(16, 16, 2, "jpeg");
}
