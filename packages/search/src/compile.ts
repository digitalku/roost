import type { Filter, Param } from "@roost/core";
import type { Compare, Expr, Flag, Term } from "./ast.js";

/**
 * Turning a parsed query into a `WHERE` fragment and its bound values.
 *
 * **No user input is ever interpolated.** Every value the user typed becomes a
 * bound parameter behind a `?`; the only text this module writes into SQL is
 * text it chose itself, from a fixed set. That is what makes RQL safe in a
 * search bar and in a smart folder saved months ago.
 *
 * The fragment refers to the `assets` table as `a`, and is a predicate only —
 * the statement around it belongs to `@roost/core`'s `repo` (invariant 3).
 */

/**
 * Expands a folder path to the folder and everything beneath it.
 *
 * Resolution happens here rather than in SQL because the tree is small and
 * user-made, and expanding it keeps a recursive CTE out of every compiled
 * query — and lets this package be tested without a database at all. A smart
 * folder recompiles each time it runs, so the expansion cannot go stale.
 */
export interface Folders {
  /** Every folder id matching `path`, including descendants. */
  subtree(path: string): number[];
}

/** A resolver that finds no folders, for compiling without a database. */
export const NO_FOLDERS: Folders = { subtree: () => [] };

/**
 * Compiles an expression into a filter.
 *
 * **A query is scoped by default, and each scope rule is opted out of by naming
 * its flag.** Two rules as of ADR-0026, listed in {@link SCOPE}: not in the
 * trash, and not replaced by a newer version. Trash is a state rather than a
 * place (ADR-0022), so a trashed asset is still a row that `tag:wip` would
 * otherwise match — and an application where deleting something leaves it in
 * every search is one where deleting does not work. A superseded asset is the
 * same argument about editing: every intermediate save would otherwise be in
 * every result.
 *
 * Scoping here rather than in each caller is what makes the Trash place an
 * ordinary sidebar row: it carries `is:trashed` the way Favorites carries
 * `is:favorite`, and nothing outside the grammar has to know that Trash is
 * special. The alternative — a scope flag threaded through every read — would
 * put the same rule in the engine, the CLI, and the renderer, and one of the
 * three would eventually forget it.
 *
 * Mentioning a flag in any polarity opts out of *that* rule and no other,
 * including under a `NOT`: `-is:trashed` then compiles to the same predicate
 * the default would have added, so opting out cannot accidentally widen
 * anything.
 */
export function compileQuery(expr: Expr, folders: Folders = NO_FOLDERS): Filter {
  const params: Param[] = [];
  const sql = write(expr, folders, params);
  const scope = SCOPE.filter((rule) => !mentions(expr, rule.flag)).map((rule) => rule.sql);
  if (scope.length === 0) return { sql, params };
  // `AND` at the top level, never nested inside the user's expression: SQLite
  // flattens a conjunction in the WHERE clause into separate terms, and it is
  // that flattening which lets migrations 0007 and 0010's partial indexes
  // apply.
  return { sql: `(${sql}) AND ${scope.join(" AND ")}`, params };
}

/**
 * Whether this asset is attached as somebody's caption track.
 *
 * A correlated `EXISTS` rather than a column, because the attachment is a
 * relation and denormalising it would be a second place to keep in step. It is
 * a point lookup into `idx_subtitles_track`, which migration 0011 creates for
 * exactly this — the primary key cannot serve it, since `track_hash` is its
 * second column.
 *
 * **This one cannot be part of a partial index**, unlike the two scope rules
 * beside it: SQLite forbids a subquery in an index's WHERE. So the grid still
 * seeks on `idx_assets_imported` and pays this per row it returns.
 * `scripts/bench-search.ts` is what says whether that is affordable, and
 * ADR-0025 §4 names the fallback if it is not — a column on `assets`,
 * maintained beside the join table.
 */
const ATTACHED_AS_TRACK = "EXISTS (SELECT 1 FROM asset_subtitles s WHERE s.track_hash = a.hash)";

/**
 * The flags that scope a query rather than narrowing it, and what each one
 * adds when it is *not* mentioned.
 *
 * Two of them as of ADR-0026, and they are independent: `is:trashed` opts out
 * of the trash rule and leaves the superseded one in force, because a
 * superseded row in the trash is still a version rather than something somebody
 * deleted. One table rather than a special case each — the third such rule is
 * where a pattern becomes a design, and the fourth is where it becomes a bug.
 *
 * **The order is load-bearing.** Joined in this order the result is spelled
 * exactly as `MATCH_LIVE` and as the partial indexes both migrations create,
 * and SQLite uses a partial index only when the query's WHERE contains a term
 * implying the index's. `query.test.ts` holds the two spellings together.
 */
const SCOPE: readonly { readonly flag: Flag; readonly sql: string }[] = [
  { flag: "trashed", sql: "a.trashed_at IS NULL" },
  { flag: "superseded", sql: "a.superseded_by IS NULL" },
  { flag: "subtitle", sql: `NOT ${ATTACHED_AS_TRACK}` },
];

/** Whether a flag appears anywhere in a query, at any depth and in any polarity. */
function mentions(expr: Expr, flag: Flag): boolean {
  switch (expr.kind) {
    case "all":
      return false;
    case "term":
      return expr.term.field === "flag" && expr.term.flag === flag;
    case "not":
      return mentions(expr.expr, flag);
    case "and":
    case "or":
      return expr.branches.some((branch) => mentions(branch, flag));
  }
}

function write(expr: Expr, folders: Folders, params: Param[]): string {
  switch (expr.kind) {
    case "all":
      return "1";
    case "not":
      return `NOT (${write(expr.expr, folders, params)})`;
    case "and":
      return join(expr.branches, " AND ", folders, params);
    case "or":
      return join(expr.branches, " OR ", folders, params);
    case "term":
      return termSql(expr.term, folders, params);
  }
}

function join(
  branches: readonly Expr[],
  separator: string,
  folders: Folders,
  params: Param[],
): string {
  if (branches.length === 0) return "1";
  return branches.map((branch) => `(${write(branch, folders, params)})`).join(separator);
}

function termSql(term: Term, folders: Folders, params: Param[]): string {
  switch (term.field) {
    case "tag":
      params.push(term.value);
      // `tags.name` is UNIQUE COLLATE NOCASE, so equality here is already
      // case-insensitive and matches what tagging does.
      return `EXISTS (SELECT 1 FROM asset_tags at JOIN tags t ON t.id = at.tag_id
                       WHERE at.hash = a.hash AND t.name = ?)`;

    case "folder": {
      const ids = folders.subtree(term.value);
      // A folder nobody has created is an empty answer, not an error.
      if (ids.length === 0) return "0";
      const placeholders = ids.map(() => "?").join(", ");
      for (const id of ids) params.push(id);
      return `EXISTS (SELECT 1 FROM asset_folders af
                       WHERE af.hash = a.hash AND af.folder_id IN (${placeholders}))`;
    }

    case "group":
      params.push(term.value);
      // Groups arrange tags rather than containing assets, so this reaches an
      // asset through the tags it carries.
      return `EXISTS (SELECT 1 FROM asset_tags at
                        JOIN tags t ON t.id = at.tag_id
                        JOIN tag_groups g ON g.id = t.group_id
                       WHERE at.hash = a.hash AND g.name = ?)`;

    case "ext":
      params.push(term.value);
      return "a.ext = ?";

    case "size":
      return numeric("a.size", term.compare, params);
    case "width":
      return numeric("a.width", term.compare, params);
    case "height":
      return numeric("a.height", term.compare, params);
    case "duration":
      return numeric("a.duration_ms", term.compare, params);
    case "rating":
      return numeric("a.rating", term.compare, params);
    case "created":
      return numeric("a.created_at", term.compare, params);
    case "imported":
      return numeric("a.imported_at", term.compare, params);

    case "flag":
      return flagSql(term.flag, params);

    case "text":
      params.push(ftsPhrase(term.value));
      // The full-text rowid is kept aligned with `assets.rowid`, so this is a
      // rowid lookup rather than a join on an UNINDEXED column.
      return "a.rowid IN (SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?)";
  }
}

/**
 * A comparison against a column.
 *
 * `width`, `height`, `duration_ms`, `created_at`, and `rating` are nullable,
 * and SQL's three-valued logic makes `NULL > 5` neither true nor false — which
 * is right: an asset with no rating is not "rated above 5", and it is not
 * "rated below 5" either.
 */
function numeric(column: string, compare: Compare, params: Param[]): string {
  if (compare.op === "between") {
    params.push(compare.low, compare.high);
    return `${column} BETWEEN ? AND ?`;
  }
  params.push(compare.value);
  const operator = { eq: "=", lt: "<", le: "<=", gt: ">", ge: ">=" }[compare.op];
  return `${column} ${operator} ?`;
}

function flagSql(flag: Flag, params: Param[]): string {
  switch (flag) {
    case "favorite":
      return "a.is_favorite = 1";
    case "rated":
      return "a.rating IS NOT NULL";
    case "unrated":
      return "a.rating IS NULL";
    case "partial-hash":
      return "a.is_partial_hash = 1";
    case "trashed":
      return "a.trashed_at IS NOT NULL";
    case "superseded":
      return "a.superseded_by IS NOT NULL";
    case "subtitle":
      return ATTACHED_AS_TRACK;
    case "captioned":
      return "EXISTS (SELECT 1 FROM asset_subtitles s WHERE s.hash = a.hash)";
    case "managed":
    case "referenced":
      params.push(flag);
      return "a.storage_mode = ?";
    case "tagged":
      return "EXISTS (SELECT 1 FROM asset_tags at WHERE at.hash = a.hash)";
    case "untagged":
      return "NOT EXISTS (SELECT 1 FROM asset_tags at WHERE at.hash = a.hash)";
  }
}

/**
 * Wraps free text as a single FTS5 phrase.
 *
 * FTS5's `MATCH` argument is a query language of its own, so passing raw user
 * text through would let `AND`, `NEAR`, `*`, or a stray `"` change or break the
 * search. Not a SQL injection — the value is bound — but a confusing failure
 * all the same. Quoting turns the whole input into one phrase, which is what
 * someone typing into a search box means.
 */
function ftsPhrase(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}
