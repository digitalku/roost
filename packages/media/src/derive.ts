import type { DerivedMetadata } from "@roost/core";
import { capability, capabilityFor } from "./capability.js";
import { readDimensions, renderThumbnails, type Thumbnail } from "./decoder.js";
import { PAGE_RENDER_WIDTH, renderPage } from "./document.js";
import {
  grabFrame,
  probeMedia,
  WAVEFORM_BUCKETS,
  WAVEFORM_HEIGHT,
  waveformPeaks,
} from "./ffmpeg.js";
import { readFont, renderSpecimen } from "./font.js";
import type { Format } from "./format.js";
import { decodeHeif } from "./heif.js";
import { sniffFile } from "./probe.js";
import { looksLikeRaw, type RawFacts, readRaw } from "./raw.js";
import { EAGER_SIZES } from "./serving.js";
import { rasteriseSvgFile, VECTOR_RENDER_WIDTH } from "./vector.js";
import { drawWaveform } from "./waveform.js";

/**
 * One asset's derived data: its thumbnails and what its bytes say about
 * themselves.
 *
 * The pipeline's last stage (`ARCHITECTURE.md` §5) and the only thing the job
 * runner calls. Which backend does the work is decided here, from the bytes,
 * and every backend hands back the same two things — so adding a format is a
 * case in one `switch` rather than a change in the runner, the CLI, and the
 * app.
 */

/** What a derive produced. */
export interface Derived {
  readonly thumbnails: readonly Thumbnail[];
  readonly metadata: DerivedMetadata;
}

/**
 * A derive either produced something or explained why it could not.
 *
 * `blocked` is not a failure and is not thrown: a format nothing in this build
 * draws, or a backend this machine does not have, is an expected outcome that
 * the queue parks rather than retries (`DATA_MODEL.md` §2.5). A backend that
 * was present and went wrong throws instead, and the runner records that as a
 * failure worth retrying.
 */
export type DeriveOutcome =
  | ({ readonly ok: true } & Derived)
  | { readonly ok: false; readonly reason: string };

/**
 * Derives everything Roost knows how to derive from one file.
 *
 * The format is decided from the bytes, never from the extension: a file named
 * `.jpg` that is really a PNG is ordinary in a downloads folder, and a
 * dispatcher that trusted the name would hand it to the wrong backend.
 */
export async function derive(
  path: string,
  sizes: readonly number[] = EAGER_SIZES,
  posterMs?: number,
): Promise<DeriveOutcome> {
  const format = await sniffFile(path);
  const backend = capabilityFor(format);

  if (backend === undefined) return { ok: false, reason: `unsupported:${format}` };

  if (backend === "media") {
    const media = await capability("media");
    if (!media.available) return { ok: false, reason: "missing:ffmpeg" };
    return deriveMedia(path, format, sizes, posterMs);
  }

  if (backend === "heif") {
    const libheif = await capability("heif");
    // Parked, not failed: the file is fine and this machine is missing a
    // decoder it cannot lawfully be shipped (ADR-0040). The reason names the
    // capability so that installing libheif and pressing Try again releases
    // exactly these jobs and nothing else.
    if (!libheif.available) return { ok: false, reason: "missing:libheif" };
    return { ok: true, ...(await deriveHeif(path, sizes)) };
  }

  if (backend === "documents") return { ok: true, ...(await deriveDocument(path, sizes)) };
  if (backend === "vectors") return deriveVector(path, format, sizes);

  // A RAW is a TIFF container, and a NEF or an ARW is indistinguishable from a
  // scanned TIFF in the 64 bytes sniffing reads. Both formats therefore come
  // through here, and what tells them apart is whether the file carries an
  // embedded JPEG — which is also the only thing either of them is drawn from.
  if (format === "raw" || format === "tiff") {
    const facts = await readRaw(path);
    if (facts !== undefined && looksLikeRaw(facts)) return deriveRawPhoto(facts, sizes);
    // A `raw` that carries no readable preview is a container this build does
    // not open: Canon's CR3 and Fuji's RAF are not TIFF at all. Parked rather
    // than failed, because that is a missing capability and not a broken file.
    if (format === "raw") return { ok: false, reason: "unsupported:raw" };
  }

  return { ok: true, ...(await deriveImage(path, sizes)) };
}

/**
 * A RAW photograph, drawn from the JPEG the camera embedded.
 *
 * The recorded dimensions are the **photograph's**, taken from the largest
 * uncompressed image in the container — the sensor data — and not the preview's.
 * A 24-megapixel RAW whose preview is 1616×1080 is a 24-megapixel photograph,
 * and an inspector that said otherwise would be describing a thumbnail.
 */
async function deriveRawPhoto(facts: RawFacts, sizes: readonly number[]): Promise<DeriveOutcome> {
  const preview = facts.preview;
  if (preview === undefined) return { ok: false, reason: "unsupported:raw" };

  const width = facts.width ?? preview.width;
  const height = facts.height ?? preview.height;

  return {
    ok: true,
    thumbnails: await renderThumbnails({ bytes: preview.bytes }, sizes),
    metadata: {
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    },
  };
}

/**
 * A HEIC photograph, through libheif and then through sharp.
 *
 * Two stages because they answer different questions: libheif assembles the
 * tiles, applies the stored rotation and hands back one ordinary picture, and
 * sharp does what it does for every other photograph. The dimensions therefore
 * come from the **assembled** image rather than from the container — a 3024×4032
 * shot is stored as forty-eight 512×512 tiles, and neither number is the
 * photograph's.
 */
async function deriveHeif(path: string, sizes: readonly number[]): Promise<Derived> {
  const bytes = await decodeHeif(path);
  const [thumbnails, dimensions] = await Promise.all([
    renderThumbnails({ bytes }, sizes),
    readDimensions({ bytes }),
  ]);
  return { thumbnails, metadata: dimensions ?? {} };
}

async function deriveImage(path: string, sizes: readonly number[]): Promise<Derived> {
  const [thumbnails, dimensions] = await Promise.all([
    renderThumbnails({ path }, sizes),
    readDimensions(path),
  ]);
  return { thumbnails, metadata: dimensions ?? {} };
}

/**
 * A PDF's first page, and its page count.
 *
 * The stored dimensions are the **page's own size in points**, not the size the
 * thumbnail happened to be rendered at: a grid cell reserves its shape from
 * them, and the render width is an implementation detail that could change
 * without every A4 document changing shape.
 */
async function deriveDocument(path: string, sizes: readonly number[]): Promise<Derived> {
  const page = await renderPage(path, 0, PAGE_RENDER_WIDTH);
  const thumbnails = await renderThumbnails(
    { pixels: page.pixels, width: page.width, height: page.height },
    sizes,
  );

  return {
    thumbnails,
    metadata: { width: page.pageWidth, height: page.pageHeight, pageCount: page.pages },
  };
}

async function deriveVector(
  path: string,
  format: Format,
  sizes: readonly number[],
): Promise<DeriveOutcome> {
  if (format === "svg") {
    const raster = await rasteriseSvgFile(path, VECTOR_RENDER_WIDTH);
    return {
      ok: true,
      thumbnails: await renderThumbnails({ bytes: raster.png }, sizes),
      // The drawing's own size, not the size it happened to be rasterised at.
      // A 120×60 logo is 120×60 in the inspector, and the grid gets the same
      // ratio either way.
      metadata: { width: raster.intrinsicWidth, height: raster.intrinsicHeight },
    };
  }

  const facts = await readFont(path);
  const props: Record<string, string> = {
    "font.family": facts.family,
    "font.style": facts.style,
    "font.glyphs": String(facts.glyphs),
  };

  const specimen = await renderSpecimen(path, VECTOR_RENDER_WIDTH);
  // A font that lays out none of the specimen string — an icon font, a subset —
  // still gains its names. Blocking would throw those away with the picture.
  if (specimen === undefined) {
    return { ok: true, thumbnails: [], metadata: { props } };
  }

  // The **specimen sheet's** size, which is not a fact about the typeface and is
  // recorded anyway: the grid lays a cell out from `assets.width`/`height`, and
  // a font without them gets a square cell that crops a sheet five times wider
  // than it is tall. Seen in a real window, not reasoned about. The inspector
  // leaves the row out for a font, where "512 × 85" would mean nothing.
  return {
    ok: true,
    thumbnails: await renderThumbnails({ bytes: specimen.png }, sizes),
    metadata: { width: specimen.width, height: specimen.height, props },
  };
}

/**
 * Video and audio.
 *
 * Two process spawns each and roughly a quarter of a second (ADR-0017), which
 * is why this runs behind the queue and never inside import. The probe comes
 * first because the thumbnail depends on it: a frame is taken a tenth of the
 * way in, and that needs a duration.
 *
 * `posterMs` is a moment somebody pinned the thumbnail to (ADR-0024 stage 4),
 * and it replaces that guess. It reaches here from `assets.poster_ms`, which a
 * rebuild replays from the journal — the frame is re-extracted rather than
 * stored, so a poster survives a rebuild the way every derived artefact does.
 */
async function deriveMedia(
  path: string,
  format: Format,
  sizes: readonly number[],
  posterMs?: number,
): Promise<DeriveOutcome> {
  const probe = await probeMedia(path);
  const metadata: DerivedMetadata = {
    ...(probe.durationMs === undefined ? {} : { durationMs: probe.durationMs }),
    ...(probe.width === undefined ? {} : { width: probe.width }),
    ...(probe.height === undefined ? {} : { height: probe.height }),
    ...(Object.keys(probe.props).length === 0 ? {} : { props: probe.props }),
  };

  // A video stream is what decides which picture to make, not the container: an
  // `.mp4` holding only audio is ordinary, and grabbing a frame from it would
  // fail rather than produce the waveform it deserves.
  const hasVideo = probe.width !== undefined && probe.height !== undefined;

  if (hasVideo) {
    const frame = await grabFrame(path, probe.durationMs, posterMs);
    return { ok: true, thumbnails: await renderThumbnails({ bytes: frame }, sizes), metadata };
  }

  if (probe.props["audio.codec"] === undefined) {
    return { ok: false, reason: `unsupported:${format}` };
  }

  const peaks = await waveformPeaks(path, WAVEFORM_BUCKETS, probe.durationMs);
  const drawn = drawWaveform(peaks, WAVEFORM_HEIGHT);
  return {
    ok: true,
    thumbnails: await renderThumbnails(
      { pixels: drawn.pixels, width: drawn.width, height: drawn.height },
      sizes,
    ),
    metadata,
  };
}
