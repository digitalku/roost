-- Schema v10 — an edit is a new asset, and the old one is superseded (ADR-0026).
--
-- **It took 0010 although ADR-0025 named that number for subtitles**, because
-- this is the one that got built and a reserved gap is a migration that can
-- never run: the runner records version numbers and applies only what is
-- higher than the library's, so a 0010 arriving after a library reached 11
-- would be skipped in silence. Numbers go to work in the order the work
-- happens; subtitles take 0011.
--
-- Identity here is the content hash, so a save cannot be a write: changed bytes
-- are a different asset, at a different address under `originals/`, in a
-- different row. What was missing was a way to say *which* asset replaced
-- which, without destroying the one replaced.
--
-- `superseded_by` is that, and it points **forward one step**. Following it
-- gives every version of a file, oldest to newest. NULL means current, which is
-- what every existing row becomes when this migration runs.
--
-- **Not the trash.** The user did not delete the old version, and a Trash place
-- filling up with every intermediate save is a Trash place nobody opens.
-- Superseded is a different state with a different meaning — *there is a newer
-- one* — and the newer one is named rather than merely implied.
--
-- **Nothing prunes the chain.** Removing an old version is `remove` on that
-- hash: a second, deliberate gesture, exactly as ADR-0022 decided for trash and
-- for the same reason. Nothing is destroyed on a schedule.
--
-- **The five grid indexes gain the second half of the default scope.** Every
-- read but a deliberate `is:superseded` carries `a.superseded_by IS NULL`
-- alongside `a.trashed_at IS NULL`, and SQLite uses a partial index only when
-- the query's WHERE contains a term implying the index's. Both terms are
-- written by one place — `@roost/search`'s compiler, through `MATCH_LIVE` — so
-- the wording cannot drift away from what these indexes require. The Trash
-- index carries it too: `is:trashed` opts out of the trash half of the scope
-- and not of this one, because a superseded row in the trash is still a
-- version rather than a thing somebody deleted.
--
-- No index on `superseded_by` itself. It is read one asset at a time, beside
-- the row it belongs to, and the chain is as long as the number of times a
-- person saved one file.

ALTER TABLE assets ADD COLUMN superseded_by TEXT REFERENCES assets(hash);

DROP INDEX idx_assets_imported;
DROP INDEX idx_assets_ext;
DROP INDEX idx_assets_rating;
DROP INDEX idx_assets_favorite;
DROP INDEX idx_assets_trashed;

CREATE INDEX idx_assets_imported ON assets(imported_at DESC, hash)
                                 WHERE trashed_at IS NULL AND superseded_by IS NULL;

CREATE INDEX idx_assets_ext      ON assets(ext, imported_at DESC, hash)
                                 WHERE trashed_at IS NULL AND superseded_by IS NULL;

CREATE INDEX idx_assets_rating   ON assets(rating, imported_at DESC, hash)
                                 WHERE rating IS NOT NULL AND trashed_at IS NULL
                                   AND superseded_by IS NULL;

CREATE INDEX idx_assets_favorite ON assets(is_favorite, imported_at DESC, hash)
                                 WHERE is_favorite = 1 AND trashed_at IS NULL
                                   AND superseded_by IS NULL;

CREATE INDEX idx_assets_trashed  ON assets(imported_at DESC, hash)
                                 WHERE trashed_at IS NOT NULL AND superseded_by IS NULL;
