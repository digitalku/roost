import type { AssetId, Sort } from "../model/index.js";

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
 * Matches every asset a view shows by default: not in the trash, and not
 * attached as somebody's caption track.
 *
 * The unfiltered grid, which is a listing rather than a search and so never
 * reaches `@roost/search`'s compiler. Everything that *does* reach it is scoped
 * there instead, in one place (ADR-0022, ADR-0025).
 *
 * **Version 2 dropped a third term.** There is no `superseded_by`, because an
 * edit does not produce a second asset any more (ADR-0046).
 *
 * The first term is spelled exactly as the partial indexes are, because SQLite
 * will only use a partial index when the query's WHERE contains a term implying
 * the index's. **The second cannot be one of them** — SQLite forbids a subquery
 * in an index's WHERE — so it is checked per row the seek returns, against
 * `idx_subtitles_track`.
 */
export const MATCH_LIVE: Filter = {
  sql:
    "a.trashed_at IS NULL" +
    " AND NOT EXISTS (SELECT 1 FROM asset_subtitles s WHERE s.track_id = a.id)",
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
 *
 * `key` is the **sort key's value on the last row of the previous page**, and
 * it is whatever that order made of it — a timestamp, a size, a folded name, a
 * rotated id. It is read back off the row rather than recomputed here,
 * because the order is defined in SQL and a second implementation in TypeScript
 * would fold a name differently on the first non-ASCII character (ADR-0039 §4).
 *
 * A cursor belongs to the order it was handed out under. Changing the order
 * starts the listing again, which is what the grid does when the menu changes.
 */
export interface Cursor {
  readonly key: CursorKey;
  readonly id: AssetId;
}

/** What a sort key's value can be: a number for four of them, text for two. */
export type CursorKey = number | string;

/**
 * One page of results. `after` absent starts at the beginning of the order.
 *
 * `sort` absent is {@link DEFAULT_SORT} — newest first, the order the
 * application had before it had a menu.
 */
export interface Page {
  readonly limit: number;
  readonly after?: Cursor;
  readonly sort?: Sort;
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
  readonly id: AssetId;
  /** The display name, without the extension (RL-33). */
  readonly name: string;
  readonly ext: string;
  /** `null` until the file has been read: every fact about the bytes is derived (RL-22). */
  readonly size: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly importedAt: number;
  readonly rating: number | null;
  readonly isFavorite: boolean;
  /**
   * The moment a video's thumbnail is pinned to (ADR-0024 stage 4).
   *
   * On a grid row because it is part of the thumbnail's **address**, not
   * because a cell draws it: `roost://thumb/<id>@256` carries the moment so
   * that a pinned frame changes the address rather than the picture at one
   * address. In version 2 the bytes behind an id may change at any time
   * (RL-20), so a thumbnail URL is **not** immutable — the derive pass that
   * notices a changed file is what makes the cell redraw.
   */
  readonly posterMs: number | null;
  /**
   * This row's value for the order it was fetched in (ADR-0039 §4).
   *
   * A column of the result rather than a field a caller derives: the order is
   * an expression in SQL, and the cursor has to be the same expression's answer
   * or the resume lands somewhere else. For the default order it is the same
   * number as `importedAt`; for `random` it is the rotated id, which exists
   * nowhere but in the statement that asked for it.
   */
  readonly sortKey: CursorKey;
}

/** The cursor that resumes a listing after `hit`. */
export function cursorAfter(hit: SearchHit): Cursor {
  return { key: hit.sortKey, id: hit.id };
}
