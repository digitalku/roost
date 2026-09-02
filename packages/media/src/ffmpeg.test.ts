import { describe, expect, it } from "vitest";
import { asPathArgument } from "./external.js";
import { frameTimestamp, readProbe } from "./ffmpeg.js";

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
