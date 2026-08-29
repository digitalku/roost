import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFont, renderSpecimen } from "./font.js";
import { makeFont } from "./testing/font-fixture.js";

describe("fonts", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-font-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const font = async (name: string, options = {}): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, makeFont(options));
    return path;
  };

  it("reads the names an inspector shows", async () => {
    const path = await font("fixture.ttf", { family: "Timber Sans", style: "Italic" });

    expect(await readFont(path)).toEqual({
      family: "Timber Sans",
      style: "Italic",
      glyphs: 2,
      unitsPerEm: 1000,
    });
  });

  it("draws a specimen from outlines, with no font left in the markup", async () => {
    const path = await font("specimen.ttf");

    const specimen = await renderSpecimen(path, 256);

    // Fourteen boxes at 600/1000 em plus padding, fitted to 256 wide. What is
    // asserted is the shape rather than the pixels: the geometry is ours and
    // the rasterising is resvg's.
    expect(specimen).toBeDefined();
    expect(specimen?.width).toBe(256);
    expect(specimen?.height).toBeGreaterThan(20);
  });

  it("puts ink on the page", async () => {
    const path = await font("ink.ttf");
    const sharp = (await import("sharp")).default;

    const specimen = await renderSpecimen(path, 256);
    const { data, info } = await sharp(specimen?.png ?? Buffer.alloc(0))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let opaque = 0;
    for (let at = 3; at < data.length; at += info.channels) {
      if ((data[at] ?? 0) > 128) opaque += 1;
    }

    // The boxes cover a real fraction of the sheet, and the background stays
    // transparent so a specimen reads on a light and a dark cell alike.
    const covered = opaque / (info.width * info.height);
    expect(covered).toBeGreaterThan(0.2);
    expect(covered).toBeLessThan(0.9);
  });

  it("says nothing rather than throwing when a font draws none of the specimen", async () => {
    // An icon font or a subset covers no Latin letters. It still has names
    // worth showing, so this is a font with no picture rather than a failure.
    const path = await font("icons.ttf", { covered: "" });

    expect(await renderSpecimen(path, 256)).toBeUndefined();
  });
});
