-- Schema v5 — the filter indexes a grid query can actually use.
--
-- Published in docs/DATA_MODEL.md §2.4. The measurements behind it, and the
-- options it was chosen against, are in the Rust implementation's own
-- docs/BENCHMARKS.md and docs/adr/0006 — this repository carries the result.
--
-- Every grid query has the same shape: a filter, `ORDER BY imported_at DESC,
-- hash`, and a LIMIT of one screen. Given a single-column index on the filtered
-- column, SQLite seeks the matching rows through it and then sorts all of them
-- in a temporary B-tree to produce two hundred — so a term matching a fifth of
-- the library reads and sorts a fifth of the library for one screen. Measured
-- at 96,666 assets: `ext:png` 18.9 ms, `is:favorite` 18.8 ms, `rating:5`
-- 7.0 ms, against a 100 ms p95 budget that has to hold at a million.
--
-- ANALYZE does not fix it. Measured: with sqlite_stat1 in place the plan and
-- the time are unchanged, because SQLite costs the sort but not the early exit
-- the LIMIT would allow.
--
-- Carrying the sort key inside the filter index is what fixes it. The index is
-- then already in the order the query asks for, so SQLite seeks the filtered
-- range and walks it until the LIMIT is satisfied, reading two hundred rows
-- instead of twenty thousand. Same three queries after this migration: 0.51 ms,
-- 0.51 ms, 0.45 ms.
--
-- These replace rather than join their single-column predecessors. Each new
-- index has the old one's column as its leading column, so it answers
-- everything the old one did; keeping both would only add a second index to
-- maintain on every insert. The partial ones stay partial for the reason
-- DATA_MODEL.md §2.1 gives — an unrated library pays nothing.
--
-- Deliberately NOT extended to `size`, `width`, `height`, or `duration`. Those
-- have no index at all, and having none is why SQLite already walks the
-- ordering index and stops at the LIMIT — which is the plan this migration is
-- buying everywhere else. Adding one would create the problem, not solve it.

DROP INDEX idx_assets_ext;
DROP INDEX idx_assets_rating;
DROP INDEX idx_assets_favorite;

CREATE INDEX idx_assets_ext      ON assets(ext, imported_at DESC, hash);

CREATE INDEX idx_assets_rating   ON assets(rating, imported_at DESC, hash)
                                 WHERE rating IS NOT NULL;

CREATE INDEX idx_assets_favorite ON assets(is_favorite, imported_at DESC, hash)
                                 WHERE is_favorite = 1;
