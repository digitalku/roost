import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBrowserDrawable } from "./format.js";
import { renderForBrowser } from "./render.js";
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
