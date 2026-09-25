import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gradient } from "@roost/media";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);

/**
 * The built CLI, run as its own process.
 *
 * The other CLI tests call `run` in-process, which is faster and enough for
 * everything about arguments and output. This one cannot: what it checks is
 * behaviour under a **different environment**, and `@roost/media` locates
 * ffmpeg once per process — so a test that changed `process.env` here would be
 * asking a probe that had already run.
 */
const CLI = fileURLToPath(new URL("../dist/main.js", import.meta.url));

const built = await access(CLI).then(
  () => true,
  () => false,
);

const hasFfmpeg = await exec("ffmpeg", ["-version"]).then(
  () => true,
  () => false,
);

describe.runIf(built && hasFfmpeg)("a library imported on a machine with no ffmpeg", () => {
  let dir: string;
  let source: string;
  let library: string;

  /** The CLI, with ffmpeg and ffprobe pointed at binaries that do not exist. */
  const withoutFfmpeg = async (...args: string[]): Promise<string> => {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        ROOST_FFMPEG: join(dir, "no-such-ffmpeg"),
        ROOST_FFPROBE: join(dir, "no-such-ffprobe"),
      },
    });
    return stdout + stderr;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-no-ffmpeg-"));
    source = join(dir, "mixed");
    library = join(dir, "Library.roost");
    await mkdir(source, { recursive: true });

    await writeFile(join(source, "photo.png"), await gradient(320, 240, 1, "png"));
    await exec("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x120:rate=15",
      "-t",
      "1",
      "-pix_fmt",
      "yuv420p",
      join(source, "clip.mp4"),
    ]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("imports everything, draws what it can, and says what is missing", async () => {
    // The second half of M4's acceptance criterion (`ROADMAP.md`): the same
    // folder has to import cleanly with no ffmpeg, which means the video is a
    // complete asset that happens to have no picture yet.
    await withoutFfmpeg("init", join(dir, "Library"));
    const imported = await withoutFfmpeg("import", source, "-L", library);
    expect(imported).toContain("Imported 2 of 2 files");

    const derived = await withoutFfmpeg("thumb", "-L", library);

    expect(derived).toContain("Generated 1 thumbnail");
    expect(derived).toContain("missing:ffmpeg");
    // The line a person can act on, from the capability probe rather than from
    // a string in the CLI.
    expect(derived).toContain("install ffmpeg");

    // And the asset itself is whole: bytes, name, and hash, waiting for a
    // backend rather than lost to its absence.
    const stats = await withoutFfmpeg("stats", "-L", library);
    expect(stats).toContain("assets      2");
    expect(stats).toContain("parked");
    // Four spawned processes: 1.5 s alone, and past vitest's 5 s default when
    // the rest of the suite is running beside it (`TODO.md`, *Flakes*).
  }, 30_000);
});

describe.runIf(!built || !hasFfmpeg)("the no-ffmpeg check", () => {
  it("is skipped without a built CLI and an ffmpeg to make a video with", () => {
    // Not a silent pass: a run that proved nothing says so.
    expect(built && hasFfmpeg).toBe(false);
  });
});
