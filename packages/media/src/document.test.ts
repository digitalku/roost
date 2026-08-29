import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pageCount, renderPage } from "./document.js";
import {
  FIXTURE_PAGE_HEIGHT,
  FIXTURE_PAGE_WIDTH,
  type FixturePage,
  makePdf,
} from "./testing/pdf-fixture.js";

describe("rendering a PDF", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-pdf-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const pdf = async (name: string, pages: readonly FixturePage[]): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, makePdf(pages));
    return path;
  };

  it("hands back pixels in the order the encoder is told to expect", async () => {
    // The one thing a picture cannot tell you by looking right: pdfium fills a
    // BGRA bitmap and sets a reverse-byte-order flag, and whether that lands as
    // RGBA in memory decides between a blue page and a red one. The fixture
    // paints a page whose colour is known, so this is checkable rather than
    // assumed.
    const path = await pdf("red.pdf", [{ colour: [255, 0, 0] }]);

    const page = await renderPage(path, 0, 64);
    const middle = ((page.height >> 1) * page.width + (page.width >> 1)) * 4;

    expect(page.pixels[middle]).toBeGreaterThan(200);
    expect(page.pixels[middle + 1]).toBeLessThan(60);
    expect(page.pixels[middle + 2]).toBeLessThan(60);
  });

  it("reports the page's own size, not the size it was drawn at", async () => {
    // A grid cell reserves its shape from these, and the render width is an
    // implementation detail that must not become every A4 document's shape.
    const path = await pdf("a4.pdf", [{ colour: [0, 0, 255] }]);

    const page = await renderPage(path, 0, 128);

    expect(page.pageWidth).toBe(FIXTURE_PAGE_WIDTH);
    expect(page.pageHeight).toBe(FIXTURE_PAGE_HEIGHT);
    expect(page.width).toBe(128);
  });

  it("counts pages without rendering any of them", async () => {
    const path = await pdf("three.pdf", [
      { colour: [255, 0, 0] },
      { colour: [0, 255, 0] },
      { colour: [0, 0, 255] },
    ]);

    expect(await pageCount(path)).toBe(3);
  });

  it("renders a page other than the first, twice, without the module falling over", async () => {
    // `render()` closes the page it drew (ADR-0016), so a wrapper that reused a
    // page object would fault inside WASM here — and take the whole library
    // instance with it, so the second call is the one that matters.
    const path = await pdf("pages.pdf", [
      { colour: [255, 0, 0] },
      { colour: [0, 255, 0] },
      { colour: [0, 0, 255] },
    ]);

    const second = await renderPage(path, 1, 32);
    const again = await renderPage(path, 1, 32);
    const third = await renderPage(path, 2, 32);

    const green = ((second.height >> 1) * second.width + (second.width >> 1)) * 4;
    expect(second.pixels[green + 1]).toBeGreaterThan(200);
    expect(again.pixels[green + 1]).toBeGreaterThan(200);
    expect(third.pixels[green + 2]).toBeGreaterThan(200);
  });

  it("refuses a page the document does not have", async () => {
    const path = await pdf("one.pdf", [{ colour: [255, 0, 0] }]);

    await expect(renderPage(path, 4)).rejects.toThrow("page 5 of 1");
  });

  it("throws on a file that is not a PDF, rather than producing an empty page", async () => {
    const path = join(dir, "not.pdf");
    await writeFile(path, "this is not a PDF at all");

    await expect(renderPage(path)).rejects.toThrow();
  });
});
