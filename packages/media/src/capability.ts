import { decoderVersions } from "./decoder.js";
import { documentVersion } from "./document.js";
import { ffmpegDecoders, ffmpegVersion, ffprobeVersion } from "./ffmpeg.js";
import type { Format } from "./format.js";
import { heifVersion } from "./heif.js";
import { carriesTools, installCommand, installOffer } from "./install.js";
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

export const CAPABILITIES = ["images", "vectors", "documents", "media", "heif"] as const;

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
  /**
   * The command that would install it, on this machine, or `null` when it is
   * already here (ADR-0040 §5).
   *
   * Separate from `detail` because the two are read in different places and at
   * different lengths: the status bar has room for a sentence, and a shell
   * command belongs where it can be copied rather than where it can be
   * truncated.
   */
  readonly install: string | null;
  /**
   * Whether Roost may run that command itself (ADR-0042).
   *
   * Not derivable from `install`: on Linux there is a command and Roost may not
   * run it, because every line begins with `sudo`. The two questions are two
   * fields for that reason, and the window is told only this boolean — never
   * anything it could turn into a command.
   */
  readonly installable: boolean;
  /**
   * Whether this build carries the backend itself, so that nothing installed on
   * the machine changes the answer.
   *
   * Always for the three in WebAssembly or in-process. For ffmpeg and libheif,
   * only inside a Flatpak (ADR-0063 §7), where a missing one is a fault in the
   * build, and `install` is `null` because no command reaches the sandbox.
   */
  readonly bundled: boolean;
  /** The formats this backend is responsible for. */
  readonly formats: readonly Format[];
}

/** Which backend owns which format. The one table `derive` dispatches through. */
export const CAPABILITY_FORMATS: Readonly<Record<CapabilityName, readonly Format[]>> = {
  images: ["jpeg", "png", "webp", "gif", "tiff", "avif", "raw"],
  vectors: ["svg", "ttf", "otf", "woff", "woff2"],
  documents: ["pdf"],
  media: ["mp4", "mkv", "webm", "ogg", "flac", "mp3", "wav"],
  // `heic` is the whole of it, and it is deliberately not in `images`: sharp
  // reads the container and cannot decode what is inside it (ADR-0040 §2).
  heif: ["heic"],
};

/** The backend responsible for a format, or `undefined` if nothing draws it. */
export function capabilityFor(format: Format): CapabilityName | undefined {
  for (const name of CAPABILITIES) {
    if (CAPABILITY_FORMATS[name].includes(format)) return name;
  }
  return undefined;
}

/**
 * The codecs a phone, a camera or a streaming download is made of.
 *
 * An ffmpeg lacking any of them is one worth replacing, so its capability
 * carries a command even though it runs. The list decides nothing about which
 * files park — every file is checked against whatever this ffmpeg decodes — and
 * is only what makes the machine worth mentioning before a file has been met.
 */
export const EXPECTED_DECODERS = ["h264", "hevc", "av1", "vp9", "aac", "ac3", "eac3"] as const;

interface Probed {
  readonly capabilities: readonly Capability[];
  /** What ffmpeg decodes, or `null` where it is absent or would not say. */
  readonly decoders: ReadonlySet<string> | null;
}

let probed: Promise<Probed> | undefined;

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
  return (await probed).capabilities;
}

/** Discards the cache and probes again. */
export async function refreshCapabilities(): Promise<readonly Capability[]> {
  probed = probe();
  return (await probed).capabilities;
}

/**
 * The codecs this machine's ffmpeg decodes, probed with the capabilities and
 * refreshed with them.
 *
 * `null` means unknown rather than none: an ffmpeg that runs and would not list
 * its decoders is left to try every file, because parking a whole library on a
 * listing that failed would be worse than the failures it prevents.
 */
export async function mediaDecoders(): Promise<ReadonlySet<string> | null> {
  probed ??= probe();
  return (await probed).decoders;
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

async function probe(): Promise<Probed> {
  const [ffmpeg, ffprobe, heif, listed] = await Promise.all([
    ffmpegVersion(),
    ffprobeVersion(),
    heifVersion(),
    ffmpegDecoders(),
  ]);
  const decoder = decoderVersions();
  const hasMedia = ffmpeg !== null && ffprobe !== null;
  const decoders = hasMedia ? listed : null;
  const lacking =
    decoders === null ? [] : EXPECTED_DECODERS.filter((codec) => !decoders.has(codec));
  const carried = carriesTools();

  const capabilities: readonly Capability[] = [
    {
      name: "images",
      available: true,
      version: `libvips ${decoder.libvips}`,
      detail: `sharp ${decoder.sharp}, ${decoder.build} build`,
      install: null,
      installable: false,
      bundled: true,
      formats: CAPABILITY_FORMATS.images,
    },
    {
      name: "vectors",
      available: true,
      version: vectorVersion(),
      detail: "resvg in WebAssembly, with no filesystem access",
      install: null,
      installable: false,
      bundled: true,
      formats: CAPABILITY_FORMATS.vectors,
    },
    {
      name: "documents",
      available: true,
      version: documentVersion(),
      detail: "pdfium in WebAssembly, with no filesystem access",
      install: null,
      installable: false,
      bundled: true,
      formats: CAPABILITY_FORMATS.documents,
    },
    {
      name: "media",
      // Both, not either: the metadata comes from one and the frame from the
      // other, and half of the pair is not a working backend.
      available: hasMedia,
      version: ffmpeg,
      detail: !hasMedia
        ? carried
          ? "this build of Roost carries no working ffmpeg"
          : "install ffmpeg for video and audio previews"
        : lacking.length > 0
          ? `ffmpeg ${ffmpeg}, ffprobe ${ffprobe}, without ${lacking.join(", ")}`
          : `ffmpeg ${ffmpeg}, ffprobe ${ffprobe}`,
      // A command while it is still available, where it lacks what a phone
      // records: replacing it is the one thing that draws those files, and the
      // window shows this beside them (ADR-0017, amended 2026-09-24).
      install: carried
        ? null
        : !hasMedia
          ? installCommand("media")
          : lacking.length > 0
            ? installCommand("decoders")
            : null,
      installable: !carried && !hasMedia && installOffer("media").argv !== null,
      bundled: carried,
      formats: CAPABILITY_FORMATS.media,
    },
    {
      name: "heif",
      // A version alone is not the question: `heif-dec` runs on a Fedora that
      // has no HEVC decoder for it at all, and answers every photograph with a
      // refusal. `heifVersion` reports one only when a decoder is listed too.
      available: heif !== null,
      version: heif,
      detail:
        heif !== null
          ? `libheif ${heif}`
          : carried
            ? "this build of Roost carries no working libheif"
            : "install libheif for HEIC photographs",
      install: heif !== null || carried ? null : installCommand("heif"),
      installable: !carried && heif === null && installOffer("heif").argv !== null,
      bundled: carried,
      formats: CAPABILITY_FORMATS.heif,
    },
  ];
  return { capabilities, decoders };
}
