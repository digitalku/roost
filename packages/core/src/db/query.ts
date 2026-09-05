import type { ContentHash } from "../model/index.js";

/**
 * One bound value.
 *
 * Deliberately narrower than what SQLite accepts: `@roost/search` compiles
 * against this type and has no business knowing about BLOBs or bigints. A
 * boolean is absent on purpose — `better-sqlite3` refuses to bind one, and the
 * schema stores flags as `0`/`1`, so the conversion belongs at the call site
 * that knows which column it is filling.
 */
export type Param = number | string;

/**
 * A `WHERE` fragment and the values its placeholders stand for.
 *
 * The fragment refers to the `assets` table as `a`, and carries **anonymous
 * `?` placeholders only** — one per entry in `params`, in the same order.
 * Values are never interpolated. This is the single exception to invariant 3:
 * `@roost/search` owns the language and produces the predicate, and everything
 * around it — projection, ordering, keyset predicate, limit — is built here.
 *
 * Anonymous rather than numbered because `better-sqlite3` treats `?NNN` as a
 * *named* parameter and refuses to bind it positionally. See {@link searchSql}
 * in `repo.ts`, where that fact decides how the cursor is written.
 */
export interface Filter {
  readonly sql: string;
  readonly params: readonly Param[];
}

/**
 * Matches every asset, trashed ones included.
 *
 * Rarely what a *view* wants — see {@link MATCH_LIVE}. This is the filter for
 * the questions asked about the library itself rather than about what is in it:
 * `doctor` counts every row, because a trashed asset still holds its bytes and
 * an audit that skipped it would report those bytes as orphaned.
 */
export const MATCH_ALL: Filter = { sql: "1", params: [] };

/**
 * Matches every asset a view shows by default: not in the trash, not replaced
 * by a newer version, and not attached as somebody's caption track.
 *
 * The unfiltered grid, which is a listing rather than a search and so never
 * reaches `@roost/search`'s compiler. Everything that *does* reach it is scoped
 * there instead, in one place (ADR-0022, ADR-0025, ADR-0026).
 *
 * The first two terms are spelled exactly as the partial indexes in migrations
 * 0007 and 0010 are, and in the same order, because SQLite will only use a
 * partial index when the query's WHERE contains a term implying the index's.
 * **The third cannot be one of those terms** — SQLite forbids a subquery in an
 * index's WHERE — so it is checked per row the seek returns, against
 * `idx_subtitles_track`.
 */
export const MATCH_LIVE: Filter = {
  sql:
    "a.trashed_at IS NULL AND a.superseded_by IS NULL" +
    " AND NOT EXISTS (SELECT 1 FROM asset_subtitles s WHERE s.track_hash = a.hash)",
  params: [],
};

/**
 * Matches nothing.
 *
 * Not an error: `folder:Nonexistent` is a well-formed query with an empty
 * answer, and saying so beats failing.
 */
export const MATCH_NONE: Filter = { sql: "0", params: [] };

/**
 * Where to resume a listing.
 *
 * Keyset paging, never `OFFSET`: an offset makes SQLite walk and discard every
 * earlier row, so scrolling gets slower the further it goes. A cursor costs the
 * same at row 900,000 as at row 100.
 */
export interface Cursor {
  readonly importedAt: number;
  readonly hash: ContentHash;
}

/** One page of results. `after` absent starts at the newest asset. */
export interface Page {
  readonly limit: number;
  readonly after?: Cursor;
}

/** The default page: one screen of a grid, with room to scroll into. */
export const DEFAULT_PAGE_LIMIT = 100;

/**
 * One row of a result page.
 *
 * `width` and `height` are `| null` rather than optional because that is what
 * the column holds: absent for anything not probed as an image or video. A grid
 * needs them to reserve a cell's shape before the thumbnail arrives, which is
 * the difference between laying out once and reflowing on every load.
 */
export interface SearchHit {
  readonly hash: ContentHash;
  readonly origName: string;
  readonly ext: string;
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly importedAt: number;
  readonly rating: number | null;
  readonly isFavorite: boolean;
  /**
   * The moment a video's thumbnail is pinned to (ADR-0024 stage 4).
   *
   * On a grid row because it is part of the thumbnail's **address**, not
   * because a cell draws it: `roost://thumb/<hash>@256` is served as immutable
   * on the promise that a hash and a size fix the pixels, and a pinned frame is
   * the one thing that can change them. The moment goes in the URL so the
   * promise stays true and a changed thumbnail is a changed address.
   */
  readonly posterMs: number | null;
}

/** The cursor that resumes a listing after `hit`. */
export function cursorAfter(hit: SearchHit): Cursor {
  return { importedAt: hit.importedAt, hash: hit.hash };
}
