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
import { canMakeHeic, makeHeic } from "./testing/heic-fixture.js";
import { makePdf } from "./testing/pdf-fixture.js";
import { makeRaw } from "./testing/raw-fixture.js";

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

/** Whether this machine has libheif, which is what HEIC needs (ADR-0040). */
const hasLibheif = await canMakeHeic();

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
    // The drawing's own size, not the width it was rasterised at: an inspector
    // showing "512 × 256" for an 80×40 logo would be inventing a number.
    expect(outcome.metadata.width).toBe(80);
    expect(outcome.metadata.height).toBe(40);
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
    // The specimen sheet's shape, which is what the grid lays the cell out
    // from. Without it a font gets a square cell and a sheet five times wider
    // than it is tall is cropped to its middle — seen in a real window.
    expect(outcome.metadata.width).toBe(512);
    expect(outcome.metadata.height).toBeGreaterThan(0);
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

  it("draws a RAW from the JPEG its camera embedded", async () => {
    // Demosaicing a sensor would produce a different picture from the one the
    // photographer saw; the camera's own preview is what a grid should show.
    const path = await put(
      "shot.nef",
      makeRaw({
        width: 6000,
        height: 4000,
        preview: await gradient(320, 213, 5, "jpeg"),
      }),
    );

    const outcome = await derive(path, [GRID_SIZE]);

    // The photograph's dimensions, not the preview's.
    expect(outcome).toMatchObject({ ok: true, metadata: { width: 6000, height: 4000 } });
    if (!outcome.ok) return;
    expect(outcome.thumbnails).toHaveLength(1);
  });

  it("leaves a scanned TIFF to the image decoder, where it belongs", async () => {
    // A TIFF with no embedded preview is a scan, not a RAW, and the difference
    // is not visible in a header.
    const path = await put("scan.tiff", await gradient(200, 120, 4, "tiff"));

    expect(await derive(path, [GRID_SIZE])).toMatchObject({
      ok: true,
      metadata: { width: 200, height: 120 },
    });
  });

  it("parks a RAW container this build cannot open", async () => {
    // Canon's CR3 and Fuji's RAF are not TIFF at all. Recognised, so they do
    // not reach ffmpeg as videos, and parked, because that is a capability this
    // build does not have rather than a broken file.
    const cr3 = Buffer.alloc(64);
    cr3.write("ftyp", 4, "latin1");
    cr3.write("crx ", 8, "latin1");
    const path = await put("shot.cr3", cr3);

    expect(await derive(path, [GRID_SIZE])).toEqual({ ok: false, reason: "unsupported:raw" });
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

    it("thumbnails an animated GIF as a still, and leaves the animation to the window", async () => {
      // The preview plays it: an `<img>` over `roost://original` animates GIF
      // and animated WebP by itself, which is why neither needs a backend of
      // its own. What a *thumbnail* must be is one frame — an animated one
      // would be a grid of moving cells and a stored file many times the size.
      const path = join(dir, "spin.gif");
      await run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=64x64:rate=10",
        "-t",
        "1",
        path,
      ]);

      const outcome = await derive(path, [GRID_SIZE]);

      expect(outcome).toMatchObject({ ok: true, metadata: { width: 64, height: 64 } });
      if (!outcome.ok) return;
      expect(outcome.thumbnails).toHaveLength(1);
      // One frame's worth of WebP, not ten.
      expect(outcome.thumbnails[0]?.height).toBe(64);
    });

    it("reports the tools it found", async () => {
      const media = (await capabilities()).find((entry) => entry.name === "media");

      expect(media?.available).toBe(true);
      expect(media?.detail).toContain("ffmpeg");
    });
  });

  it.skipIf(!hasLibheif)("assembles a HEIC through libheif, tiles and all", async () => {
    const path = await makeHeic(dir);

    const outcome = await derive(path, [GRID_SIZE]);

    // The dimensions are the **assembled** picture's. A HEIC holds tiles and a
    // rotation, and neither of those numbers is the photograph's (ADR-0040).
    expect(outcome).toMatchObject({ ok: true, metadata: { width: 320, height: 240 } });
    if (outcome.ok) expect(outcome.thumbnails[0]?.size).toBe(GRID_SIZE);
  });

  it("blocks a HEIC on a machine with no libheif, rather than failing it", async () => {
    // Parked and not failed, because nothing is wrong with the file: the
    // decoder is patent-encumbered and cannot ship inside Roost (ADR-0040), so
    // this is the same shape as a missing ffmpeg and it is released the same
    // way — by installing the thing and pressing Try again.
    vi.resetModules();
    vi.stubEnv("ROOST_HEIF_DEC", join(dir, "no-such-heif-dec"));

    try {
      const fresh = await import("./derive.js");
      const capability = await import("./capability.js");
      const path = join(dir, "photo.heic");
      // Enough bytes to sniff as HEIC; nothing decodes them, which is the point.
      await writeFile(
        path,
        Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(52)]),
      );

      expect(await fresh.derive(path, [GRID_SIZE])).toEqual({
        ok: false,
        reason: "missing:libheif",
      });

      const heif = (await capability.capabilities()).find((entry) => entry.name === "heif");
      expect(heif?.available).toBe(false);
      expect(heif?.detail).toBe("install libheif for HEIC photographs");
      // And a command to run, chosen for whatever this machine is.
      expect(heif?.install).toBeTruthy();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      await refreshCapabilities();
    }
  });

  it("offers no command for a missing libheif inside a Flatpak", async () => {
    // ADR-0063 §7: the host's package manager never reaches the sandbox, so a
    // missing tool is the build's fault and the window is told so.
    vi.resetModules();
    vi.stubEnv("ROOST_HEIF_DEC", join(dir, "no-such-heif-dec"));
    vi.stubEnv("FLATPAK_ID", "com.digitalku.roost");

    try {
      const capability = await import("./capability.js");
      const heif = (await capability.capabilities()).find((entry) => entry.name === "heif");
      expect(heif?.available).toBe(false);
      expect(heif?.bundled).toBe(true);
      expect(heif?.install).toBeNull();
      expect(heif?.installable).toBe(false);
      expect(heif?.detail).toBe("this build of Roost carries no working libheif");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      await refreshCapabilities();
    }
  });

  it.runIf(hasFfmpeg && process.platform !== "win32")(
    "parks a video whose codec this ffmpeg cannot decode, and keeps what ffprobe read",
    async () => {
      // Fedora's ffmpeg-free runs and has no `hevc` decoder, and the frame grab
      // failed with `Invalid argument` — a fault in a file that has none
      // (ADR-0017, amended 2026-09-24). No machine here lacks a decoder on
      // demand, so a wrapper lists every decoder but `mpeg4` and runs the real
      // ffmpeg for everything else. A shell script, hence not on Windows.
      const clip = join(dir, "clip.mp4");
      await run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x240:rate=15",
        "-t",
        "2",
        "-c:v",
        "mpeg4",
        clip,
      ]);
      const wrapper = join(dir, "ffmpeg-without-mpeg4");
      await writeFile(
        wrapper,
        [
          "#!/bin/sh",
          'case "$*" in',
          // Both spellings: a decoder named for its codec, and one that says
          // `(codec mpeg4)` — Fedora's build has `mpeg4_v4l2m2m` as well.
          '  *-decoders*) ffmpeg "$@" | grep -vE " mpeg4 |codec mpeg4\\)" ;;',
          '  *) exec ffmpeg "$@" ;;',
          "esac",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      vi.resetModules();
      vi.stubEnv("ROOST_FFMPEG", wrapper);
      try {
        const fresh = await import("./derive.js");
        const capability = await import("./capability.js");

        expect((await capability.mediaDecoders())?.has("mpeg4")).toBe(false);
        const outcome = await fresh.derive(clip, [GRID_SIZE]);

        // Parked, not failed, and never attempted.
        expect(outcome).toMatchObject({ ok: false, reason: "missing:decoder:mpeg4" });
        // What ffprobe read survives the park, so the cell is the right shape
        // and the inspector can say which codec it is.
        expect(outcome).toMatchObject({
          metadata: { width: 320, height: 240, durationMs: 2000 },
        });
        if (outcome.ok) return;
        expect(outcome.metadata?.props?.["video.codec"]).toBe("mpeg4");
        // And ffmpeg is still available: every other video draws.
        const media = (await capability.capabilities()).find((entry) => entry.name === "media");
        expect(media?.available).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
        await refreshCapabilities();
      }
    },
  );

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
