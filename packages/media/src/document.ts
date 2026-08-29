import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PDFiumLibrary } from "@hyzyla/pdfium";
import { packageVersion } from "./manifest.js";

/**
 * PDF, through pdfium compiled to WebAssembly (ADR-0016).
 *
 * Same sandbox argument as `vector.ts`: a PDF is an untrusted file with a
 * scripting model and a long history of parser exploits, and the thing that
 * parses it here cannot reach the filesystem or the network.
 *
 * **A page is single-use.** `render()` closes the page in its `finally`, so a
 * second render through the same page object renders through a freed handle and
 * faults inside the module — `null function or function signature mismatch`,
 * not a catchable error at the boundary. Every function here therefore opens a
 * document, takes what it needs, and destroys it, and no page object escapes
 * this module.
 */

const require = createRequire(import.meta.url);

/** How wide a rendered page is before it is downscaled to thumbnails. */
export const PAGE_RENDER_WIDTH = 512;

let library: Promise<PDFiumLibrary> | undefined;

/** Initialises the library once, lazily. Measured at 24–28 ms. */
async function open(): Promise<PDFiumLibrary> {
  library ??= PDFiumLibrary.init();
  return library;
}

/** One rendered page, as raw RGBA pixels. */
export interface RenderedPage {
  readonly pixels: Buffer;
  readonly width: number;
  readonly height: number;
  /** The page's own size in points, before scaling. */
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly pages: number;
}

/**
 * Renders one page, and reports how many the document has.
 *
 * `pageIndex` is zero-based. A document that cannot be opened — encrypted,
 * truncated, or not a PDF at all — throws, and the caller turns that into a
 * missing thumbnail rather than an import failure.
 */
export async function renderPage(
  path: string,
  pageIndex = 0,
  width = PAGE_RENDER_WIDTH,
): Promise<RenderedPage> {
  const pdfium = await open();
  const document = await pdfium.loadDocument(await readFile(path));

  try {
    const pages = document.getPageCount();
    if (pageIndex < 0 || pageIndex >= pages) {
      throw new Error(`page ${pageIndex + 1} of ${pages}`);
    }

    const { originalWidth, originalHeight } = document.getPage(pageIndex).getOriginalSize();
    // Scaled here rather than after the fact: rendering a 40-inch poster page
    // at scale 1 and then shrinking it would cost the full bitmap first, and
    // the WASM heap is the thing that grows.
    const scale = originalWidth > 0 ? Math.min(width / originalWidth, 4) : 1;

    // A second `getPage`, because the one above has been used for its size and
    // the render is what closes a page. See the note at the top of this file.
    const rendered = await document.getPage(pageIndex).render({
      scale,
      // The bitmap is handed back as-is; `sharp` is what encodes it, and no
      // intermediate PNG is produced to be decoded again.
      render: (options) => Promise.resolve(options.data),
    });

    return {
      pixels: Buffer.from(rendered.data),
      width: rendered.width,
      height: rendered.height,
      pageWidth: Math.round(originalWidth),
      pageHeight: Math.round(originalHeight),
      pages,
    };
  } finally {
    document.destroy();
  }
}

/** How many pages a document has, without rendering any of them. */
export async function pageCount(path: string): Promise<number> {
  const pdfium = await open();
  const document = await pdfium.loadDocument(await readFile(path));
  try {
    return document.getPageCount();
  } finally {
    document.destroy();
  }
}

/** The PDF backend's version, for `roost doctor`. */
export function documentVersion(): string {
  return packageVersion("@hyzyla/pdfium/pdfium.wasm", require.resolve);
}
