import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rasteriseSvg, rasteriseSvgFile } from "./vector.js";

/** A solid red PNG, standing in for a file the user never meant to publish. */
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX/AAD///9BHTQRAAAADklEQVQI12P4z8Awi2EGAAlOAf8ZfWpAAAAAAElFTkSuQmCC",
  "base64",
);

function svgReferencing(href: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="64" height="64"><rect width="64" height="64" fill="white"/>` +
    `<image xlink:href="${href}" x="0" y="0" width="64" height="64"/></svg>`
  );
}

/** The fraction of pixels that are unmistakably red, in a PNG. */
async function redFraction(png: Buffer): Promise<number> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let red = 0;
  for (let at = 0; at < data.length; at += info.channels) {
    const r = data[at] ?? 0;
    const g = data[at + 1] ?? 0;
    const b = data[at + 2] ?? 0;
    if (r > 200 && g < 60 && b < 60) red += 1;
  }
  return red / (info.width * info.height);
}

describe("rasterising SVG", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-vector-"));
    await writeFile(join(dir, "secret.png"), RED_PNG);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("draws what the markup describes", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="5"><rect width="10" height="5" fill="red"/></svg>`;

    const raster = await rasteriseSvg(svg, 100);

    // Fitted to the requested width, keeping the drawing's own aspect ratio.
    expect(raster.width).toBe(100);
    expect(raster.height).toBe(50);
    expect(await redFraction(raster.png)).toBeGreaterThan(0.99);
  });

  it("does not read a file the SVG points at, by any path", async () => {
    // The measurement ADR-0015 was decided on, kept as a test: the native
    // binding drew this file with default options and librsvg draws it whenever
    // it is handed a path. A WASM module has no filesystem to reach it through,
    // and this is the assertion that says so out loud.
    const relative = await rasteriseSvgFile(
      await write(dir, "relative.svg", svgReferencing("secret.png")),
    );
    const absolute = await rasteriseSvgFile(
      await write(dir, "absolute.svg", svgReferencing(resolve(dir, "secret.png"))),
    );
    const url = await rasteriseSvgFile(
      await write(dir, "url.svg", svgReferencing(`file://${resolve(dir, "secret.png")}`)),
    );

    for (const raster of [relative, absolute, url]) {
      expect(await redFraction(raster.png)).toBe(0);
    }
  });

  it("draws the rest of an SVG whose reference it refused", async () => {
    // Refusing the reference must not refuse the drawing: an icon set with one
    // embedded bitmap still has a shape worth showing.
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
      `<rect width="64" height="64" fill="red"/>` +
      `<image href="secret.png" x="0" y="0" width="16" height="16"/></svg>`;

    const raster = await rasteriseSvgFile(await write(dir, "mixed.svg", svg));

    expect(await redFraction(raster.png)).toBeGreaterThan(0.99);
  });
});

async function write(dir: string, name: string, contents: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}
