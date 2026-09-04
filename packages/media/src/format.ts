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
  "raw",
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
  "text",
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
  text: "text",
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
  // Deliberately not an `image/*` type: no browser draws a sensor mosaic, and
  // claiming one would make the preview pane try. What a RAW *shows* is the
  // JPEG the camera embedded, which reaches the window as a thumbnail.
  raw: "application/octet-stream",
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
  // No `charset`, deliberately. What a text file is encoded in is a question
  // the reader answers after looking at the bytes (ADR-0026 §Stages), and
  // asserting UTF-8 here would make a Windows-1252 subtitle render as mojibake
  // that looks like the file's own fault.
  text: "text/plain",
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
  cr2: "raw",
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
  // Text has no signature, so the extension carries more weight here than it
  // does anywhere else in this table. The list is an allowlist on purpose: a
  // format that is text underneath but has its own reader — SVG — is not on it.
  txt: "text",
  text: "text",
  md: "text",
  markdown: "text",
  srt: "text",
  vtt: "text",
  ass: "text",
  ssa: "text",
  log: "text",
  csv: "text",
  tsv: "text",
  json: "text",
  yaml: "text",
  yml: "text",
  toml: "text",
  ini: "text",
  cfg: "text",
  conf: "text",
  xml: "text",
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

  // Text is decided by what the bytes are *not*, so it goes after every
  // signature above — including SVG, which is text with a reader of its own.
  if (looksLikeText(bytes)) return "text";

  return "unknown";
}

/**
 * Whether a leading window reads as text.
 *
 * There is no magic number for text, so this is a negative test: no NUL, no
 * stray C0 control, no DEL. Everything from 0x20 up is allowed, which passes
 * UTF-8 and a legacy single-byte encoding alike — deliberately, because most
 * subtitles in the wild are Windows-1252 rather than UTF-8. Deciding *which*
 * encoding is the reader's problem (ADR-0026 §Stages), not the sniffer's, and
 * a validity test here would reject exactly the files this exists to accept.
 *
 * **It can be fooled, and the cost of being fooled is small.** A headerless
 * binary whose first 64 bytes happen to be printable will preview as text
 * instead of offering "Open externally". Every binary format Roost knows is
 * claimed by a signature before this is reached.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  // An empty file is not text; it is nothing. Calling it text would give the
  // preview an editor over no bytes and a name with no content behind it.
  if (bytes.length === 0) return false;

  // UTF-16 is full of NULs, so it has to be recognised before the scan below
  // rejects it. Only with a BOM: headerless UTF-16 is indistinguishable from
  // binary at this width.
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return true;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return true;

  for (const byte of bytes) {
    if (byte === 0x00) return false;
    // Tab, line feed, form feed and carriage return are the only C0 controls a
    // text file has any business carrying.
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) {
      return false;
    }
    if (byte === 0x7f) return false;
  }

  return true;
}
