import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBrowserDrawable } from "./format.js";
import { dragPicture, renderForBrowser, renderStill } from "./render.js";
import { gradient } from "./synth.js";
import { canMakeHeic, makeHeic } from "./testing/heic-fixture.js";
import { makeRaw } from "./testing/raw-fixture.js";

/**
 * Pictures for the three formats a browser will not draw (ADR-0040 §7).
 *
 * The pane loads an asset's own bytes into an `<img>`, which is right for a
 * JPEG and empty for a HEIC, a RAW, or a TIFF. This is what it asks for
 * instead.
 */
const hasLibheif = await canMakeHeic();

describe("what a browser can draw for itself", () => {
  it("knows the formats that need no help", () => {
    expect(isBrowserDrawable("jpeg")).toBe(true);
    expect(isBrowserDrawable("svg")).toBe(true);
    // The three that used to open as an empty pane.
    expect(isBrowserDrawable("heic")).toBe(false);
    expect(isBrowserDrawable("raw")).toBe(false);
    expect(isBrowserDrawable("tiff")).toBe(false);
  });

  it("refuses to render what needs no rendering", () => {
    // A caller asking for a JPEG rendition of a JPEG has made a mistake worth
    // hearing about: it would be a re-encode of a picture that was already fine.
    return expect(renderForBrowser("/nowhere.jpg", "jpeg")).rejects.toThrow("needs no rendition");
  });
});

describe("rendering one", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-render-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("turns a TIFF into a JPEG at its own size", async () => {
    const path = join(dir, "scan.tiff");
    await writeFile(path, await gradient(320, 240, 3, "tiff"));

    const rendition = await renderForBrowser(path, "tiff");

    expect(rendition.mediaType).toBe("image/jpeg");
    // A JPEG's own signature, so this asserts the bytes rather than the label.
    expect([...rendition.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  it("takes a RAW's embedded preview, which is the only picture it holds", async () => {
    const path = join(dir, "shot.nef");
    // A RAW with no embedded JPEG has no picture at all — the sensor mosaic is
    // not one — so the fixture carries the preview a camera would have written.
    const preview = await gradient(320, 213, 5, "jpeg");
    await writeFile(path, makeRaw({ width: 6000, height: 4000, preview }));

    const rendition = await renderForBrowser(path, "raw");

    expect(rendition.mediaType).toBe("image/jpeg");
    expect(rendition.bytes.byteLength).toBeGreaterThan(0);
  });

  it.skipIf(!hasLibheif)("assembles a HEIC, which is what the pane could not do", async () => {
    const path = await makeHeic(dir);

    const rendition = await renderForBrowser(path, "heic");

    expect(rendition.mediaType).toBe("image/jpeg");
    expect([...rendition.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });
});

/**
 * A picture for the clipboard: **Copy image** in the asset menu.
 *
 * PNG, full size, and the right way up, because whatever it is pasted into
 * will not read an orientation tag the way a viewer does.
 */
describe("a still picture for the clipboard", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-still-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const PNG = [0x89, 0x50, 0x4e, 0x47];

  it("hands a PNG over byte for byte", async () => {
    const path = join(dir, "logo.png");
    await writeFile(path, await gradient(64, 48, 1, "png"));

    const still = await renderStill(path, "png");

    // The file's own bytes: re-encoding would drop its colour profile for nothing.
    expect(still.equals(await readFile(path))).toBe(true);
  });

  it("re-encodes a file named .png that is not one, rather than passing it on", async () => {
    const path = join(dir, "mislabelled.png");
    await writeFile(path, await gradient(64, 48, 2, "jpeg"));

    const still = await renderStill(path, "png");

    expect([...still.subarray(0, 4)]).toEqual(PNG);
  });

  it("turns a JPEG into a PNG at its own size", async () => {
    const path = join(dir, "photo.jpg");
    await writeFile(path, await gradient(320, 240, 3, "jpeg"));

    const still = await renderStill(path, "jpeg");

    expect([...still.subarray(0, 4)]).toEqual(PNG);
    const { width, height } = await sharp(still).metadata();
    expect([width, height]).toEqual([320, 240]);
  });

  it("stands a photograph taken on its side the right way up", async () => {
    const path = join(dir, "portrait.jpg");
    // Stored landscape with a tag saying "rotate 90°", which is how a phone
    // writes a portrait. A paste carries no tag, so the pixels must turn.
    await writeFile(
      path,
      await sharp(await gradient(320, 240, 4, "jpeg"))
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer(),
    );

    const { width, height } = await sharp(await renderStill(path, "jpeg")).metadata();

    expect([width, height]).toEqual([240, 320]);
  });

  it("draws a vector large enough to paste into a document", async () => {
    const path = join(dir, "mark.svg");
    await writeFile(
      path,
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>',
    );

    const { width, height } = await sharp(await renderStill(path, "svg")).metadata();

    expect([width, height]).toEqual([2048, 1024]);
  });

  it("takes a RAW's embedded preview", async () => {
    const path = join(dir, "shot.nef");
    const preview = await gradient(320, 213, 5, "jpeg");
    await writeFile(path, makeRaw({ width: 6000, height: 4000, preview }));

    const still = await renderStill(path, "raw");

    expect([...still.subarray(0, 4)]).toEqual(PNG);
  });

  it("refuses what is not a picture", () => {
    return expect(renderStill("/nowhere.mp4", "mp4")).rejects.toThrow("no still picture");
  });
});

describe("a picture to drag", () => {
  it("turns a WebP thumbnail into a PNG no larger than asked", async () => {
    // `nativeImage`, which a native drag takes, reads PNG and JPEG and not the
    // WebP the index stores.
    const webp = await sharp(await gradient(256, 160, 6, "png"))
      .webp()
      .toBuffer();

    const picture = await dragPicture(webp, 96);

    expect([...picture.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const { width, height } = await sharp(picture).metadata();
    expect([width, height]).toEqual([96, 60]);
  });
});
