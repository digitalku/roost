import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@roost/core";

/**
 * Per-library preferences (ADR-0019).
 *
 * `settings.json` sits beside `library.json` and holds everything that
 * describes *this* library, so it travels when the folder is copied. It is
 * **not journalled and `rebuild` does not touch it**: a preference is not
 * library data, so invariant 9 does not reach it and invariant 1's promise
 * about the index is unaffected. A rebuild that reset somebody's preferences
 * would read as data loss even though nothing was lost.
 *
 * Nothing here may throw. ADR-0019 states three rules and they are the whole
 * design of this file:
 *
 * - **Every read tolerates absence and damage.** A missing file, unparseable
 *   JSON, an unknown key from a newer build, or a key with the wrong type each
 *   falls back to the default for that one setting rather than discarding the
 *   file or refusing the library.
 * - **Every write tolerates failure.** A library on read-only media or a
 *   network share that has gone away must not produce an error dialog when
 *   somebody changes a checkbox.
 * - **Unknown keys are preserved on write**, so a newer build's settings
 *   survive being opened by an older one — the same reason an unknown journal
 *   op is skipped rather than dropped.
 */

const log = logger("settings");

/** `settings.json` — preferences. May be absent, may be hand-edited. */
export const SETTINGS_FILE = "settings.json";

export interface Settings {
  /**
   * Whether opening a folder shows what is in its subfolders (ADR-0036).
   *
   * It decides which term the sidebar writes for a folder row — `folder:` when
   * on, `infolder:` when off — and **not** what either term means. A query
   * saved months ago therefore asks the same question forever, which is what
   * makes this safe to put in a smart folder later.
   *
   * Off by default, at the user's choosing on 2026-09-08: a folder shows its
   * own contents, as a file manager's does.
   */
  readonly showSubfolderContents: boolean;
  /**
   * Whether the preview scales a video up to the pane (ADR-0024 §8).
   *
   * Off by default, at the user's choosing on 2026-09-08: a video is fitted to
   * the pane but never blown up, so a low-resolution clip keeps its own pixels
   * until somebody says otherwise. Remembered here rather than per asset
   * because it is an answer about eyesight and screens, not about one file.
   */
  readonly fitVideoToWindow: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  showSubfolderContents: false,
  fitVideoToWindow: false,
};

/**
 * Reads `settings.json`, falling back per key.
 *
 * The application default is the floor and the library setting is laid over it
 * (ADR-0019, "resolution order"), so a library that has never been opened by
 * this build inherits the defaults and has nothing written for it.
 */
export async function readSettings(root: string): Promise<Settings> {
  const raw = await readRaw(root);
  return {
    showSubfolderContents: boolish(
      raw["showSubfolderContents"],
      DEFAULT_SETTINGS.showSubfolderContents,
    ),
    fitVideoToWindow: boolish(raw["fitVideoToWindow"], DEFAULT_SETTINGS.fitVideoToWindow),
  };
}

/**
 * Writes `patch` over what is on disk, keeping every key this build does not
 * know about.
 *
 * Returns whether it reached the disk. A `false` is not an error and has no
 * message: the caller keeps the value in memory for the session, which is the
 * correct outcome for a library nobody can write to.
 */
export async function writeSettings(root: string, patch: Partial<Settings>): Promise<boolean> {
  const raw = await readRaw(root);
  const next = { ...raw, ...patch };
  try {
    await writeFile(join(root, SETTINGS_FILE), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return true;
  } catch (cause) {
    // Deliberately swallowed. See the rule above: changing a preference on a
    // library that cannot be written to is not a failure worth a dialog.
    log.debug("settings not written", { root, error: String(cause) });
    return false;
  }
}

/** Whatever is in the file, as an object. Never throws, never rejects. */
async function readRaw(root: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(join(root, SETTINGS_FILE), "utf8");
  } catch {
    // Absent is the ordinary case, not an exception: a library that has never
    // had a preference changed has no file.
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    log.warn("settings.json is not readable JSON; falling back to defaults", { root });
    return {};
  }
}

/** One boolean key, or its default where the file says something else. */
function boolish(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
