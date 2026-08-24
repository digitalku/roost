-- Schema v3 — the index keyset paging needs.
--
-- Published in docs/DATA_MODEL.md §2.2 and guarded by
-- packages/core/tests/spec-conformance.test.ts.
--
-- The grid pages on `(imported_at, hash)` rather than on `imported_at` alone,
-- because `imported_at` is not unique: a bulk import writes thousands of assets
-- within the same second, and without a tie-break the same asset can appear on
-- two pages or on none. Keyset paging therefore needs the index to hold that
-- exact order already, or SQLite sorts the second column itself — reading the
-- whole table into a temporary B-tree to produce one screen.
--
-- This replaces rather than adds. An index on (imported_at DESC, hash) also
-- serves queries that order by imported_at alone, because that is its leading
-- column, so keeping both would only cost a second index to maintain on every
-- insert.

DROP INDEX idx_assets_imported;

CREATE INDEX idx_assets_imported ON assets(imported_at DESC, hash);
