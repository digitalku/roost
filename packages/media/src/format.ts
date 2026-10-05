import type { Kind } from "@roost/core";

/**
 * Formats Roost recognises.
 *
 * Recognising a format is not the same as being able to draw it — see
 * {@link isRenderable} — and it is not the same as the extension an asset is
 * stored under either. `jpg` and `jpeg` are one format here and one media type
 * on the wire.
 */
export const FORMATS = [
  "jpeg",
  "png",
  "webp",
  "gif",
  "bmp",
  "tiff",
  "avif",
  "heic",
  "raw",
  "svg",
  "xcf",
  "pdf",
  "mp4",
  "mkv",
  "webm",
  "ogg",
  "flac",
  "mp3",
  "wav",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "zip",
  "unknown",
] as const;

export type Format = (typeof FORMATS)[number];

export function isFormat(value: string): value is Format {
  return (FORMATS as readonly string[]).includes(value);
}

const KIND_OF: Readonly<Record<Format, Kind>> = {
  jpeg: "image",
  png: "image",
  webp: "image",
  gif: "image",
  bmp: "image",
  tiff: "image",
  avif: "image",
  heic: "image",
  raw: "image",
  svg: "image",
  mp4: "video",
  mkv: "video",
  webm: "video",
  ogg: "audio",
  flac: "audio",
  mp3: "audio",
  wav: "audio",
  pdf: "document",
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  zip: "other",
  // GIMP's own file, layers and all. **Named, and `other` on purpose**: an
  // `.xcf` is a working file that belongs to GIMP, so a double-click hands it
  // there as it does a `.zip`, and the preview pane never tries to draw it. The
  // user's call on 2026-09-24, after a build that called it `image` opened it
  // into a pane with nothing to show. Named at all so that it stops being "a
  // kind of file Roost does not recognise".
  xcf: "other",
  unknown: "other",
};

/**
 * What an asset broadly is.
 *
 * `other` is not a failure: a format Roost cannot draw still imports, still
 * carries tags, and still opens in the application that owns it.
 */
export function kindOf(format: Format): Kind {
  return KIND_OF[format];
}

const MEDIA_TYPE_OF: Readonly<Record<Format, string>> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  avif: "image/avif",
  // Honest about what it is, and no browser draws it — which is the point: the
  // window shows the thumbnail Roost derived rather than trying the original,
  // exactly as it does for a RAW.
  heic: "image/heic",
  // Deliberately not an `image/*` type: no browser draws a sensor mosaic, and
  // claiming one would make the preview pane try. What a RAW *shows* is the
  // JPEG the camera embedded, which reaches the window as a thumbnail.
  raw: "application/octet-stream",
  svg: "image/svg+xml",
  // The type GIMP and shared-mime-info register.
  xcf: "image/x-xcf",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  zip: "application/zip",
  // A guess would make a webview try to render bytes it cannot read; this makes
  // it offer to save the file instead.
  unknown: "application/octet-stream",
};

/** The media type the `roost://` handler serves this format as (ADR-0008). */
export function mediaTypeOf(format: Format): string {
  return MEDIA_TYPE_OF[format];
}

const FORMAT_OF_EXTENSION: Readonly<Record<string, Format>> = {
  jpg: "jpeg",
  jpeg: "jpeg",
  png: "png",
  webp: "webp",
  gif: "gif",
  bmp: "bmp",
  tif: "tiff",
  tiff: "tiff",
  avif: "avif",
  heic: "heic",
  heif: "heic",
  // Canon's spelling of the same container, from the R-series bodies.
  hif: "heic",
  cr3: "raw",
  nef: "raw",
  arw: "raw",
  dng: "raw",
  orf: "raw",
  rw2: "raw",
  raf: "raw",
  pef: "raw",
  srw: "raw",
  svg: "svg",
  xcf: "xcf",
  pdf: "pdf",
  mp4: "mp4",
  m4v: "mp4",
  mkv: "mkv",
  webm: "webm",
  ogg: "ogg",
  oga: "ogg",
  flac: "flac",
  mp3: "mp3",
  wav: "wav",
  ttf: "ttf",
  otf: "otf",
  woff: "woff",
  woff2: "woff2",
  zip: "zip",
};

/**
 * The format an extension names, or `unknown`.
 *
 * Sniffing the bytes is what decides a format at import. This is for the path
 * where the bytes are already in the object store under an extension the
 * importer chose, and re-reading a header to name a media type would be a read
 * for nothing.
 */
export function formatFromExtension(ext: string): Format {
  return FORMAT_OF_EXTENSION[ext.toLowerCase()] ?? "unknown";
}

/**
 * Every extension that names this format, lower case: `jpg` and `jpeg` both.
 *
 * For a question asked of the index, which holds extensions and not formats —
 * which parked assets a build that now knows the format should look at again.
 */
export function extensionsNaming(format: Format): string[] {
  return Object.entries(FORMAT_OF_EXTENSION)
    .filter(([, named]) => named === format)
    .map(([ext]) => ext);
}

/**
 * Every extension that names a format of this kind, lower case.
 *
 * For a dialog's filter, which speaks in extensions: *Set thumbnail from
 * file…* offers images (ADR-0060).
 */
export function extensionsOfKind(kind: Kind): string[] {
  return Object.entries(FORMAT_OF_EXTENSION)
    .filter(([, format]) => kindOf(format) === kind)
    .map(([ext]) => ext);
}

/**
 * The extension a file of this format is conventionally called by.
 *
 * The inverse of {@link formatFromExtension} where one exists, choosing the
 * common spelling of each pair: `jpg` over `jpeg`, `tif` losing to `tiff`.
 * `unknown` has no answer and `raw` has no single one — a RAW is Canon's or
 * Nikon's before it is anything — so both return `undefined`.
 */
export function extensionOf(format: Format): string | undefined {
  return EXTENSION_OF[format];
}

const EXTENSION_OF: Readonly<Partial<Record<Format, string>>> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  gif: "gif",
  bmp: "bmp",
  tiff: "tiff",
  avif: "avif",
  heic: "heic",
  svg: "svg",
  xcf: "xcf",
  pdf: "pdf",
  mp4: "mp4",
  mkv: "mkv",
  webm: "webm",
  ogg: "ogg",
  flac: "flac",
  mp3: "mp3",
  wav: "wav",
  ttf: "ttf",
  otf: "otf",
  woff: "woff",
  woff2: "woff2",
};

/**
 * Whether sniffing this format is grounds for renaming the file (RL-9b).
 *
 * Three answers mean **no information**, and the last two are the whole reason
 * this is a function rather than a comparison at the call site.
 *
 * `unknown` is not evidence: a format this build cannot name says nothing about
 * whether the extension is wrong, and a `.txt` sniffs as `unknown` for ever.
 *
 * **`zip` and `tiff` are containers other formats wear.** `.docx`, `.xlsx`,
 * `.pptx`, `.epub` and `.jar` are ZIP files; `.nef`, `.arw`, `.dng`, `.orf`,
 * `.pef` and `.srw` are TIFF files, and {@link sniff} says so in as many words
 * — their vendor tags live past the 64 bytes a header read can see, so they
 * come back as `tiff` and `raw.ts` sorts them out later. A rule of *"rename
 * when the sniffed format is not what the extension says"* therefore renames
 * every Word document to `.zip` and every Nikon photograph to `.tiff`.
 *
 * The cost of excluding them is that a file genuinely saved as a TIFF over a
 * `.png` keeps a wrong extension, which is cosmetic. The cost of not excluding
 * them is somebody's RAW library renamed, which is not.
 */
export function namesTheFile(format: Format): boolean {
  return format !== "unknown" && format !== "zip" && format !== "tiff";
}

/**
 * Formats a browser draws from the original bytes.
 *
 * Chromium's list, not a wish: it decodes JPEG, PNG, GIF, WebP, AVIF, BMP and
 * SVG, and nothing else Roost recognises. **HEIC, RAW and TIFF are the three
 * that reach the preview pane and cannot be shown there** — HEVC has no browser
 * decoder, a sensor mosaic is not a picture, and browsers dropped TIFF decades
 * ago — so they are rendered first (ADR-0040 §7).
 *
 * A table rather than a media-type test, because `mediaTypeOf` answers a
 * different question: what the bytes *are*, which for a RAW is deliberately not
 * an `image/*` type at all.
 */
const BROWSER_DRAWS: readonly Format[] = ["jpeg", "png", "gif", "webp", "avif", "bmp", "svg"];

/** Whether an `<img>` can show this format's own bytes. */
export function isBrowserDrawable(format: Format): boolean {
  return BROWSER_DRAWS.includes(format);
}

/**
 * Major brands that mean HEIF.
 *
 * `heic`/`heix` are HEVC stills, `hevc`/`hevx` sequences, `heim`/`heis`/
 * `hevm`/`hevs` the multiview and scalable variants an iPhone writes beside a
 * Live Photo, and `mif1`/`msf1` the generic image and sequence brands.
 */
const HEIF_BRANDS = [
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
] as const;

/**
 * Bytes read for magic-number detection.
 *
 * Enough for every signature below, including the RIFF and ISO-BMFF forms that
 * carry their brand at offset 8, and enough of a text file's start for the SVG
 * root element to appear past an XML declaration.
 */
export const SNIFF_BYTES = 64;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

function at(bytes: Uint8Array, offset: number, text: string): boolean {
  const wanted = ascii(text);
  if (bytes.length < offset + wanted.length) return false;
  return wanted.every((byte, index) => bytes[offset + index] === byte);
}

function contains(bytes: Uint8Array, text: string): boolean {
  const wanted = ascii(text);
  for (let start = 0; start + wanted.length <= bytes.length; start += 1) {
    if (wanted.every((byte, index) => bytes[start + index] === byte)) return true;
  }
  return false;
}

/**
 * Identifies a format from its leading bytes.
 *
 * **The extension is a hint, never the answer.** A file named `.jpg` that is
 * really a PNG is ordinary in a downloads folder, and trusting the name would
 * produce a wrong thumbnail, wrong dimensions, and a wrong media type on the
 * wire.
 */
export function sniff(bytes: Uint8Array): Format {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (at(bytes, 0, "GIF87a") || at(bytes, 0, "GIF89a")) return "gif";
  if (at(bytes, 0, "RIFF") && at(bytes, 8, "WEBP")) return "webp";
  if (at(bytes, 0, "RIFF") && at(bytes, 8, "WAVE")) return "wav";
  if (at(bytes, 0, "BM")) return "bmp";
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    // A CR2 is a TIFF that says so at offset 8. A NEF, an ARW, and a DNG do
    // not: they are TIFF containers whose vendor tags live in the directories,
    // which is past the sniffed window. They therefore sniff as `tiff` here and
    // are recognised by the reader that walks those directories (`raw.ts`) —
    // sniffing is a header question and this one is not answerable from 64
    // bytes.
    return at(bytes, 8, "CR") ? "raw" : "tiff";
  }
  // Two RAW formats that are TIFF-shaped with a vendor magic in place of 42.
  if (startsWith(bytes, [0x49, 0x49, 0x52, 0x4f]) || startsWith(bytes, [0x49, 0x49, 0x55, 0x00])) {
    return "raw";
  }
  if (at(bytes, 0, "FUJIFILMCCD-RAW")) return "raw";
  if (at(bytes, 0, "%PDF-")) return "pdf";
  // GIMP's header names itself and then its version: `gimp xcf file` for the
  // oldest, `gimp xcf v019` for GIMP 3.
  if (at(bytes, 0, "gimp xcf ")) return "xcf";
  if (at(bytes, 0, "OggS")) return "ogg";
  if (at(bytes, 0, "fLaC")) return "flac";
  if (at(bytes, 0, "ID3") || startsWith(bytes, [0xff, 0xfb]) || startsWith(bytes, [0xff, 0xf3])) {
    return "mp3";
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    // EBML covers both. The DocType distinguishes them, and a WebM file names
    // itself early enough to catch inside the sniffed window.
    return contains(bytes, "webm") ? "webm" : "mkv";
  }
  // ISO base media: a four-byte size, then "ftyp", then the brand.
  if (at(bytes, 4, "ftyp")) {
    if (at(bytes, 8, "avif") || at(bytes, 8, "avis")) return "avif";
    // HEIF, in the brands a camera actually writes. `mif1` and `msf1` are the
    // generic ones and AVIF carries them too — as a *compatible* brand beside
    // its own — so the AVIF test above runs first and this one looks through
    // the compatible brands before claiming a generic file.
    if (HEIF_BRANDS.some((brand) => at(bytes, 8, brand))) {
      return contains(bytes, "avif") ? "avif" : "heic";
    }
    // Canon's CR3 is an ISO base media file, not a TIFF. It is recognised so
    // that it does not reach ffmpeg as a video, which is what its container
    // otherwise makes it look like.
    if (at(bytes, 8, "crx ")) return "raw";
    return "mp4";
  }
  if (startsWith(bytes, [0x00, 0x01, 0x00, 0x00]) || at(bytes, 0, "true")) return "ttf";
  if (at(bytes, 0, "OTTO")) return "otf";
  if (at(bytes, 0, "wOFF")) return "woff";
  if (at(bytes, 0, "wOF2")) return "woff2";
  if (startsWith(bytes, [...ascii("PK"), 0x03, 0x04])) return "zip";
  // SVG is text and has no fixed signature, so the root element is the marker.
  // Last, so that a binary format whose header happens to contain "<svg" is
  // already claimed by its own signature.
  if (contains(bytes, "<svg")) return "svg";

  return "unknown";
}
