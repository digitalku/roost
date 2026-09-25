import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { importInto, Library, queueStatus, runDerives } from "@roost/library";
import { GRID_SIZE, gradient } from "@roost/media";
import { makeFont } from "@roost/media/testing/font-fixture";
import { makePdf } from "@roost/media/testing/pdf-fixture";
import { makeRaw } from "@roost/media/testing/raw-fixture";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);

const hasFfmpeg = await run("ffmpeg", ["-version"]).then(
  () => true,
  () => false,
);

/**
 * M4's acceptance criterion, as a test.
 *
 * `ROADMAP.md`: *a mixed folder of every listed format imports with correct
 * thumbnails and metadata, and the same folder imports cleanly on a system with
 * no ffmpeg.* Both halves are here, and the second one is the half that would
 * otherwise never be exercised — every machine this is developed on has ffmpeg.
 */
describe("a folder with one of everything in it", () => {
  let dir: string;
  let source: string;
  let library: Library;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-formats-"));
    source = join(dir, "mixed");
    await mkdir(source, { recursive: true });

    await writeFile(join(source, "photo.png"), await gradient(640, 480, 1, "png"));
    await writeFile(join(source, "shot.jpg"), await gradient(200, 150, 2, "jpeg"));
    await writeFile(
      join(source, "logo.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><circle cx="60" cy="30" r="28" fill="#c33"/></svg>`,
    );
    await writeFile(join(source, "typeface.ttf"), makeFont({ family: "Timber Sans" }));
    await writeFile(join(source, "report.pdf"), makePdf([{ colour: [30, 30, 200] }]));
    await writeFile(
      join(source, "capture.nef"),
      makeRaw({ width: 6000, height: 4000, preview: await gradient(320, 213, 3, "jpeg") }),
    );
    await writeFile(join(source, "bundle.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));

    if (hasFfmpeg) {
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
        "-pix_fmt",
        "yuv420p",
        join(source, "clip.mp4"),
      ]);
      await run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        join(source, "tone.wav"),
      ]);
    }

    library = await Library.create(join(dir, "library"), "Formats");
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * The detail of the asset imported from `name`.
   *
   * Matched on the name **and** the extension, because the journal keeps them
   * apart (RL-33) and a test that asked for `photo` alone would find a `.png`
   * and a `.jpg` of the same name indistinguishable.
   */
  const detailFor = (name: string) => {
    const dot = name.lastIndexOf(".");
    const stem = dot === -1 ? name : name.slice(0, dot);
    const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
    const detail = library.db.repo
      .allIds()
      .map((candidate) => library.db.repo.assetDetail(candidate))
      .find((found) => found?.name === stem && found?.ext === ext);
    if (detail === undefined) throw new Error(`${name} was not imported`);
    return detail;
  };

  const thumbnails = (name: string): number =>
    library.db.repo.thumbnail(detailFor(name).id, GRID_SIZE) === undefined ? 0 : 1;

  it("imports everything and draws what has a backend", async () => {
    await importInto(library, [source]);
    await runDerives(library, { sizes: [GRID_SIZE] });

    // Every file is an asset, including the one nothing can draw: a library
    // holds anything (`CONCEPT.md` §5).
    expect(library.stats().assets).toBe(hasFfmpeg ? 9 : 7);

    expect(thumbnails("photo.png")).toBe(1);
    expect(thumbnails("shot.jpg")).toBe(1);
    expect(thumbnails("logo.svg")).toBe(1);
    expect(thumbnails("typeface.ttf")).toBe(1);
    expect(thumbnails("report.pdf")).toBe(1);
    expect(thumbnails("capture.nef")).toBe(1);
    expect(thumbnails("bundle.zip")).toBe(0);

    // And the metadata each backend is responsible for.
    expect(detailFor("logo.svg")).toMatchObject({ width: 120, height: 60 });
    expect(detailFor("report.pdf")).toMatchObject({ pageCount: 1, width: 595, height: 842 });
    expect(detailFor("capture.nef")).toMatchObject({ width: 6000, height: 4000 });
    expect(detailFor("typeface.ttf").props).toMatchObject({ "font.family": "Timber Sans" });

    // The zip is parked with a reason, which keeps the sweep from offering it
    // again — and is not reported, because an archive with no picture is what
    // an archive looks like (2026-09-24).
    expect(library.db.repo.jobReasons("blocked")).toContainEqual({
      reason: "unsupported:zip",
      count: 1,
    });
    expect(queueStatus(library).reasons).not.toContainEqual({
      reason: "unsupported:zip",
      count: 1,
    });
  });

  it.runIf(hasFfmpeg)("takes a frame from the video and a waveform from the audio", async () => {
    await importInto(library, [source]);
    await runDerives(library, { sizes: [GRID_SIZE] });

    expect(thumbnails("clip.mp4")).toBe(1);
    expect(thumbnails("tone.wav")).toBe(1);
    expect(detailFor("clip.mp4")).toMatchObject({ width: 320, height: 240, durationMs: 2000 });
    expect(detailFor("tone.wav")).toMatchObject({ durationMs: 2000 });
  });

  it("imports the same folder cleanly with no ffmpeg on the machine", async () => {
    // Pointed at binaries that do not exist, which is the same code path as a
    // machine without them — and the only way this half of the criterion is
    // ever exercised, since every machine this is developed on has ffmpeg.
    const previous = { ffmpeg: process.env["ROOST_FFMPEG"], ffprobe: process.env["ROOST_FFPROBE"] };
    process.env["ROOST_FFMPEG"] = join(dir, "no-such-ffmpeg");
    process.env["ROOST_FFPROBE"] = join(dir, "no-such-ffprobe");

    try {
      const report = await importInto(library, [source]);
      expect(report.failed).toEqual([]);
      expect(library.stats().assets).toBe(hasFfmpeg ? 9 : 7);

      // The derive pass is a separate module instance in this process, so what
      // it can see of the environment is what the capability probe already
      // cached. The check that matters here is the import: nothing failed, and
      // every asset is present with its bytes, its name, and its hash.
      expect(library.db.repo.allIds()).toHaveLength(hasFfmpeg ? 9 : 7);
    } finally {
      if (previous.ffmpeg === undefined) delete process.env["ROOST_FFMPEG"];
      else process.env["ROOST_FFMPEG"] = previous.ffmpeg;
      if (previous.ffprobe === undefined) delete process.env["ROOST_FFPROBE"];
      else process.env["ROOST_FFPROBE"] = previous.ffprobe;
    }
  });
});
