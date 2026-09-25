import { describe, expect, it } from "vitest";
import { asPathArgument, telling } from "./external.js";
import { frameTimestamp, readDecoders, readProbe } from "./ffmpeg.js";

describe("reading what ffprobe said", () => {
  it("takes a video's duration, size, and codec", () => {
    const probe = readProbe(
      JSON.stringify({
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1280,
            height: 720,
            avg_frame_rate: "30/1",
          },
        ],
        format: { duration: "10.000000" },
      }),
    );

    expect(probe).toEqual({
      durationMs: 10_000,
      width: 1280,
      height: 720,
      props: { "video.codec": "h264", "video.fps": "30" },
    });
  });

  it("finds an MP3's duration on the container, where it lives", () => {
    // An MP3 has one stream and no duration on it; the format carries it. A
    // reader that only looked at the stream would report every MP3 as unknown.
    const probe = readProbe(
      JSON.stringify({
        streams: [{ codec_type: "audio", codec_name: "mp3", channels: 2, sample_rate: "44100" }],
        format: { duration: "8.5" },
      }),
    );

    expect(probe.durationMs).toBe(8500);
    expect(probe.width).toBeUndefined();
    expect(probe.props).toEqual({
      "audio.codec": "mp3",
      "audio.channels": "2",
      "audio.sampleRate": "44100",
    });
  });

  it("reads a fractional frame rate as one", () => {
    const probe = readProbe(
      JSON.stringify({
        streams: [{ codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30000/1001" }],
        format: {},
      }),
    );

    expect(probe.props["video.fps"]).toBe("29.97");
  });

  it("says nothing rather than zero when a field is missing or nonsense", () => {
    // A still image in a video container reports `0/0` for its frame rate, and
    // a stream can arrive with no dimensions at all. Both have to come back
    // absent: a zero would be stored, shown, and believed.
    const probe = readProbe(
      JSON.stringify({
        streams: [{ codec_type: "video", width: 0, avg_frame_rate: "0/0" }],
        format: { duration: "N/A" },
      }),
    );

    expect(probe.durationMs).toBeUndefined();
    expect(probe.width).toBeUndefined();
    expect(probe.height).toBeUndefined();
    expect(probe.props["video.fps"]).toBeUndefined();
  });

  it("survives a probe that is not the shape ffprobe promises", () => {
    expect(readProbe("null")).toEqual({ props: {} });
    expect(readProbe("{}")).toEqual({ props: {} });
    expect(readProbe(JSON.stringify({ streams: "nonsense" }))).toEqual({ props: {} });
  });
});

describe("where a thumbnail frame comes from", () => {
  it("is a tenth of the way in, so a fade from black is not the thumbnail", () => {
    expect(frameTimestamp(30_000)).toBe(3_000);
  });

  it("stops climbing on a long film, because seeking that far is not worth it", () => {
    expect(frameTimestamp(2 * 60 * 60 * 1000)).toBe(10_000);
  });

  it("guesses a second in when the duration is unknown", () => {
    expect(frameTimestamp(undefined)).toBe(1000);
    expect(frameTimestamp(0)).toBe(1000);
  });

  it("takes a pinned moment over the guess, cap included", () => {
    // The cap exists to stop *guessing* twelve minutes into a film, not to
    // overrule somebody who picked a frame there (ADR-0024 stage 4).
    expect(frameTimestamp(2 * 60 * 60 * 1000, 91_500)).toBe(91_500);
    expect(frameTimestamp(30_000, 0)).toBe(0);
    // Absent means nothing was pinned, and the guess stands.
    expect(frameTimestamp(30_000, undefined)).toBe(3_000);
  });
});

describe("handing a path to a tool that reads a leading dash as an option", () => {
  it("makes a relative path that starts with one a path again", () => {
    expect(asPathArgument("-weird name.mp4")).toBe("./-weird name.mp4");
  });

  it("leaves an ordinary path and an absolute one alone", () => {
    expect(asPathArgument("holiday.mp4")).toBe("holiday.mp4");
    expect(asPathArgument("/srv/media/-weird.mp4")).toBe("/srv/media/-weird.mp4");
  });
});

describe("reading what this ffmpeg can decode", () => {
  // Abridged from `ffmpeg -hide_banner -decoders` on Fedora 44's ffmpeg-free
  // 8.1.2, the build that lacks `hevc` (ADR-0017, amended 2026-09-24).
  const LISTED = `Decoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ------
 V....D libopenh264          OpenH264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 VFS..D prores               Apple ProRes (iCodec Pro)
 V....D libdav1d             dav1d AV1 decoder by VideoLAN (codec av1)
 AF...D flac                 FLAC (Free Lossless Audio Codec)
 A....D aac                  AAC (Advanced Audio Coding)
`;

  it("keys on the codec, which is what ffprobe names a stream by", () => {
    const decoders = readDecoders(LISTED);
    expect(decoders.has("h264")).toBe(true);
    expect(decoders.has("av1")).toBe(true);
    expect(decoders.has("libopenh264")).toBe(false);
    expect(decoders.has("prores")).toBe(true);
    expect(decoders.has("aac")).toBe(true);
    expect(decoders.has("hevc")).toBe(false);
  });

  it("does not read the legend as decoders", () => {
    // ` V..... = Video` has a row's shape, and would add a codec called `=`.
    const decoders = readDecoders(LISTED);
    expect(decoders.has("=")).toBe(false);
    expect(decoders.size).toBe(5);
  });
});

describe("the line kept from a tool's stderr", () => {
  it("is the last one, usually", () => {
    expect(telling("banner\nsomething\n  Invalid data found when processing input  \n\n")).toBe(
      "Invalid data found when processing input",
    );
  });

  it("is the missing decoder, where ffmpeg buried it under a consequence", () => {
    // Verbatim from `ffmpeg-free` 8.1.2 on an HEVC stream, bar the banner. The
    // last line is what the failures list showed a user, and it names nothing
    // anybody could install.
    const stderr = [
      "  Stream #0:0[0x1](und): Video: hevc (hvc1 / 0x31637668), none, 640x360",
      "[vist#0:0/hevc @ 0x5630e0793740] Decoding requested, but no decoder found for: hevc",
      "Error opening output file out.png.",
      "Error opening output files: Invalid argument",
    ].join("\n");
    // Without the bracket, whose address differs on every run and would split
    // one fault into a group per file.
    expect(telling(stderr)).toBe("Decoding requested, but no decoder found for: hevc");
  });
});
