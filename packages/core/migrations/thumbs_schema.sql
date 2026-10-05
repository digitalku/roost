-- The thumbnail database, thumbs/roost.db, verbatim from docs/DATA_MODEL.md §2.2.
--
-- Not a numbered migration, and not the index: a cache of its own (ADR-0051),
-- attached to the index's connection as `pictures`. It has one version, kept in
-- `PRAGMA user_version`. Version 1 is brought forward by adding `chosen`; a
-- file at any other version is dropped and made again -- which, since
-- ADR-0060, loses the thumbnails somebody chose, and nothing else.
--
-- `PRAGMA auto_vacuum = INCREMENTAL` is not in this file for the reason the
-- index's PRAGMAs are not in 0001: it has to be set before the first table
-- exists, so the db module sets it when it finds the file empty.

-- What the pictures were drawn from, one row per asset. A thumbnail is reused
-- only while `file_size`, `file_mtime` and `poster_ms` still match the file and
-- the asset, and then so is everything else here -- which is what lets a
-- rebuild restore the derived columns without decoding or hashing anything.
--
-- `chosen` is 1 where somebody supplied the pictures (ADR-0060). Those are
-- never drawn over: a changed file is measured again and its pictures kept,
-- and `file_size` = -1 says the file has not been measured since.
CREATE TABLE pictures.sources (
  asset_id     TEXT PRIMARY KEY,
  file_size    INTEGER NOT NULL,
  file_mtime   INTEGER NOT NULL,     -- unix seconds, floored, as assets.mtime
  poster_ms    INTEGER,
  content_hash TEXT,
  width        INTEGER,
  height       INTEGER,
  duration_ms  INTEGER,
  page_count   INTEGER,
  props        TEXT,                 -- JSON object, or NULL for none
  chosen       INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- A rowid table on purpose: WITHOUT ROWID stores a row inside the B-tree, and a
-- row the size of a thumbnail is what SQLite's own guidance says not to put
-- there.
CREATE TABLE pictures.thumbs (
  asset_id TEXT NOT NULL,
  size     INTEGER NOT NULL,          -- longest edge: 256 or 512
  width    INTEGER NOT NULL,
  height   INTEGER NOT NULL,
  data     BLOB NOT NULL,             -- WebP, quality 80
  PRIMARY KEY (asset_id, size)
);
