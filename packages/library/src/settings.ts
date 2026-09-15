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
   * How loud the player is, and whether it is silenced (ADR-0024 §9).
   *
   * A **whole percent, 0–100**, rather than the element's own 0–1: the slider
   * is drawn in percent, the keyboard moves it in percent, and a preference
   * that reads `80` in a file somebody may open by hand is worth more than the
   * eleventh decimal place of a float.
   *
   * Muting is remembered with it, at the user's choosing on 2026-09-10.
   * Remembering the volume alone would give back a player that is at 30% and
   * audible when it was left silent, which is the same surprise this exists to
   * remove — pointing the other way.
   */
  readonly mediaVolume: number;
  readonly mediaMuted: boolean;
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
  /**
   * Whether the grid draws the folders inside the folder on screen (ADR-0043).
   *
   * On by default: it is what a file manager does, and it is what was asked
   * for. Only the window knows when there is anything to draw — the tiles
   * appear where a query is one folder's own contents and nowhere else — so
   * this file holds the preference and makes no claim about when it applies.
   */
  readonly showFolders: boolean;
  /**
   * Whether the sidebar and the inspector are drawn (ADR-0028 §6).
   *
   * Here rather than in the window for the reason the view is: a library is a
   * kind of thing, and the arrangement that suits a folder of scans is not the
   * one that suits the library everything lands in. Both default to on, so a
   * library nobody has hidden a pane in opens as every build before this drew
   * it.
   */
  readonly showSidebar: boolean;
  readonly showInspector: boolean;
  /**
   * How wide each of them is, in CSS pixels (`UI_SPEC.md` §1).
   *
   * The bounds are the spec's and they are enforced here as well as in the
   * window, for the reason the zoom's are: this file reads whatever somebody
   * typed into `settings.json`, and a column two pixels wide has no edge left
   * to grab.
   */
  readonly sidebarWidth: number;
  readonly inspectorWidth: number;
}

/**
 * The zoom this file will believe, in CSS pixels of a grid cell.
 *
 * A guard rather than a vocabulary: the steps are the renderer's (`layout.ts`),
 * and a hand-edited `settings.json` should not be able to make a cell a
 * million pixels wide before anything clamps it.
 */
const ZOOM_RANGE = { min: 32, max: 1024 } as const;

/** Percent. Clamped rather than rejected, for the same reason the zoom is. */
const VOLUME_RANGE = { min: 0, max: 100 } as const;

/** What each side pane may be dragged to, in CSS pixels (`UI_SPEC.md` §1). */
const SIDEBAR_RANGE = { min: 220, max: 420 } as const;
const INSPECTOR_RANGE = { min: 280, max: 480 } as const;

export const DEFAULT_SETTINGS: Settings = {
  showSubfolderContents: false,
  fitVideoToWindow: false,
  // Full, which is where a media element starts on its own: a library nobody
  // has touched the volume in behaves exactly as it did before this existed.
  mediaVolume: 100,
  mediaMuted: false,
  sortKey: DEFAULT_SORT.key,
  sortDescending: DEFAULT_SORT.descending,
  shuffleSeed: DEFAULT_SORT.seed,
  gridView: "icons",
  matchImageProportions: true,
  gridZoom: 160,
  showFolders: true,
  showSidebar: true,
  showInspector: true,
  sidebarWidth: 240,
  inspectorWidth: 280,
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
    mediaVolume: numberish(raw["mediaVolume"], DEFAULT_SETTINGS.mediaVolume, VOLUME_RANGE),
    mediaMuted: boolish(raw["mediaMuted"], DEFAULT_SETTINGS.mediaMuted),
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
    showFolders: boolish(raw["showFolders"], DEFAULT_SETTINGS.showFolders),
    showSidebar: boolish(raw["showSidebar"], DEFAULT_SETTINGS.showSidebar),
    showInspector: boolish(raw["showInspector"], DEFAULT_SETTINGS.showInspector),
    sidebarWidth: numberish(raw["sidebarWidth"], DEFAULT_SETTINGS.sidebarWidth, SIDEBAR_RANGE),
    inspectorWidth: numberish(
      raw["inspectorWidth"],
      DEFAULT_SETTINGS.inspectorWidth,
      INSPECTOR_RANGE,
    ),
  };
}

/**
 * The write in flight for each library, so the next one waits for it.
 *
 * A write is read-modify-write — it has to be, because ADR-0019 keeps the keys
 * this build does not know — and two of them started together lose one: the
 * second reads the file before the first has written it, and then writes that
 * older object back over it. **The state in memory stays right, so nothing on
 * screen says anything is wrong** and the setting comes back missing at the
 * next open. Found on 2026-09-13 by `check-panes.mjs`, pressing `F9` and `F4`
 * one after the other.
 *
 * Per library rather than one queue, and per process: a second window is a
 * second engine, and nothing here pretends to make the file safe between two
 * of them. What it removes is the race one window can lose on its own.
 */
const writing = new Map<string, Promise<boolean>>();

/**
 * Writes `patch` over what is on disk, keeping every key this build does not
 * know about.
 *
 * Returns whether it reached the disk. A `false` is not an error and has no
 * message: the caller keeps the value in memory for the session, which is the
 * correct outcome for a library nobody can write to.
 */
export async function writeSettings(root: string, patch: Partial<Settings>): Promise<boolean> {
  // `write` never rejects, so the chain needs no catch to stay unbroken.
  const mine = (writing.get(root) ?? Promise.resolve(true)).then(() => write(root, patch));
  writing.set(root, mine);
  const reached = await mine;
  // Only the last one clears it, or a write still queued behind this one would
  // be forgotten and start a second chain.
  if (writing.get(root) === mine) writing.delete(root);
  return reached;
}

/** One read-modify-write. Never throws. */
async function write(root: string, patch: Partial<Settings>): Promise<boolean> {
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
