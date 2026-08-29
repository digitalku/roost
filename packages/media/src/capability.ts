import { decoderVersions } from "./decoder.js";
import { documentVersion } from "./document.js";
import { ffmpegVersion, ffprobeVersion } from "./ffmpeg.js";
import type { Format } from "./format.js";
import { vectorVersion } from "./vector.js";

/**
 * What this machine can draw, and what it cannot.
 *
 * Three of the four backends ship with Roost and are always present; the fourth
 * is the system's ffmpeg, which may not be (ADR-0017). The shape is the same for
 * all four so that `roost doctor`, the CLI, and the UI have one thing to read
 * rather than a special case for the optional one — and so that a fifth backend
 * arriving later changes nothing but this table.
 */

export const CAPABILITIES = ["images", "vectors", "documents", "media"] as const;

export type CapabilityName = (typeof CAPABILITIES)[number];

export function isCapabilityName(value: string): value is CapabilityName {
  return (CAPABILITIES as readonly string[]).includes(value);
}

export interface Capability {
  readonly name: CapabilityName;
  /** Whether the backend can be used right now, on this machine. */
  readonly available: boolean;
  /** What loaded, or `null` when nothing did. */
  readonly version: string | null;
  /**
   * One line for a person: which build is loaded, or what to install. Shown by
   * `roost doctor` and by the UI when something is missing.
   */
  readonly detail: string;
  /** The formats this backend is responsible for. */
  readonly formats: readonly Format[];
}

/** Which backend owns which format. The one table `derive` dispatches through. */
export const CAPABILITY_FORMATS: Readonly<Record<CapabilityName, readonly Format[]>> = {
  images: ["jpeg", "png", "webp", "gif", "tiff", "avif"],
  vectors: ["svg", "ttf", "otf", "woff", "woff2"],
  documents: ["pdf"],
  media: ["mp4", "mkv", "webm", "ogg", "flac", "mp3", "wav"],
};

/** The backend responsible for a format, or `undefined` if nothing draws it. */
export function capabilityFor(format: Format): CapabilityName | undefined {
  for (const name of CAPABILITIES) {
    if (CAPABILITY_FORMATS[name].includes(format)) return name;
  }
  return undefined;
}

let probed: Promise<readonly Capability[]> | undefined;

/**
 * What this build can do, probed once per process.
 *
 * Cached because the expensive member is the optional one: locating ffmpeg
 * means starting it, and asking on every asset would double the cost of every
 * video. {@link refreshCapabilities} exists for the case that makes a cache
 * wrong — someone installing ffmpeg while the app is open — and it is the UI's
 * "try again", not a timer.
 */
export async function capabilities(): Promise<readonly Capability[]> {
  probed ??= probe();
  return probed;
}

/** Discards the cache and probes again. */
export async function refreshCapabilities(): Promise<readonly Capability[]> {
  probed = probe();
  return probed;
}

/** One capability by name, for a caller that only cares about one. */
export async function capability(name: CapabilityName): Promise<Capability> {
  const all = await capabilities();
  const found = all.find((entry) => entry.name === name);
  // Unreachable through the union, and cheaper to assert than to make every
  // caller handle an impossible `undefined`.
  if (found === undefined) throw new Error(`no such capability: ${name}`);
  return found;
}

async function probe(): Promise<readonly Capability[]> {
  const [ffmpeg, ffprobe] = await Promise.all([ffmpegVersion(), ffprobeVersion()]);
  const decoder = decoderVersions();

  return [
    {
      name: "images",
      available: true,
      version: `libvips ${decoder.libvips}`,
      detail: `sharp ${decoder.sharp}, ${decoder.build} build`,
      formats: CAPABILITY_FORMATS.images,
    },
    {
      name: "vectors",
      available: true,
      version: vectorVersion(),
      detail: "resvg in WebAssembly, with no filesystem access",
      formats: CAPABILITY_FORMATS.vectors,
    },
    {
      name: "documents",
      available: true,
      version: documentVersion(),
      detail: "pdfium in WebAssembly, with no filesystem access",
      formats: CAPABILITY_FORMATS.documents,
    },
    {
      name: "media",
      // Both, not either: the metadata comes from one and the frame from the
      // other, and half of the pair is not a working backend.
      available: ffmpeg !== null && ffprobe !== null,
      version: ffmpeg,
      detail:
        ffmpeg !== null && ffprobe !== null
          ? `ffmpeg ${ffmpeg}, ffprobe ${ffprobe}`
          : "install ffmpeg for video and audio previews",
      formats: CAPABILITY_FORMATS.media,
    },
  ];
}
