import {
  type Cursor,
  DEFAULT_PAGE_LIMIT,
  type Filter,
  type FolderRow,
  lastCursor,
  logger,
  MATCH_ALL,
  type Page,
  type SearchHit,
} from "@roost/core";
import { buildQuery, type Folders } from "@roost/search";
import { childrenById, descendants } from "./folder-tree.js";
import type { Library } from "./library.js";

/**
 * Running an RQL query against a library.
 *
 * Supplies the one thing the compiler cannot know on its own — which folders a
 * path names — and then hands the compiled filter to the repository, which owns
 * the statement around it (invariant 3).
 */

const log = logger("search");

/**
 * Resolves folder paths against a library's folder tree.
 *
 * Falls back to matching a bare name anywhere in the tree, so `folder:Icons`
 * finds the folder someone has in mind without making them type
 * `Design/Brand/Icons`. An exact path always wins, so the fallback can only
 * broaden a query that found nothing.
 */
class LibraryFolders implements Folders {
  readonly #library: Library;

  constructor(library: Library) {
    this.#library = library;
  }

  subtree(path: string): number[] {
    const segments = path
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment !== "");

    const [only] = segments;
    if (only === undefined) return [];

    const repo = this.#library.db.repo;
    const rows = repo.folders();

    const exact = repo.findFolderByPath(segments);
    let roots: number[] = exact === undefined ? [] : [exact];

    if (roots.length === 0 && segments.length === 1) {
      const wanted = foldAscii(only);
      roots = rows.filter((row) => foldAscii(row.name) === wanted).map((row) => row.id);
    }

    return descendants(childrenById(rows), roots);
  }
}

/**
 * ASCII-only case folding, deliberately.
 *
 * SQLite's `COLLATE NOCASE` folds ASCII and nothing else, and the Rust build's
 * fallback is `eq_ignore_ascii_case`. Folding the whole of Unicode here would
 * make `folder:CAFÉ` reach a folder that `tag:CAFÉ` could not, and would make
 * the two implementations disagree about one query.
 */
function foldAscii(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Compiles `query` against this library's folder tree. */
export function compileFor(library: Library, query: string): Filter {
  const filter = buildQuery(query, new LibraryFolders(library));
  // The query text and the SQL it became are the two things needed to
  // reproduce a wrong result. Bound values are counted rather than listed:
  // they are already in the query text, and repeating them doubles the line.
  log.debug("query compiled", { query, sql: filter.sql, params: filter.params.length });
  return filter;
}

/** One page of results for `query`, newest first. */
export function search(library: Library, query: string, page: Page): SearchHit[] {
  return library.db.repo.search(compileFor(library, query), page);
}

/** How many assets `query` matches. */
export function count(library: Library, query: string): number {
  return library.db.repo.count(compileFor(library, query));
}

/**
 * One page of every asset, newest first.
 *
 * Not `search(library, "*", page)`: RQL has no match-everything term, and an
 * empty query is an error rather than a wildcard — a typo that compiles to the
 * whole library is worse than one that fails. An unfiltered grid is a listing
 * rather than a search, so it asks for {@link MATCH_ALL} directly.
 */
export function list(library: Library, page: Page): SearchHit[] {
  return library.db.repo.search(MATCH_ALL, page);
}

/**
 * One page of the grid, where an empty `query` means the whole library.
 *
 * The dispatch belongs here rather than in each frontend: a grid is addressed
 * by one string that is either RQL or nothing, and two callers deciding
 * separately what nothing means is how they come to disagree.
 */
export function pageOf(library: Library, query: string, page: Page): SearchHit[] {
  return query.trim() === "" ? list(library, page) : search(library, query, page);
}

/** How many assets that same string matches. */
export function matches(library: Library, query: string): number {
  return query.trim() === "" ? library.db.repo.count(MATCH_ALL) : count(library, query);
}

/**
 * Every result, a page at a time.
 *
 * A generator rather than a callback, so a caller can stop by breaking out of
 * the loop. Never loads the whole answer into memory: each page is fetched from
 * the cursor the last one ended on, never from an offset.
 */
export function* pages(
  library: Library,
  query: string,
  pageSize: number = DEFAULT_PAGE_LIMIT,
): Generator<SearchHit[]> {
  const filter = query.trim() === "" ? MATCH_ALL : compileFor(library, query);
  const repo = library.db.repo;
  let after: Cursor | undefined;

  for (;;) {
    // `after` is spread rather than assigned, because `exactOptionalPropertyTypes`
    // makes an explicit `after: undefined` a different thing from an absent one.
    const hits = repo.search(filter, { limit: pageSize, ...(after && { after }) });
    if (hits.length === 0) return;
    yield hits;
    // A short page is the last page: asking again would cost a statement to
    // learn what the row count already said.
    if (hits.length < pageSize) return;
    after = lastCursor(hits);
  }
}
