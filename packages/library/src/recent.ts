import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger, stateDir } from "@roost/core";
import { MANIFEST_FILE } from "./manifest.js";

/**
 * The libraries this machine has opened, most recent first.
 *
 * **Application state, not library state.** ADR-0019 puts settings inside the
 * library by default; this is one of the three things that cannot follow that
 * rule, and its reason is the plainest of them — the list is what *finds* a
 * library, so it cannot live inside one. `stateDir()` names it already, in the
 * doc comment describing what belongs there.
 *
 * Nothing here is load-bearing. A missing file, a truncated one, a machine
 * where `$XDG_STATE_HOME` is not writable: each means the picker offers
 * "Open library…" and nothing else, which is exactly where this application
 * was before the list existed. **No failure in this module may stop a library
 * from opening.**
 */

const log = logger("recent");

/** The file, under `stateDir()`. */
export const RECENT_FILE = "recent.json";

/**
 * How many unpinned libraries are kept.
 *
 * A limit rather than a scroll: this list exists to get somebody back into work
 * they were doing, and the twelfth-most-recent library is not that. Pinned
 * entries are never evicted, so a person who wants a permanent one says so.
 */
export const RECENT_LIMIT = 12;

/** What is remembered about a library between runs. */
export interface RecentLibrary {
  /** The canonical path — resolved, so a symlink and its target are one entry. */
  readonly root: string;
  readonly name: string;
  /** `library.json`'s id, so a moved library can still be recognised. */
  readonly id: string;
  /** Unix seconds. */
  readonly openedAt: number;
  readonly pinned: boolean;
}

/** A remembered library, plus whether it is still there. */
export interface RecentEntry extends RecentLibrary {
  /**
   * Whether the directory still holds a `library.json`.
   *
   * Checked every time the list is drawn rather than stored, because the answer
   * changes without this application being involved — a user moves a folder, or
   * unplugs the drive it was on. An entry that is gone is **shown and marked**,
   * not hidden: silently dropping it looks like the application forgot, and the
   * person is left wondering whether they imagined opening it.
   */
  readonly available: boolean;
}

/** Where the file is. Creates nothing. */
export function recentPath(): string {
  return join(stateDir(), RECENT_FILE);
}

/**
 * The list, with each entry checked against the filesystem.
 *
 * Ordered pinned-first, then most recently opened. Never throws.
 */
export async function listRecent(): Promise<RecentEntry[]> {
  const remembered = await readRecent();
  const checked = await Promise.all(
    remembered.map(async (entry) => ({ ...entry, available: await isLibrary(entry.root) })),
  );
  return checked;
}

/**
 * Records that `root` was opened, moving it to the front.
 *
 * Called from the one place a library becomes the open one, so that opening by
 * dialog, by recent entry, and by creation all record identically.
 *
 * Swallows every failure: this is bookkeeping that runs *after* a library is
 * open, and a window that refused to show a library because a state file could
 * not be written would be trading the thing for the note about the thing.
 */
export async function rememberLibrary(library: {
  readonly root: string;
  readonly name: string;
  readonly id: string;
}): Promise<void> {
  try {
    const root = await canonical(library.root);
    const existing = await readRecent();
    const previous = existing.find((entry) => entry.root === root);

    const entry: RecentLibrary = {
      root,
      name: library.name,
      id: library.id,
      openedAt: Math.floor(Date.now() / 1000),
      // Pinning survives being opened again. It is the user's mark, not a
      // property of this visit.
      pinned: previous?.pinned ?? false,
    };

    await write([entry, ...existing.filter((other) => other.root !== root)]);
  } catch (cause) {
    log.warn("could not record a recently opened library", { reason: String(cause) });
  }
}

/** Drops one entry, pinned or not, and returns what is left. */
export async function forgetLibrary(root: string): Promise<RecentEntry[]> {
  const existing = await readRecent();
  await write(existing.filter((entry) => entry.root !== root));
  return listRecent();
}

/** Pins or unpins one entry, and returns the new list. */
export async function pinLibrary(root: string, pinned: boolean): Promise<RecentEntry[]> {
  const existing = await readRecent();
  await write(existing.map((entry) => (entry.root === root ? { ...entry, pinned } : entry)));
  return listRecent();
}

/**
 * Reads and validates the file.
 *
 * A damaged file is not an error and not a reason to refuse: it returns an
 * empty list, and the next write replaces it. Individual entries are dropped
 * one at a time rather than discarding the file, so one bad row written by a
 * future build does not cost the other eleven.
 */
async function readRecent(): Promise<RecentLibrary[]> {
  let text: string;
  try {
    text = await readFile(recentPath(), "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log.warn("the recent-libraries file is not valid JSON; starting a new one");
    return [];
  }

  if (typeof parsed !== "object" || parsed === null) return [];
  const rows = (parsed as Record<string, unknown>)["libraries"];
  if (!Array.isArray(rows)) return [];

  const entries: RecentLibrary[] = [];
  for (const row of rows) {
    const entry = readEntry(row);
    if (entry !== undefined) entries.push(entry);
  }
  return sorted(entries);
}

function readEntry(row: unknown): RecentLibrary | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const raw = row as Record<string, unknown>;
  const root = raw["root"];
  const name = raw["name"];
  const id = raw["id"];
  const openedAt = raw["openedAt"];
  if (typeof root !== "string" || root === "") return undefined;
  if (typeof name !== "string" || typeof id !== "string") return undefined;
  if (typeof openedAt !== "number" || !Number.isFinite(openedAt)) return undefined;
  return { root, name, id, openedAt, pinned: raw["pinned"] === true };
}

/** Pinned first, then newest. The tie-break is the path, so the order is total. */
function sorted(entries: readonly RecentLibrary[]): RecentLibrary[] {
  return [...entries].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    if (left.openedAt !== right.openedAt) return right.openedAt - left.openedAt;
    return left.root.localeCompare(right.root);
  });
}

/**
 * Replaces the file, keeping at most {@link RECENT_LIMIT} unpinned entries.
 *
 * Written to a neighbouring file and renamed over the target, because `rename`
 * within one directory is atomic: a crash leaves either the old list or the new
 * one, never half of either. `writeFile` on the target directly can truncate it
 * and then fail to fill it.
 */
async function write(entries: readonly RecentLibrary[]): Promise<void> {
  const ordered = sorted(entries);
  // The limit counts unpinned entries only, so pinning twelve libraries does
  // not push the one opened a minute ago off the list.
  const kept = sorted([
    ...ordered.filter((entry) => entry.pinned),
    ...ordered.filter((entry) => !entry.pinned).slice(0, RECENT_LIMIT),
  ]);

  const path = recentPath();
  const temporary = `${path}.tmp`;
  await mkdir(stateDir(), { recursive: true });
  const body = JSON.stringify({ version: 1, libraries: kept }, null, 2);
  await writeFile(temporary, `${body}\n`, "utf8");
  try {
    await rename(temporary, path);
  } catch (cause) {
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
}

/** Whether a directory still holds a library. */
async function isLibrary(root: string): Promise<boolean> {
  try {
    return (await stat(join(root, MANIFEST_FILE))).isFile();
  } catch {
    return false;
  }
}

/**
 * The canonical path, matching what `lockPathFor` does for the same reason: two
 * routes to one library — a symlink, a relative path, a bind mount — must not
 * become two entries. Falls back to the given path when it cannot be resolved.
 */
async function canonical(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return root;
  }
}
