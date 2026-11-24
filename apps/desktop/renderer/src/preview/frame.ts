/**
 * The frame a video is showing, as a PNG at the video's own size (ADR-0034 §9).
 *
 * Drawn from the element rather than asked of ffmpeg: the frame is already
 * decoded and on screen, and reading the file again to find it would cost a
 * process and could land a frame either side of the one somebody stopped on.
 *
 * The canvas can be read because the element is fetched with `crossOrigin` and
 * every `roost://` response allows it (`assets.ts`). Without both, Chromium taints
 * the canvas and `toBlob` throws, which is how a missing header would surface.
 *
 * `undefined` when there is nothing to draw: no frame decoded yet, or a video
 * whose dimensions the element does not know.
 */
export function framePng(video: HTMLVideoElement): Promise<Blob> | undefined {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width === 0 || height === 0) return undefined;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) return undefined;
  context.drawImage(video, 0, 0, width, height);

  return new Promise((resolve, reject) => {
    canvas.toBlob((png) => {
      if (png === null) reject(new Error("the frame could not be encoded"));
      else resolve(png);
    }, "image/png");
  });
}
