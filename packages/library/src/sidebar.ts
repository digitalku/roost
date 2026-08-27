import type { FolderRow } from "@roost/core";
import { quoteValue } from "@roost/search";
import { childrenById, descendants } from "./folder-tree.js";
import { type Library, nowUnix } from "./library.js";

/**
 * Everything a navigation pane shows, in one read.
 *
 * Assembled here rather than in each frontend for two reasons. The counts and
 * the folder tree come from three statements that only make sense together —
 * and, less obviously, **each entry carries the RQL query that selects it**. A
 * frontend building `tag:Some Name` by concatenation would be a second, worse
 * implementation of the grammar; `quoteValue` is the one that exists.
 */

/**
 * A fixed row at the top of the navigation pane.
 *
 * These carry a query like every other row, for the same reason: the renderer
 * never assembles RQL. "All assets" carries the empty string, which is the
 * engine's word for the whole library rather than a term in the grammar.
 */
export interface PlaceEntry {
  readonly id: string;
  readonly name: string;
  readonly query: string;
}

export interface FolderEntry {
  readonly id: number;
  readonly parentId: number | null;
  readonly name: string;
  /** Slash-separated path from the root, which is what `folder:` matches. */
  readonly path: string;
  /** The query selecting this folder and everything beneath it. */
  readonly query: string;
  /** Assets in this folder and its descendants. */
  readonly count: number;
}

export interface TagEntry {
  readonly name: string;
  /** `null` for a tag in no group; a sidebar shows those last. */
  readonly group: string | null;
  readonly query: string;
  readonly count: number;
}

export interface SmartFolderEntry {
  readonly id: number;
  readonly parentId: number | null;
  readonly name: string;
  /** The saved query itself, which is the whole point of a smart folder. */
  readonly query: string;
}

export interface Sidebar {
  readonly places: PlaceEntry[];
  readonly folders: FolderEntry[];
  readonly tags: TagEntry[];
  readonly smartFolders: SmartFolderEntry[];
}

/** One snapshot of the navigation tree. */
export function readSidebar(library: Library): Sidebar {
  const repo = library.db.repo;
  const rows = repo.folders();
  const direct = repo.folderCounts();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const children = childrenById(rows);

  const folders = rows.map((row) => {
    const path = pathOf(byId, row);
    return {
      id: row.id,
      parentId: row.parentId,
      name: row.name,
      path,
      query: `folder:${quoteValue(path)}`,
      count: subtreeCount(children, direct, row.id),
    };
  });

  const tags = repo.tags().map((tag) => ({
    name: tag.name,
    group: tag.group,
    query: `tag:${quoteValue(tag.name)}`,
    count: tag.count,
  }));

  return { places: places(), folders, tags, smartFolders: repo.smartFolders() };
}

/** How far back "Recent" reaches, in days (`UI_SPEC.md` §4.1). */
const RECENT_DAYS = 7;

/**
 * The fixed rows.
 *
 * "Recent" is a **date computed here**, not a relative term in the grammar.
 * RQL has no `imported:>7d`, and adding one would be a grammar change — the
 * grammar is frozen by cross-implementation compatibility (`CONCEPT.md` §1.1),
 * so a query that says the same thing in both implementations is the one to
 * send. The consequence is that the query goes stale at midnight UTC; the
 * sidebar is re-read whenever the library changes, and a day-old boundary on a
 * seven-day window is not a wrong answer.
 *
 * "Trash" is absent until M6, because a row that filters nothing is worse than
 * no row.
 */
function places(): PlaceEntry[] {
  const since = new Date((nowUnix() - RECENT_DAYS * 86_400) * 1000).toISOString().slice(0, 10);
  return [
    { id: "all", name: "All assets", query: "" },
    { id: "recent", name: "Recent", query: `imported:>${since}` },
    { id: "favorites", name: "Favorites", query: "is:favorite" },
    { id: "untagged", name: "Untagged", query: "is:untagged" },
  ];
}

/** Depth past which a folder path is treated as corrupt rather than deep. */
const MAX_PATH_DEPTH = 64;

/**
 * `Design/Brand/Icons` for a folder called `Icons`.
 *
 * A cycle is corruption rather than a shape the editing commands can produce,
 * but the depth bound means a corrupt row costs a truncated path instead of a
 * hang.
 */
function pathOf(byId: ReadonlyMap<number, FolderRow>, row: FolderRow): string {
  const segments = [row.name];
  let current = row.parentId;
  for (let depth = 0; depth < MAX_PATH_DEPTH && current !== null; depth += 1) {
    const parent = byId.get(current);
    if (parent === undefined) break;
    segments.push(parent.name);
    current = parent.parentId;
  }
  return segments.reverse().join("/");
}

/**
 * Assets in a folder and everything under it.
 *
 * `folder:` matches the subtree, so a count that did not would contradict the
 * query sitting beside it in the same row.
 */
function subtreeCount(
  children: ReadonlyMap<number, readonly number[]>,
  direct: ReadonlyMap<number, number>,
  root: number,
): number {
  let total = 0;
  for (const id of descendants(children, [root])) total += direct.get(id) ?? 0;
  return total;
}
