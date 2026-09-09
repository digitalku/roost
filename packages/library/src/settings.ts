import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SORT, isSortKey, logger, type SortKey } from "@roost/core";

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
  /**
   * The order the grid is in, and which shuffle `random` means (ADR-0039).
   *
   * Here rather than in the window because a library is a kind of thing: a
   * folder of screenshots wants newest first and a folder of scans wants the
   * name, and being asked again on every open is the application forgetting
   * something it was told. It is **not** part of the query — a smart folder
   * stores query text, and a saved search whose meaning depended on a
   * preference would answer differently in two windows (ADR-0036's lesson).
   */
  readonly sortKey: SortKey;
  readonly sortDescending: boolean;
  /**
   * Which shuffle the random order is showing.
   *
   * Remembered, at the user's choosing on 2026-09-09, so that switching views
   * or reopening the library does not scramble a grid somebody was working
   * through. **Shuffle again** rolls it.
   */
  readonly shuffleSeed: number;
  /**
   * The view, its icon shape, and its zoom (ADR-0018, ADR-0039 §7).
   *
   * The three the view menu holds. ADR-0018 named them as belonging here on the
   * day the menu was built and could not put them here, because `settings.json`
   * did not exist until ADR-0036.
   *
   * `gridView` and `gridZoom` are the renderer's vocabulary, and this file
   * checks only their shape: a string for the view — the renderer refuses one
   * it does not know, because the list of views is a fact about the interface —
   * and a positive number for the zoom, which the renderer clamps to its own
   * steps. An engine that knew what "compact" is would be an engine holding a
   * copy of the interface.
   */
  readonly gridView: string;
  readonly matchImageProportions: boolean;
  readonly gridZoom: number;
}

/**
 * The zoom this file will believe, in CSS pixels of a grid cell.
 *
 * A guard rather than a vocabulary: the steps are the renderer's (`layout.ts`),
 * and a hand-edited `settings.json` should not be able to make a cell a
 * million pixels wide before anything clamps it.
 */
const ZOOM_RANGE = { min: 32, max: 1024 } as const;

export const DEFAULT_SETTINGS: Settings = {
  showSubfolderContents: false,
  fitVideoToWindow: false,
  sortKey: DEFAULT_SORT.key,
  sortDescending: DEFAULT_SORT.descending,
  shuffleSeed: DEFAULT_SORT.seed,
  gridView: "icons",
  matchImageProportions: true,
  gridZoom: 160,
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
    sortKey: sortKeyish(raw["sortKey"]),
    sortDescending: boolish(raw["sortDescending"], DEFAULT_SETTINGS.sortDescending),
    shuffleSeed: numberish(raw["shuffleSeed"], DEFAULT_SETTINGS.shuffleSeed, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }),
    gridView: typeof raw["gridView"] === "string" ? raw["gridView"] : DEFAULT_SETTINGS.gridView,
    matchImageProportions: boolish(
      raw["matchImageProportions"],
      DEFAULT_SETTINGS.matchImageProportions,
    ),
    gridZoom: numberish(raw["gridZoom"], DEFAULT_SETTINGS.gridZoom, ZOOM_RANGE),
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

/** One sort key, or the default where the file names one this build has retired. */
function sortKeyish(value: unknown): SortKey {
  return typeof value === "string" && isSortKey(value) ? value : DEFAULT_SETTINGS.sortKey;
}

/**
 * One number, clamped rather than rejected.
 *
 * A zoom a little outside the range is a build that changed its steps, and
 * falling back to the default there would throw away a preference over an
 * arithmetic detail. A value that is not a number at all is not a preference.
 */
function numberish(
  value: unknown,
  fallback: number,
  range: { readonly min: number; readonly max: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, range.min), range.max);
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
