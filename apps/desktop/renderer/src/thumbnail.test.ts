import { describe, expect, it } from "vitest";
import { fallbackToGrid, gridSrc, previewSrc } from "./thumbnail.js";

/** A stand-in for the one field the handler reads and writes. */
function imageEvent(src: string): {
  event: React.SyntheticEvent<HTMLImageElement>;
  image: { src: string; hidden: boolean };
} {
  const image = { src, hidden: false };
  return { event: { currentTarget: image } as never, image };
}

describe("when the preview size is not there", () => {
  it("falls back to the grid size, which every drawn asset has", () => {
    // `@512` is made on first use, so there is a window where the inspector
    // wants a size the library does not hold. A softer picture beats Chromium's
    // broken-image glyph, which is what it drew before.
    const { event, image } = imageEvent(previewSrc("a".repeat(64)));

    fallbackToGrid(event);

    expect(image.src).toBe(gridSrc("a".repeat(64)));
    expect(image.hidden).toBe(false);
  });

  it("hides itself rather than looping when the fallback fails too", () => {
    // A second failure means there is no thumbnail at all — a format nothing
    // draws, or work the queue has not reached.
    const { event, image } = imageEvent(gridSrc("b".repeat(64)));

    fallbackToGrid(event);

    expect(image.hidden).toBe(true);
  });
});
