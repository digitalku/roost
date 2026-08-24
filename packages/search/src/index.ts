/**
 * `@roost/search` compiles the Roost Query Language into a SQL `WHERE`
 * fragment with bound parameters — the one exception to "all SQL lives in
 * `@roost/core`" (`ARCHITECTURE.md` invariant 3).
 *
 * This is where user input becomes SQL, so nothing is ever interpolated and the
 * parser is property-tested. The grammar is in `docs/DATA_MODEL.md` §3 and is
 * frozen by compatibility: a smart folder stores its query text, so a query
 * this package cannot parse is a folder the user loses.
 *
 * Arrives with M2.
 */
export {};
