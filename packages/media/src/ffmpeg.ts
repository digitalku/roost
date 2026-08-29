import { asPathArgument, capture, ExternalToolError, stream } from "./external.js";

/**
 * Video and audio, through the system's `ffmpeg` and `ffprobe` (ADR-0017).
 *
 * Nothing here is a hard dependency. The tools are located once per process and
 * their absence is a capability the UI reports, never an import failure: an
 * asset whose duration is unknown still imports, still carries tags, and gains
 * its thumbnail the moment ffmpeg exists and the derive pass runs again.
 */

/** Overridable so a user with a build outside the PATH can point at it. */
const FFMPEG = process.env["ROOST_FFMPEG"] ?? "ffmpeg";
const FFPROBE = process.env["ROOST_FFPROBE"] ?? "ffprobe";

/**
 * Where a video's thumbnail frame comes from, as a fraction of its duration.
 *
 * Not frame zero: a title card, a fade from black, or a slate is exactly what
 * a first frame tends to be, and a grid full of black squares is worse than
 * slow. Capped in absolute terms as well, because a tenth of a two-hour film is
 * twelve minutes in and seeking that far costs more than the frame is worth.
 */
const FRAME_AT_FRACTION = 0.1;
const FRAME_AT_MAX_MS = 10_000;

/** How wide a grabbed frame is before it reaches the encoder. */
const FRAME_WIDTH = 512;

/** Buckets across a waveform image. One column of the drawn image each. */
export const WAVEFORM_BUCKETS = 512;

/** How tall the drawn waveform is, in pixels. */
export const WAVEFORM_HEIGHT = 256;

/** The sample rate a waveform is computed at. Peaks, not fidelity. */
const WAVEFORM_SAMPLE_RATE = 8000;

/** What `ffprobe` reported about a file. */
export interface MediaProbe {
  readonly durationMs?: number;
  readonly width?: number;
  readonly height?: number;
  readonly props: Record<string, string>;
}

/** The version string of a tool that runs, or `null` if it does not. */
export async function ffmpegVersion(): Promise<string | null> {
  return toolVersion(FFMPEG);
}

export async function ffprobeVersion(): Promise<string | null> {
  return toolVersion(FFPROBE);
}

/**
 * Asks a tool for its version.
 *
 * A version call rather than a PATH lookup, because "present" and "runs" are
 * different questions and only the second one matters: a binary with a missing
 * shared library is on the PATH and is still not a capability.
 */
async function toolVersion(tool: string): Promise<string | null> {
  try {
    const out = (await capture(tool, ["-version"], 5_000)).toString("utf8");
    // "ffmpeg version 8.1.2 Copyright (c) …" — the third word, and the whole
    // first line if the format is ever something else.
    const first = out.split("\n")[0] ?? "";
    return first.split(" ")[2] ?? first.trim();
  } catch {
    return null;
  }
}

/**
 * Duration, dimensions, and codec details.
 *
 * Reads the container, not the stream: a ten-second probe of a four-gigabyte
 * file costs the same as one of a four-megabyte file, because almost all of it
 * is process start (ADR-0017).
 */
export async function probeMedia(path: string): Promise<MediaProbe> {
  const output = await capture(FFPROBE, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    asPathArgument(path),
  ]);

  return readProbe(output.toString("utf8"));
}

/**
 * Turns `ffprobe`'s JSON into what the index stores.
 *
 * Exported for its own test: every field here is optional in some real file,
 * and the parsing is where a missing one turns into a wrong number rather than
 * into nothing.
 */
export function readProbe(json: string): MediaProbe {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) return { props: {} };

  const root = parsed as { streams?: unknown; format?: unknown };
  const streams = Array.isArray(root.streams) ? (root.streams as Record<string, unknown>[]) : [];
  const format = isRecord(root.format) ? root.format : {};

  const video = streams.find((s) => s["codec_type"] === "video");
  const audio = streams.find((s) => s["codec_type"] === "audio");

  const props: Record<string, string> = {};
  const probe: {
    durationMs?: number;
    width?: number;
    height?: number;
    props: Record<string, string>;
  } = { props };

  // The container's duration first: a stream can lack one, and an MP3's
  // duration lives on the format rather than on its single stream.
  const duration = seconds(format["duration"]) ?? seconds(video?.["duration"] ?? undefined);
  if (duration !== undefined) probe.durationMs = Math.round(duration * 1000);

  if (video !== undefined) {
    const width = integer(video["width"]);
    const height = integer(video["height"]);
    if (width !== undefined) probe.width = width;
    if (height !== undefined) probe.height = height;
    if (typeof video["codec_name"] === "string") props["video.codec"] = video["codec_name"];
    const fps = frameRate(video["avg_frame_rate"]);
    if (fps !== undefined) props["video.fps"] = String(fps);
  }

  if (audio !== undefined) {
    if (typeof audio["codec_name"] === "string") props["audio.codec"] = audio["codec_name"];
    const channels = integer(audio["channels"]);
    if (channels !== undefined) props["audio.channels"] = String(channels);
    const rate = integer(audio["sample_rate"]);
    if (rate !== undefined) props["audio.sampleRate"] = String(rate);
  }

  // A video file with no video stream is an audio file with the wrong
  // extension, which is ordinary. Dimensions stay absent rather than zero.
  return probe;
}

/**
 * Grabs one frame, scaled, as PNG bytes on stdout.
 *
 * **Input seek** — `-ss` before `-i` — which measured flat in the seek
 * position, 0.12 s at the first frame and 0.13 s five seconds in, where output
 * seek decodes everything up to the timestamp and widens with the file
 * (ADR-0017). Scaling happens in ffmpeg rather than afterwards so that a 4K
 * frame never crosses the pipe.
 */
export async function grabFrame(path: string, durationMs?: number): Promise<Buffer> {
  const at = frameTimestamp(durationMs);
  const args = (seconds: number): string[] => [
    "-v",
    "error",
    "-ss",
    seconds.toFixed(3),
    "-i",
    asPathArgument(path),
    "-frames:v",
    "1",
    // `-2` keeps the height even, which some encoders require, and `min` never
    // enlarges a video narrower than the thumbnail.
    "-vf",
    `scale='min(${FRAME_WIDTH},iw)':-2`,
    "-f",
    "image2pipe",
    "-vcodec",
    "png",
    "-",
  ];

  const frame = await capture(FFMPEG, args(at / 1000));
  if (frame.length > 0) return frame;

  // A seek past the last frame returns nothing and exits zero, which happens on
  // a clip shorter than its container claims. The first frame is the honest
  // answer there, and a black square beats a missing thumbnail.
  if (at === 0) throw new ExternalToolError(FFMPEG, "produced no frame");
  const first = await capture(FFMPEG, args(0));
  if (first.length === 0) throw new ExternalToolError(FFMPEG, "produced no frame");
  return first;
}

/** Where in a file the thumbnail frame is taken from. */
export function frameTimestamp(durationMs?: number): number {
  if (durationMs === undefined || durationMs <= 0) return 1000;
  return Math.min(durationMs * FRAME_AT_FRACTION, FRAME_AT_MAX_MS);
}

/**
 * Peak amplitude per bucket, from 0 to 1, across the whole file.
 *
 * Computed as the samples stream past rather than from a decoded whole: an hour
 * of 8 kHz mono PCM is 57 MB, and nothing here needs more than two numbers per
 * bucket. Resampling to a bucket-sized rate would have been simpler and wrong —
 * a resampler low-passes, so the peaks that make a waveform legible are exactly
 * what it removes.
 */
export async function waveformPeaks(
  path: string,
  buckets = WAVEFORM_BUCKETS,
  durationMs?: number,
): Promise<Float32Array> {
  const peaks = new Float32Array(buckets);
  const expected =
    durationMs === undefined || durationMs <= 0
      ? undefined
      : Math.max(1, Math.round((durationMs / 1000) * WAVEFORM_SAMPLE_RATE));

  let index = 0;
  // A sample can straddle two chunks, so the odd byte is carried forward.
  let carry: number | undefined;

  const consume = (sample: number): void => {
    const bucket =
      expected === undefined
        ? index % buckets
        : Math.min(buckets - 1, Math.floor((index / expected) * buckets));
    const level = Math.abs(sample) / 32768;
    if (level > (peaks[bucket] ?? 0)) peaks[bucket] = level;
    index += 1;
  };

  await stream(
    FFMPEG,
    [
      "-v",
      "error",
      "-i",
      asPathArgument(path),
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-filter:a",
      `aresample=${WAVEFORM_SAMPLE_RATE}`,
      "-c:a",
      "pcm_s16le",
      "-f",
      "data",
      "-",
    ],
    (chunk) => {
      let offset = 0;
      if (carry !== undefined && chunk.length > 0) {
        // Little-endian: the byte held over is the low half of this sample.
        const raw = (chunk.readUInt8(0) << 8) | carry;
        consume(raw >= 0x8000 ? raw - 0x10000 : raw);
        carry = undefined;
        offset = 1;
      }
      for (; offset + 1 < chunk.length; offset += 2) consume(chunk.readInt16LE(offset));
      if (offset < chunk.length) carry = chunk.readUInt8(offset);
    },
  );

  return peaks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function seconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function integer(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** `avg_frame_rate` arrives as `"30/1"`, and as `"0/0"` for a still image. */
function frameRate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const [numerator, denominator] = value.split("/").map((part) => Number.parseInt(part, 10));
  if (numerator === undefined || denominator === undefined) return undefined;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return undefined;
  }
  return Math.round((numerator / denominator) * 100) / 100;
}
