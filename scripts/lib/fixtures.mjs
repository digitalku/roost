/**
 * Throwaway libraries for the checks that drive a window.
 *
 * Each of these scripts builds its own library in a temporary directory and
 * deletes it again, so none of them can ever touch anything of yours. That was
 * already true of `check-trash.mjs` and `check-transport.mjs` separately; this
 * is the same guarantee written once.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importInto, Library } from "@roost/library";
import { gradient } from "@roost/media";

/** A temporary directory and the promise that it goes away again. */
export async function scratch(prefix) {
  const dir = await mkdtemp(join(tmpdir(), `roost-${prefix}-`));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * A library with `count` real images in it.
 *
 * Real images rather than random bytes: a grid check is about thumbnails, and
 * an asset with no thumbnail draws a placeholder that has its own layout.
 */
export async function imageLibrary(dir, { count = 12, name = "Check", size = 64 } = {}) {
  const source = join(dir, "pictures");
  await mkdir(source, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    await writeFile(
      join(source, `shot-${index}.png`),
      await gradient(size, size, index + 1, "png"),
    );
  }
  const root = join(dir, `${name}.roost`);
  const library = await Library.create(root, name);
  try {
    await importInto(library, [source]);
  } finally {
    await library.close();
  }
  return root;
}

/**
 * A playable clip.
 *
 * **Not ffmpeg's default encoder for `.mp4`**, which is MPEG-4 Part 2 here:
 * Chromium refuses it with error 4 and it reads exactly like a broken protocol
 * handler — the content type is right and the bytes are right. This build has
 * no `libx264` either, so `libopenh264` is the spelling that works. Any fixture
 * meant to be *played* has to say so explicitly (`TODO.md` §2).
 */
export async function videoClip(path, { seconds = 20, size = "320x240", rate = 10 } = {}) {
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${size}:rate=${rate}:duration=${seconds}`,
    "-c:v",
    "libopenh264",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);
  return path;
}

/** A child process, resolved on a zero exit and rejected with its stderr. */
export function run(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    proc.stderr.on("data", (chunk) => {
      error += chunk;
    });
    proc.on("error", reject);
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(error))));
  });
}
