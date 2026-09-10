import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "./external.js";

/**
 * HEIC photographs, through the system's libheif (ADR-0040).
 *
 * An iPhone photograph is not one picture in the file: it is a **grid of
 * tiles** — forty-eight of them for a 3024×4032 shot — plus a small preview,
 * an orientation, and an EXIF block, all addressed by an item table. Putting
 * that back together is libheif's job and nothing else here can do it: ffmpeg's
 * `mov` demuxer sees the same file as forty-eight separate 512×512 video
 * streams and stitches none of them, and sharp's bundled libvips carries no
 * HEVC decoder at all (ADR-0040 §2 has the measurements).
 *
 * Like ffmpeg (ADR-0017) this is the **system's** tool and never a hard
 * dependency: HEVC is patent-encumbered, so the decoder cannot be shipped
 * inside a proprietary binary, and a machine without one imports its HEIC
 * files exactly as before and gains the pictures the day libheif arrives.
 */

/**
 * The tool, in both the names it has had.
 *
 * libheif 1.19 renamed `heif-convert` to `heif-dec`; distributions carry one or
 * the other and some carry both. Overridable for a build outside the PATH, the
 * same escape hatch `ROOST_FFMPEG` is.
 */
const OVERRIDE = process.env["ROOST_HEIF_DEC"];
const TOOL_NAMES = OVERRIDE === undefined ? ["heif-dec", "heif-convert"] : [OVERRIDE];

/**
 * Quality of the JPEG libheif hands over.
 *
 * An intermediate that exists for as long as it takes sharp to read it, so the
 * only thing that matters is that it costs nothing to write: **PNG was measured
 * at 1.35 s against JPEG's 0.19 s** for one 12-megapixel photograph, all of it
 * compression. 88 is above the point where a 256px thumbnail could tell the
 * difference.
 */
const QUALITY = 88;

/** Long enough for a large photograph on a slow disk, short enough to notice. */
const TIMEOUT_MS = 30_000;

/** The tool that answered, cached for the life of the process. */
let resolved: { name: string; version: string } | null | undefined;

/**
 * The version string of the libheif tool that runs, or `null` if none does.
 *
 * A version call rather than a PATH lookup, for the reason `ffmpeg.ts` gives:
 * "present" and "runs" are different questions, and a binary whose decoder
 * plugin is missing is on the PATH and is still not a capability. This one is
 * stricter than a version call, though — see {@link canDecodeHevc}.
 */
export async function heifVersion(): Promise<string | null> {
  const found = await locate();
  return found?.version ?? null;
}

async function locate(): Promise<{ name: string; version: string } | null> {
  if (resolved !== undefined) return resolved;

  for (const name of TOOL_NAMES) {
    try {
      const said = (await capture(name, ["--version"], 5_000)).toString("utf8");
      // " heif-dec  libheif version: 1.21.2" — the version, or the whole first
      // line if the wording ever changes.
      const first = said.split("\n")[0] ?? "";
      const version = /(\d+\.\d+\.\d+)/.exec(first)?.[1] ?? first.trim();
      if (await canDecodeHevc(name)) {
        resolved = { name, version };
        return resolved;
      }
    } catch {
      // The next name, then nothing.
    }
  }

  resolved = null;
  return resolved;
}

/**
 * Whether this libheif can decode HEVC, which is the whole question.
 *
 * The tool being installed says nothing: Fedora ships `libheif-tools` in its
 * main repository and the HEVC decoder plugin in none of them, so `heif-dec`
 * runs, reports a version, and then refuses every photograph anybody owns.
 * `--list-decoders` is what tells the two apart, and getting it wrong would
 * mean a queue that retries a thousand files to be told the same thing a
 * thousand times.
 */
async function canDecodeHevc(name: string): Promise<boolean> {
  try {
    return hasHeicDecoder((await capture(name, ["--list-decoders"], 5_000)).toString("utf8"));
  } catch {
    return false;
  }
}

/**
 * Whether `--list-decoders` named anything that can decode HEIC.
 *
 * Listed per format: a `HEIC decoders:` heading and then one `- name = …` line
 * per plugin. An empty section is a libheif that reads the container and not
 * the picture inside it — exactly what Fedora's own packages give you until RPM
 * Fusion's plugin is added, and the state this whole function exists to catch.
 */
export function hasHeicDecoder(listed: string): boolean {
  const section = /HEIC decoders:[^\n]*\n((?:-[^\n]*\n?)*)/i.exec(listed)?.[1] ?? "";
  return section.trim() !== "";
}

/**
 * Decodes a HEIC to JPEG bytes, with its tiles assembled and its rotation
 * applied.
 *
 * Through a temporary file rather than a pipe, which is not a preference:
 * `heif-dec` picks the output format from the filename's suffix and refuses
 * `/dev/stdout` with *"Unknown file type"*. The file goes in the system's
 * temporary directory — never inside the library, where `STORAGE_SPEC.md`
 * accounts for every path — and is removed even when the decode throws.
 */
export async function decodeHeif(path: string): Promise<Buffer> {
  const found = await locate();
  if (found === null) throw new Error("no libheif decoder on this machine");

  const directory = await mkdtemp(join(tmpdir(), "roost-heif-"));
  const output = join(directory, "decoded.jpg");
  try {
    await capture(found.name, ["--quiet", "-q", String(QUALITY), path, output], TIMEOUT_MS);
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Forgets which tool answered, so a newly installed one is found. */
export function forgetHeifTool(): void {
  resolved = undefined;
}
