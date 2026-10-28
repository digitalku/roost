import {
  type Cursor,
  DEFAULT_PAGE_LIMIT,
  DEFAULT_SORT,
  type Filter,
  type FolderRow,
  lastCursor,
  logger,
  MATCH_LIVE,
  type Page,
  type SearchHit,
  type Sort,
} from "@roost/core";
import { buildQuery, type Folders, folderSearch, subfolderSections } from "@roost/search";
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
 *
 * Two depths over one resolution (ADR-0036): `folder:` descends and `infolder:`
 * does not, and both name the same place.
 */
export class LibraryFolders implements Folders {
  readonly #library: Library;

  constructor(library: Library) {
    this.#library = library;
  }

  subtree(path: string): number[] {
    const rows = this.#library.db.repo.folders();
    return descendants(childrenById(rows), this.#roots(path, rows));
  }

  only(path: string): number[] {
    return this.#roots(path, this.#library.db.repo.folders());
  }

  /**
   * The folders a path names, before any descent.
   *
   * Shared by both terms so they can disagree about depth and about nothing
   * else: an exact path wins, and a bare name falls back to every folder so
   * named. The fallback is what makes `infolder:Icons` mean the same *place* as
   * `folder:Icons`, one level shallower.
   */
  #roots(path: string, rows: readonly FolderRow[]): number[] {
    const segments = path
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment !== "");

    const [first] = segments;
    if (first === undefined) return [];

    const exact = this.#library.db.repo.findFolderByPath(segments);
    if (exact !== undefined) return [exact];

    if (segments.length > 1) return [];
    const wanted = foldAscii(first);
    return rows.filter((row) => foldAscii(row.name) === wanted).map((row) => row.id);
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

/**
 * The folders a typed search finds by name, or `null` when the query is not a
 * search a folder can answer (ADR-0057).
 *
 * A folder is found when **every word starts a word of its name**, as an
 * asset's name is matched: `highl` finds the folder *highlights* and the file,
 * and `"highl"` in quotes finds neither (ADR-0057 §7). Words typed inside a
 * folder look through everything beneath it, and not at the folder itself,
 * which is the place rather than a result.
 *
 * Ids, in no promised order: the window draws them in its own tree's order.
 */
export function findFolders(library: Library, query: string): number[] | null {
  const wanted = folderSearch(query);
  if (wanted === undefined) return null;

  const phrases = wanted.words.map((word) => ({ words: wordsOf(word.value), exact: word.exact }));
  // A word with nothing in it to match, `--` say, finds no asset either.
  if (phrases.some((phrase) => phrase.words.length === 0)) return [];

  const rows = library.db.repo.folders();
  let candidates: readonly FolderRow[] = rows;
  if (wanted.within !== null) {
    const roots = new LibraryFolders(library).only(wanted.within);
    const beneath = new Set(descendants(childrenById(rows), roots));
    for (const root of roots) beneath.delete(root);
    candidates = rows.filter((row) => beneath.has(row.id));
  }

  return candidates
    .filter((row) => {
      const name = wordsOf(row.name);
      return phrases.every((phrase) => holds(name, phrase));
    })
    .map((row) => row.id);
}

/**
 * Text split into words the way the full-text index splits an asset's name.
 *
 * `assets_fts` uses FTS5's `unicode61` tokenizer: a word is a run of letters
 * and digits, case is folded, and diacritics are removed, so `Café` and `cafe`
 * are one word and `IMG_2024` is two. A folder's name is not in that index —
 * it is a handful of rows in memory — so this is the same rule written again,
 * and the rule is what has to agree, or a word would find the file and not the
 * folder beside it.
 */
function wordsOf(text: string): string[] {
  return (
    text
      .normalize("NFC")
      // Only a Latin letter loses its marks, as `remove_diacritics` does. A mark
      // anywhere else is left in place, where it parts two words as it does in
      // the index.
      .replace(/\p{Script=Latin}/gu, (letter) => letter.normalize("NFD").replace(/\p{M}/gu, ""))
      .toLowerCase()
      .match(/[\p{L}\p{N}\p{Co}]+/gu) ?? []
  );
}

/**
 * Whether `phrase` appears in `words` as a run, which is what a phrase match is.
 *
 * Unless it is exact, the run's last word need only start the word it meets,
 * as FTS5 reads `"..."*`: the earlier words of a prefix phrase stay whole.
 */
function holds(
  words: readonly string[],
  phrase: { readonly words: readonly string[]; readonly exact: boolean },
): boolean {
  const last = phrase.words.length - 1;
  const meets = (word: string, wanted: string, at: number): boolean =>
    at === last && !phrase.exact ? word.startsWith(wanted) : word === wanted;
  for (let start = 0; start + phrase.words.length <= words.length; start += 1) {
    if (phrase.words.every((wanted, at) => meets(words[start + at] ?? "", wanted, at))) return true;
  }
  return false;
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

/** One page of results for `query`, in the order `page` asks for. */
export function search(library: Library, query: string, page: Page): SearchHit[] {
  return library.db.repo.search(compileFor(library, query), page);
}

/** How many assets `query` matches. */
export function count(library: Library, query: string): number {
  return library.db.repo.count(compileFor(library, query));
}

/**
 * One page of every asset that is not in the trash, newest first.
 *
 * Not `search(library, "*", page)`: RQL has no match-everything term, and an
 * empty query is an error rather than a wildcard — a typo that compiles to the
 * whole library is worse than one that fails. An unfiltered grid is a listing
 * rather than a search, so it asks for {@link MATCH_LIVE} directly.
 *
 * `MATCH_LIVE` rather than `MATCH_ALL` because this is the *view* of a library
 * and a trashed asset is not in it (ADR-0022). Every query that goes through
 * the compiler is scoped the same way, in `@roost/search`; this listing is the
 * one read that never reaches it, so it carries the predicate itself.
 */
export function list(library: Library, page: Page): SearchHit[] {
  return library.db.repo.search(MATCH_LIVE, page);
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
  return query.trim() === "" ? library.db.repo.count(MATCH_LIVE) : count(library, query);
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
  sort: Sort = DEFAULT_SORT,
): Generator<SearchHit[]> {
  const filter = query.trim() === "" ? MATCH_LIVE : compileFor(library, query);
  const repo = library.db.repo;
  let after: Cursor | undefined;

  for (;;) {
    // `after` is spread rather than assigned, because `exactOptionalPropertyTypes`
    // makes an explicit `after: undefined` a different thing from an absent one.
    const hits = repo.search(filter, { limit: pageSize, sort, ...(after && { after }) });
    if (hits.length === 0) return;
    yield hits;
    // A short page is the last page: asking again would cost a statement to
    // learn what the row count already said.
    if (hits.length < pageSize) return;
    after = lastCursor(hits);
  }
}

/** Which part of a sectioned listing a page resumes in (ADR-0059). */
export type Section = "own" | "beneath";

/** One page of a listing that may be drawn in two parts (ADR-0059). */
export interface SectionedPage {
  readonly hits: SearchHit[];
  /** The part the page's last row belongs to, which is where the next one resumes. */
  readonly section: Section;
  /**
   * Where the assets beneath the folder begin on this page, and how many of
   * them there are in all — on the one page where they begin, and `null` on
   * every other.
   */
  readonly beneath: { readonly at: number; readonly count: number } | null;
}

/**
 * One page of the grid, a folder's own assets before its subfolders' (ADR-0059).
 *
 * A query that shows a folder with its subfolders is listed as two ordinary
 * queries in turn: the folder's own assets, then the rest of the subtree. Each
 * is paged by the index its order already has (ADR-0039), and a cursor names
 * which of the two it belongs to. Where the first runs out, the same page goes
 * on into the second, so a short page still means the last one. Any other query
 * is one part, and this is {@link pageOf}.
 */
export function sectionedPage(
  library: Library,
  query: string,
  page: Page,
  section: Section = "own",
): SectionedPage {
  const parts = subfolderSections(query);
  if (parts === undefined) return { hits: pageOf(library, query, page), section, beneath: null };
  if (section === "beneath") {
    return { hits: search(library, parts.beneath, page), section, beneath: null };
  }

  const own = search(library, parts.own, page);
  if (own.length === page.limit) return { hits: own, section: "own", beneath: null };

  // The folder's own have run out on this page, so the rest begin here — from
  // their own first row, which is why the cursor is left behind.
  const { after: _done, ...fresh } = page;
  const rest = search(library, parts.beneath, { ...fresh, limit: page.limit - own.length });
  const total = rest.length === 0 ? 0 : count(library, parts.beneath);
  return {
    hits: [...own, ...rest],
    section: rest.length > 0 ? "beneath" : "own",
    beneath: total === 0 ? null : { at: own.length, count: total },
  };
}
