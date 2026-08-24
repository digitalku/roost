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
  "svg",
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
  svg: "image/svg+xml",
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
  svg: "svg",
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
    return "tiff";
  }
  if (at(bytes, 0, "%PDF-")) return "pdf";
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
    return at(bytes, 8, "avif") || at(bytes, 8, "avis") ? "avif" : "mp4";
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
