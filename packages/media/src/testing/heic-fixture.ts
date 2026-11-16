import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gradient } from "../synth.js";

const run = promisify(execFile);

/**
 * A real HEIC, encoded by libheif, for the tests that need one.
 *
 * Built rather than checked in, for the reason the other fixtures here are:
 * a binary in the repository is a thing nobody can read in a diff, and this one
 * would additionally be a file whose *encoder* is the subject of the test.
 *
 * It needs `heif-enc`, so every test that calls it skips where libheif is
 * absent — the same rule the video fixtures follow for ffmpeg (ADR-0017).
 */
export async function makeHeic(
  directory: string,
  name = "photo.heic",
  width = 320,
  height = 240,
): Promise<string> {
  const source = join(directory, "source.png");
  const target = join(directory, name);
  await writeFile(source, await gradient(width, height, 7, "png"));
  // No `--quiet`: `heif-enc` does not take one, and it says so on stderr while
  // still writing the file, which is a confusing way to pass.
  await run("heif-enc", ["-o", target, source]);
  // The PNG it was made from goes away again. A caller that hands this
  // directory to an importer would otherwise import two assets and wonder why
  // (measured, on the first run of `check-heic.mjs`).
  await rm(source, { force: true });
  return target;
}

/**
 * Whether this machine can build one, and therefore run those tests.
 *
 * Asks for a HEIC **encoder**, not for `heif-enc`: the encoder is a plugin of
 * its own, and Ubuntu ships it apart from the program (`libheif-plugin-x265`).
 * Without it `heif-enc` runs, prints "No HEVC encoder available", and every
 * test that needs a HEIC failed instead of skipping (2026-11-17). A `heif-enc`
 * too old to list its encoders counts as unable.
 */
export async function canMakeHeic(): Promise<boolean> {
  const listing = await run("heif-enc", ["--list-encoders"]).then(
    ({ stdout }) => stdout,
    () => "",
  );
  return hasHeicEncoder(listing);
}

/**
 * Reads `heif-enc --list-encoders`: a heading per format, then one `- name`
 * line per encoder, so a heading followed straight by the next one is none.
 */
export function hasHeicEncoder(listing: string): boolean {
  const lines = listing.split("\n").map((line) => line.trim());
  const heading = lines.indexOf("HEIC encoders:");
  return heading !== -1 && lines[heading + 1]?.startsWith("- ") === true;
}
