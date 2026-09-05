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
  /**
   * `null` where a count would be a query nobody asked for.
   *
   * Trash is the exception, and the count is what makes it worth a row
   * (`UI_SPEC.md` §4.1): an empty trash and a trash holding four hundred assets
   * look identical without one, and the second is the state somebody needs to
   * be told about.
   */
  readonly count: number | null;
  /**
   * How many filled stars this row draws, or `null` for a row that is not a
   * rating.
   *
   * A number rather than a rendered label, because a glyph is a decision the
   * frontend makes: the CLI prints `3 stars`, and drawing three of something is
   * what a window does with the same fact. `0` is the unrated row, which is not
   * a rating of zero — the schema has no such value (`DATA_MODEL.md`).
   */
  readonly stars: number | null;
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
  /** One row per star, then unrated — six, always (`UI_SPEC.md` §4.1). */
  readonly ratings: PlaceEntry[];
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

  return {
    places: places(repo.trashedCount()),
    ratings: ratings(repo.ratingCounts()),
    folders,
    tags,
    smartFolders: repo.smartFolders(),
  };
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
 * "Trash" carries `is:trashed` and nothing else, because that is all it is: the
 * scoping in `@roost/search` hides trashed assets from every other query, and
 * naming the flag is what opts this one out (ADR-0022). It is a place rather
 * than a mode, so nothing in the grid, the toolbar, or the renderer has to
 * learn that Trash exists.
 *
 */
function places(trashed: number): PlaceEntry[] {
  const since = new Date((nowUnix() - RECENT_DAYS * 86_400) * 1000).toISOString().slice(0, 10);
  return [
    { id: "all", name: "All assets", query: "", count: null, stars: null },
    { id: "recent", name: "Recent", query: `imported:>${since}`, count: null, stars: null },
    { id: "favorites", name: "Favorites", query: "is:favorite", count: null, stars: null },
    { id: "untagged", name: "Untagged", query: "is:untagged", count: null, stars: null },
    { id: "trash", name: "Trash", query: "is:trashed", count: trashed, stars: null },
  ];
}

/**
 * A section of its own, under Places (`UI_SPEC.md` §4.1).
 *
 * **Each row matches one rating, not "this many and up".** Five nested rows
 * would have counts adding up to more than the library holds, and *how many
 * five-star assets are there* is the question a sidebar can answer at a glance.
 * `rating:>=4` is one term in the search field for the other question.
 *
 * They carry counts for the reason Trash does: the number is what makes the row
 * worth having. A star with none is still drawn — a row that appears and
 * vanishes with state nothing on screen shows is a row people misread — and it
 * says `0`.
 *
 * **Unrated is the sixth row, and it is not a rating of zero.** The schema has
 * no zero (`DATA_MODEL.md`): `NULL` is unrated, which is why the row carries
 * `is:unrated` rather than `rating:0`. It sits last because the five above it
 * are a scale and it is not on it — and it is the row that answers *what have I
 * not sorted yet*, which is the question a rating section is opened for.
 */
function ratings(counts: readonly { rating: number | null; count: number }[]): PlaceEntry[] {
  const counted = new Map(counts.map((row) => [row.rating, row.count]));
  const rated = [5, 4, 3, 2, 1].map((rating) => ({
    id: `rating-${rating}`,
    name: rating === 1 ? "1 star" : `${rating} stars`,
    query: `rating:${rating}`,
    count: counted.get(rating) ?? 0,
    stars: rating,
  }));
  return [
    ...rated,
    {
      id: "rating-none",
      name: "No stars",
      query: "is:unrated",
      count: counted.get(null) ?? 0,
      stars: 0,
    },
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
