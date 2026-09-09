-- Schema v14 — the orders the view menu can ask for (ADR-0039).
--
-- Until now the application had exactly one order, `imported_at DESC, hash`,
-- and every index since 0003 was built for it. A sort menu is therefore engine
-- work: a key with no index makes SQLite read the whole match set into a
-- temporary B-tree to produce one screen. Measured on 95,001 assets, ordering
-- the unfiltered grid by name cost 28.6 ms against 0.07 ms for the order it
-- already had, and each of the other keys the same 28–35 ms.
--
-- **The tie-break follows the key.** That is the whole reason the five existing
-- indexes are rebuilt here rather than left alone. `hash` was ascending under a
-- descending timestamp, which is a mixed order: one index cannot serve both
-- directions of it, and the resume predicate cannot be a row-value comparison —
-- the trap `searchSql` has carried a comment about since M2. With the tie-break
-- pointing the same way as the key, `(imported_at DESC, hash DESC)` read
-- forwards is newest-first and read backwards is oldest-first, so **one index
-- serves both directions of every key**.
--
-- What changes for a library that already exists: among assets sharing one
-- timestamp — a bulk import writes thousands within the same second — the
-- order flips. Nothing else moves, and no query answers differently.
--
-- The four new indexes are the four new keys. Each is `(key, hash)` and each is
-- partial in exactly the way 0007 and 0010 made the others partial, because
-- every read but a deliberate `is:trashed` or `is:superseded` carries
-- `MATCH_LIVE`'s two terms and SQLite uses a partial index only when the
-- query's WHERE implies the index's.
--
-- Two of them index an expression rather than a column, and the expression is
-- the definition of the order:
--
--   * `lower(orig_name)` — sorting by name is case-insensitive, and SQLite's
--     `lower()` folds ASCII only. That is the same folding `@roost/library`
--     already does for folder names, and choosing Unicode folding here would
--     make the index disagree with the comparison the resume is written with.
--   * `COALESCE(created_at, imported_at)` and `COALESCE(rating, 0)` — both
--     columns are nullable, and a NULL in a keyset comparison yields NULL,
--     which silently drops rows. A file with no creation date is dated when it
--     arrived, and an unrated asset sorts below one star.
--
-- No index for the random order: it is a seeded rotation of the content hash,
-- computed per row, and an index per seed is 63 indexes. ADR-0039 §5 records
-- what that costs and why it is the right trade.
--
-- Deliberately not extended per filter. A filtered sort — `ext:png` ordered by
-- name — seeks the filter's index and sorts what it finds: 6.8 ms at 95,001
-- assets, against 0.05 ms for either half alone. Fixing that means one
-- composite index per key *per filter*, which is 5 × 4 more indexes on the
-- write path, and ≥300 imports/sec is also a target. Measured, recorded in
-- `docs/BENCHMARKS.md`, and left alone.

DROP INDEX idx_assets_imported;
DROP INDEX idx_assets_ext;
DROP INDEX idx_assets_rating;
DROP INDEX idx_assets_favorite;
DROP INDEX idx_assets_trashed;

CREATE INDEX idx_assets_imported ON assets(imported_at DESC, hash DESC)
                                 WHERE trashed_at IS NULL AND superseded_by IS NULL;

CREATE INDEX idx_assets_ext      ON assets(ext, imported_at DESC, hash DESC)
                                 WHERE trashed_at IS NULL AND superseded_by IS NULL;

CREATE INDEX idx_assets_rating   ON assets(rating, imported_at DESC, hash DESC)
                                 WHERE rating IS NOT NULL AND trashed_at IS NULL
                                   AND superseded_by IS NULL;

CREATE INDEX idx_assets_favorite ON assets(is_favorite, imported_at DESC, hash DESC)
                                 WHERE is_favorite = 1 AND trashed_at IS NULL
                                   AND superseded_by IS NULL;

CREATE INDEX idx_assets_trashed  ON assets(imported_at DESC, hash DESC)
                                 WHERE trashed_at IS NOT NULL AND superseded_by IS NULL;

CREATE INDEX idx_assets_name     ON assets(lower(orig_name), hash)
                                 WHERE trashed_at IS NULL AND superseded_by IS NULL;

CREATE INDEX idx_assets_size     ON assets(size, hash)
                                 WHERE trashed_at IS NULL AND superseded_by IS NULL;

CREATE INDEX idx_assets_created  ON assets(COALESCE(created_at, imported_at), hash)
                                 WHERE trashed_at IS NULL AND superseded_by IS NULL;

CREATE INDEX idx_assets_rated    ON assets(COALESCE(rating, 0), hash)
                                 WHERE trashed_at IS NULL AND superseded_by IS NULL;
