-- Schema v7 — trash is a column (ADR-0022).
--
-- Deleting must be reversible for the half that is expensive to recreate. The
-- bytes under `originals/` already had a grace period: `remove` leaves them for
-- a deliberate `doctor --reclaim`. What had none was the row — the tags, the
-- rating, the note, and the folder memberships all died at the click. A file
-- that was imported once can be imported again; forty tags applied by hand over
-- a month cannot. So trash preserves the row and changes nothing else.
--
-- `trashed_at` is unix seconds, taken from the journal line's own `ts` — the
-- `trash` op records no timestamp of its own. NULL means live, which is what
-- every existing row becomes when this migration runs.
--
-- **The four grid indexes become partial.** Every read but the Trash place
-- carries `a.trashed_at IS NULL`, so an index that also covered trashed rows
-- would make SQLite filter them out after the seek — and the ordering index is
-- the one thing keeping keyset paging at constant cost (migrations 0003 and
-- 0005). Partial is both the correctness fix and the cheaper index: the
-- ordinary case stops paying for rows nobody is looking at.
--
-- SQLite uses a partial index only when the query's WHERE clause contains a
-- term implying the index's. That term is spelled `a.trashed_at IS NULL` and it
-- is written by exactly one place, `@roost/search`'s compiler, so the wording
-- cannot drift away from what these indexes require. `db.test.ts` asserts the
-- plans rather than trusting that.
--
-- The fifth index is the Trash place itself. It orders the same way everything
-- else does — `imported_at DESC, hash`, the order the whole application pages
-- on — so Trash is an ordinary grid over a different set of rows, not a second
-- query path with a second cursor.

ALTER TABLE assets ADD COLUMN trashed_at INTEGER;

DROP INDEX idx_assets_imported;
DROP INDEX idx_assets_ext;
DROP INDEX idx_assets_rating;
DROP INDEX idx_assets_favorite;

CREATE INDEX idx_assets_imported ON assets(imported_at DESC, hash)
                                 WHERE trashed_at IS NULL;

CREATE INDEX idx_assets_ext      ON assets(ext, imported_at DESC, hash)
                                 WHERE trashed_at IS NULL;

CREATE INDEX idx_assets_rating   ON assets(rating, imported_at DESC, hash)
                                 WHERE rating IS NOT NULL AND trashed_at IS NULL;

CREATE INDEX idx_assets_favorite ON assets(is_favorite, imported_at DESC, hash)
                                 WHERE is_favorite = 1 AND trashed_at IS NULL;

CREATE INDEX idx_assets_trashed  ON assets(imported_at DESC, hash)
                                 WHERE trashed_at IS NOT NULL;
