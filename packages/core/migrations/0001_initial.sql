-- Schema v1 of the Format 2 line, verbatim from docs/DATA_MODEL.md §2.0.
--
-- The index is a cache the library format deliberately does not describe
-- (RL-2), so nothing here is binding on any other implementation. What is
-- binding is that every row in it can be rebuilt from the journal and files/ --
-- which is the only reason a cache is allowed to exist (RL-24).
--
-- This is a new baseline rather than a migration onto version 1's fourteen
-- (ADR-0046 §2.3). Nothing is migrated: an implementation of Format 2 does not
-- read a Format 1 library (RL-6a), so there is no database in the world at the
-- old schema that this build will ever open.
--
-- Within this build it is settled all the same: do not add, rename, or reorder
-- anything here. Later changes go in a new numbered migration. Never edit a
-- migration that has been applied.
--
-- `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON` are not in this
-- file: journal_mode cannot be set inside a transaction, and foreign_keys is
-- per-connection. Both are applied when a connection is opened, in the db module.

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- must contain ('schema_version', '1') -- inserted by the migration runner

-- The asset. `id` is the identity (RL-13): twelve characters of Crockford
-- base32, minted once, never reused, and never derived from the bytes.
--
-- The columns below `imported_at` split in two, and the split is the whole of
-- what Format 2 changed. Everything down to `poster_ms` is something a **person
-- said**, and every one of them arrives through a journal operation. Everything
-- after it is **derived from the bytes** (RL-22) and is journalled by nothing
-- (RL-23): the file may be edited at any time by any application (RL-20), so a
-- size or a width in the journal would be a record of what was true once.
CREATE TABLE assets (
  id          TEXT PRIMARY KEY,
  -- Lowercase, no dot. '' is a file with no extension (RL-9a), which is a fact
  -- rather than a gap.
  ext         TEXT NOT NULL,
  -- What a person reads, **without the extension** (RL-33). What a window shows
  -- is this joined to the extension it finds on disk.
  name        TEXT NOT NULL,
  -- The source file's own date at import, unix seconds. Nothing can recover it
  -- afterwards, which is why it is the one fact about a file that is journalled.
  created_at  INTEGER,
  imported_at INTEGER NOT NULL,
  rating      INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  note        TEXT,
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  source_url  TEXT,
  trashed_at  INTEGER,
  poster_ms   INTEGER CHECK (poster_ms IS NULL OR poster_ms >= 0),

  -- Derived. All nullable, because nothing has been read yet when the row is
  -- written, and all recomputed by the derive pass whenever the file changes.
  size        INTEGER,
  -- The file's modification time when the row below it was last derived.
  -- Together with `size` this is how a change is noticed without reading the
  -- file: a save changes at least one of them.
  mtime       INTEGER,
  -- BLAKE3 over the whole file, lowercase hex. **Derived, never identity**
  -- (RL-18) -- duplicate detection and `doctor`, nothing more.
  --
  -- Spelled out rather than called `hash` so that no statement written against
  -- version 1's schema, where `hash` was the primary key, can compile against
  -- this one and quietly mean something else.
  content_hash TEXT,
  width       INTEGER,
  height      INTEGER,
  duration_ms INTEGER,
  page_count  INTEGER,
  derived_at  INTEGER
);

CREATE TABLE thumbs (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  size     INTEGER NOT NULL,          -- longest edge: 256 or 512
  width    INTEGER NOT NULL,
  height   INTEGER NOT NULL,
  data     BLOB NOT NULL,             -- WebP, quality 80
  PRIMARY KEY (asset_id, size)
);

CREATE TABLE folders (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_folders_parent ON folders(parent_id);

CREATE TABLE asset_folders (
  asset_id  TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  PRIMARY KEY (asset_id, folder_id)
);

CREATE INDEX idx_asset_folders_folder ON asset_folders(folder_id);

CREATE TABLE tag_groups (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tags (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  group_id INTEGER REFERENCES tag_groups(id) ON DELETE SET NULL
);

CREATE INDEX idx_tags_group ON tags(group_id) WHERE group_id IS NOT NULL;

CREATE TABLE asset_tags (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (asset_id, tag_id)
);

CREATE INDEX idx_asset_tags_tag ON asset_tags(tag_id);

CREATE TABLE smart_folders (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER REFERENCES smart_folders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  -- Stored byte for byte, never repaired (RL-47). A query this build cannot
  -- evaluate is one another implementation can.
  query      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_smart_folders_parent ON smart_folders(parent_id);

CREATE TABLE asset_comments (
  id         INTEGER PRIMARY KEY,
  asset_id   TEXT    NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  -- Milliseconds into the medium, or NULL for a comment about the asset rather
  -- than about a moment in it. The one number in the format that is not seconds
  -- (RL-32a).
  at_ms      INTEGER CHECK (at_ms IS NULL OR at_ms >= 0),
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

CREATE INDEX idx_comments_asset ON asset_comments(asset_id, at_ms, id);

CREATE TABLE asset_subtitles (
  asset_id TEXT    NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  track_id TEXT    NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  ordinal  INTEGER NOT NULL,
  lang     TEXT,
  label    TEXT,
  PRIMARY KEY (asset_id, track_id)
) WITHOUT ROWID;

CREATE INDEX idx_subtitles_track ON asset_subtitles(track_id);

-- Directories the library keeps an eye on. Journalled rather than kept in
-- settings.json, because RL-2 puts that file outside the format and "is this
-- folder watched?" must not have a different answer in every implementation.
CREATE TABLE watched_roots (
  id   INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  take TEXT NOT NULL CHECK (take IN ('move', 'copy'))
);

-- Anything a backend read out of a file that has no column of its own: an EXIF
-- camera, a PDF title, a codec name. Derived, like everything else about the
-- bytes.
CREATE TABLE asset_props (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (asset_id, key)
) WITHOUT ROWID;

CREATE TABLE jobs (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  asset_id    TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  priority    INTEGER NOT NULL DEFAULT 0,
  state       TEXT NOT NULL DEFAULT 'ready'
              CHECK (state IN ('ready', 'running', 'blocked', 'failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  reason      TEXT,
  enqueued_at INTEGER NOT NULL,
  UNIQUE (kind, asset_id)
);

CREATE INDEX idx_jobs_ready      ON jobs(priority, id) WHERE state = 'ready';
CREATE INDEX idx_jobs_unfinished ON jobs(kind, state)  WHERE state <> 'ready';

CREATE VIRTUAL TABLE assets_fts USING fts5(
  asset_id UNINDEXED,
  name,
  tags,
  note,
  comments,
  tokenize = 'unicode61'
);

-- One index per order the view menu offers (ADR-0039), each with the same
-- tie-break as its key so that one index serves both directions. `superseded_by`
-- is gone from every predicate here: an edit no longer makes a second asset.
CREATE INDEX idx_assets_imported ON assets(imported_at DESC, id DESC)
                                 WHERE trashed_at IS NULL;
CREATE INDEX idx_assets_ext      ON assets(ext, imported_at DESC, id DESC)
                                 WHERE trashed_at IS NULL;
CREATE INDEX idx_assets_rating   ON assets(rating, imported_at DESC, id DESC)
                                 WHERE rating IS NOT NULL AND trashed_at IS NULL;
CREATE INDEX idx_assets_favorite ON assets(is_favorite, imported_at DESC, id DESC)
                                 WHERE is_favorite = 1 AND trashed_at IS NULL;
CREATE INDEX idx_assets_trashed  ON assets(imported_at DESC, id DESC)
                                 WHERE trashed_at IS NOT NULL;
CREATE INDEX idx_assets_name     ON assets(lower(name), id)
                                 WHERE trashed_at IS NULL;
-- `COALESCE(size, 0)` rather than `size`, and that is version 2's doing: a
-- size is derived now (RL-22), so an asset nothing has read yet has none, and
-- the order has to place it somewhere rather than dropping it. The index is
-- the order's definition, so it is spelled exactly as `ORDERS` spells it.
CREATE INDEX idx_assets_size     ON assets(COALESCE(size, 0), id)
                                 WHERE trashed_at IS NULL;
CREATE INDEX idx_assets_created  ON assets(COALESCE(created_at, imported_at), id)
                                 WHERE trashed_at IS NULL;
CREATE INDEX idx_assets_rated    ON assets(COALESCE(rating, 0), id)
                                 WHERE trashed_at IS NULL;
