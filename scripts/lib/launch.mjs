/**
 * What opening the window needs, wherever it is opened from.
 *
 * All three of these lived in `dev.mjs` until `pnpm start` stopped being a
 * shell one-liner (`SETUP.md` §4). A chain of `&&` in `package.json` cannot ask
 * what platform it is on, and Windows made the question worth asking twice:
 * here about a flag, and in `refresh.mjs` about an install.
 */
import { spawnSync } from "node:child_process";
import { linkSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";

/**
 * Electron's own binary, by absolute path.
 *
 * `require("electron")` answers the path rather than the module, and fetches
 * the binary when it is missing — which is what makes the first launch after an
 * install that skipped build scripts work at all (`SETUP.md` §1).
 */
export function electronBinary() {
  const binary = createRequire(import.meta.url)("electron");
  if (typeof binary !== "string") {
    // What `ELECTRON_SKIP_BINARY_DOWNLOAD` leaves behind: the package is
    // present and the binary it points at is not.
    console.error(
      "electron is installed without its binary; run `pnpm install` without skipping it",
    );
    process.exit(1);
  }
  return binary;
}

/**
 * Electron's binary under Roost's own name: `roost` beside `electron` in the
 * same `dist`, hard-linked, so the system monitor lists every process of the
 * window as `roost` rather than `electron`.
 *
 * Measured, both ways. A symlink named `roost` changes nothing, because
 * Electron re-executes itself by its resolved path and every child takes the
 * name of that; a hard link is a file of its own name, and the main process,
 * the zygotes, the GPU process, the renderer and the engine all carry it. It
 * has to sit in `dist`, where Electron looks for its resources beside the
 * executable, and costs no space there. Packaging names the binary itself and
 * retires this (M6).
 *
 * Checked on every call rather than trusted: an install replaces `dist`, and a
 * link left from before it is the previous Electron. Where the link cannot be
 * made or replaced — a running `roost.exe` cannot be deleted on Windows — the
 * window opens as `electron`, which is a name and not a failure.
 */
export function roostBinary() {
  return linkAs(electronBinary(), "roost");
}

/** `binary` hard-linked as `name` in its own directory, or `binary` itself. */
export function linkAs(binary, name) {
  const link = join(dirname(binary), name + extname(binary));
  try {
    const target = statSync(binary, { bigint: true });
    const existing = statSync(link, { bigint: true, throwIfNoEntry: false });
    if (existing?.ino === target.ino && existing.dev === target.dev) return link;
    if (existing !== undefined) unlinkSync(link);
    linkSync(binary, link);
    return link;
  } catch (error) {
    console.warn(`could not name the window's binary ${name}: ${error.message}`);
    return binary;
  }
}

/**
 * Linux only. Without it the window is XWayland on a Wayland session: blurry on
 * a HiDPI screen and wrong under fractional scaling, which reads as a rendering
 * bug and is not one (`TODO.md` §2). Chromium ignores an unknown switch rather
 * than refusing it, so passing this everywhere would work — and would leave a
 * flag in the command line that means nothing on the platform it was passed on.
 */
export const ozone = process.platform === "linux" ? ["--ozone-platform-hint=auto"] : [];

/**
 * The commit the About dialog names (ADR-0038 §5.1).
 *
 * Empty when git cannot answer — a tarball, or no git at all. Main turns that
 * into "no commit" and the dialog says only the version, which is better than
 * a build claiming to be one it is not.
 */
export function commit() {
  const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  return git.status === 0 ? git.stdout.trim() : "";
}
