import { afterEach, describe, expect, it, vi } from "vitest";
import { framePng } from "./frame.js";

/** A `<video>` that says it has decoded a frame of this size. */
const video = (width: number, height: number): HTMLVideoElement => {
  const element = document.createElement("video");
  Object.defineProperty(element, "videoWidth", { value: width });
  Object.defineProperty(element, "videoHeight", { value: height });
  return element;
};

describe("the frame a video is showing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is drawn at the video's own size, not the size it is shown at", async () => {
    // A frame copied from a 4K clip in a small pane must still be 4K: the
    // pane's box is how it is shown, not what it is.
    const drawImage = vi.fn();
    let canvas: HTMLCanvasElement | undefined;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const png = new Blob(["png"], { type: "image/png" });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
      this: HTMLCanvasElement,
      done,
      type,
    ) {
      canvas = this;
      expect(type).toBe("image/png");
      done(png);
    });

    const source = video(3840, 2160);
    const made = framePng(source);

    expect(await made).toBe(png);
    expect(canvas?.width).toBe(3840);
    expect(canvas?.height).toBe(2160);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0, 3840, 2160);
  });

  it("is nothing before a frame has been decoded", () => {
    expect(framePng(video(0, 0))).toBeUndefined();
  });

  it("fails rather than hands over an empty picture", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((done) => done(null));

    await expect(framePng(video(640, 360))).rejects.toThrow("could not be encoded");
  });
});
