import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilities, refreshCapabilities } from "./capability.js";
import { derive } from "./derive.js";
import { GRID_SIZE } from "./serving.js";
import { gradient } from "./synth.js";
import { makeFont } from "./testing/font-fixture.js";
import { makePdf } from "./testing/pdf-fixture.js";

const run = promisify(execFile);

/**
 * Whether this machine can make a video to derive from.
 *
 * The same tool the backend uses, which is the point: where it is absent the
 * video tests skip *and* the "absent" test still runs, so a run that proved
 * nothing about video still proves what happens without it.
 */
const hasFfmpeg = await run("ffmpeg", ["-version"]).then(
  () => true,
  () => false,
);

describe("deriving what a file is worth", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-derive-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const put = async (name: string, bytes: Buffer | string): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, bytes);
    return path;
  };

  it("makes an image's thumbnail and reports its size", async () => {
    const path = await put("image.png", await gradient(320, 200, 7, "png"));

    const outcome = await derive(path, [GRID_SIZE]);

    expect(outcome).toMatchObject({ ok: true, metadata: { width: 320, height: 200 } });
    if (!outcome.ok) return;
    expect(outcome.thumbnails).toHaveLength(1);
    expect(outcome.thumbnails[0]?.size).toBe(GRID_SIZE);
  });

  it("draws an SVG, which nothing in this build could draw before M4", async () => {
    const path = await put(
      "logo.svg",
      `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#3aa"/></svg>`,
    );

    const outcome = await derive(path, [GRID_SIZE]);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.thumbnails).toHaveLength(1);
    // Rendered at the vector width and kept in proportion, so a grid cell
    // reserves the drawing's shape rather than a square.
    expect(outcome.metadata.width).toBe(512);
    expect(outcome.metadata.height).toBe(256);
  });

  it("reads a font's names and draws its specimen", async () => {
    const path = await put("fixture.ttf", makeFont({ family: "Timber Sans", style: "Bold" }));

    const outcome = await derive(path, [GRID_SIZE]);

    expect(outcome).toMatchObject({
      ok: true,
      metadata: {
        props: { "font.family": "Timber Sans", "font.style": "Bold", "font.glyphs": "2" },
      },
    });
    if (!outcome.ok) return;
    expect(outcome.thumbnails).toHaveLength(1);
  });

  it("renders a PDF's first page and counts the rest", async () => {
    const path = await put(
      "report.pdf",
      makePdf([{ colour: [200, 30, 30] }, { colour: [30, 200, 30] }]),
    );

    const outcome = await derive(path, [GRID_SIZE]);

    expect(outcome).toMatchObject({
      ok: true,
      metadata: { pageCount: 2, width: 595, height: 842 },
    });
  });

  it("parks a format nothing in this build draws, rather than failing", async () => {
    // A BMP has no libvips loader and a zip has no picture at all. Both import
    // perfectly well; both are a thumbnail nobody can make.
    const zip = await put("bundle.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));

    expect(await derive(zip, [GRID_SIZE])).toEqual({ ok: false, reason: "unsupported:zip" });
  });

  it("decides from the bytes, not from the extension", async () => {
    // A PNG named `.mp4` is ordinary in a downloads folder. Dispatching on the
    // name would hand it to ffmpeg, which would fail on a file that is fine.
    const path = await put("misnamed.mp4", await gradient(64, 64, 3, "png"));

    const outcome = await derive(path, [GRID_SIZE]);

    expect(outcome).toMatchObject({ ok: true, metadata: { width: 64, height: 64 } });
  });

  describe.runIf(hasFfmpeg)("with ffmpeg present", () => {
    it("takes a frame from a video and records its duration", async () => {
      const path = join(dir, "clip.mp4");
      await run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x240:rate=15",
        "-t",
        "4",
        "-pix_fmt",
        "yuv420p",
        path,
      ]);

      const outcome = await derive(path, [GRID_SIZE]);

      expect(outcome).toMatchObject({
        ok: true,
        metadata: { width: 320, height: 240, durationMs: 4000 },
      });
      if (!outcome.ok) return;
      expect(outcome.thumbnails[0]?.data.length).toBeGreaterThan(0);
      expect(outcome.metadata.props?.["video.codec"]).toBeDefined();
    });

    it("draws a waveform for audio, which has nothing to photograph", async () => {
      const path = join(dir, "tone.wav");
      await run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=3",
        path,
      ]);

      const outcome = await derive(path, [GRID_SIZE]);

      expect(outcome).toMatchObject({ ok: true, metadata: { durationMs: 3000 } });
      if (!outcome.ok) return;
      // A waveform is wider than it is tall, and a tone is not silence.
      const thumbnail = outcome.thumbnails[0];
      expect(thumbnail?.width).toBeGreaterThan(thumbnail?.height ?? 0);
      expect(outcome.metadata.width).toBeUndefined();
    });

    it("reports the tools it found", async () => {
      const media = (await capabilities()).find((entry) => entry.name === "media");

      expect(media?.available).toBe(true);
      expect(media?.detail).toContain("ffmpeg");
    });
  });

  it("blocks video on a machine with no ffmpeg, and says which tool is missing", async () => {
    // Pointed at a binary that does not exist rather than at a machine without
    // one: the code path is identical, and this is the only way the absent case
    // is ever exercised on a developer's machine or in CI.
    vi.resetModules();
    vi.stubEnv("ROOST_FFMPEG", join(dir, "no-such-ffmpeg"));
    vi.stubEnv("ROOST_FFPROBE", join(dir, "no-such-ffprobe"));

    try {
      const fresh = await import("./derive.js");
      const capability = await import("./capability.js");
      const path = join(dir, "clip.mp4");
      // Bytes enough to sniff as MP4; nothing decodes them, which is the point.
      await writeFile(
        path,
        Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(52)]),
      );

      expect(await fresh.derive(path, [GRID_SIZE])).toEqual({
        ok: false,
        reason: "missing:ffmpeg",
      });

      const media = (await capability.capabilities()).find((entry) => entry.name === "media");
      expect(media?.available).toBe(false);
      expect(media?.detail).toBe("install ffmpeg for video and audio previews");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      await refreshCapabilities();
    }
  });
});
