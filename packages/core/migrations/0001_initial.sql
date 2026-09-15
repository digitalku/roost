-- Schema v1, verbatim from docs/DATA_MODEL.md §2.0.
--
-- The index is a cache the library format deliberately does not describe
-- (RL-2), so nothing here is binding on any other implementation. What is
-- binding is that every row in it can be rebuilt from the journal and
-- originals/ -- which is the only reason a cache is allowed to exist.
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

CREATE TABLE assets (
  hash            TEXT PRIMARY KEY,
  ext             TEXT NOT NULL,
  size            INTEGER NOT NULL,
  width           INTEGER,
  height          INTEGER,
  duration_ms     INTEGER,          -- video and audio only
  orig_name       TEXT NOT NULL,
  storage_mode    TEXT NOT NULL
                  CHECK (storage_mode IN ('managed', 'referenced')),
  link_method     TEXT CHECK (link_method IN ('reflink', 'hardlink', 'copy')),
  ref_path        TEXT,             -- referenced mode only
  is_partial_hash INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER,          -- source file mtime, unix seconds
  imported_at     INTEGER NOT NULL
);

CREATE INDEX idx_assets_imported ON assets(imported_at DESC);
CREATE INDEX idx_assets_ext      ON assets(ext);

CREATE TABLE thumbs (
  hash   TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  size   INTEGER NOT NULL,          -- longest edge: 256 or 512
  width  INTEGER NOT NULL,
  height INTEGER NOT NULL,
  data   BLOB NOT NULL,             -- WebP, quality 80
  PRIMARY KEY (hash, size)
);

CREATE TABLE folders (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_folders_parent ON folders(parent_id);

CREATE TABLE asset_folders (
  hash      TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  PRIMARY KEY (hash, folder_id)
);

CREATE INDEX idx_asset_folders_folder ON asset_folders(folder_id);

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE asset_tags (
  hash   TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (hash, tag_id)
);

CREATE INDEX idx_asset_tags_tag ON asset_tags(tag_id);

CREATE VIRTUAL TABLE assets_fts USING fts5(
  hash UNINDEXED,
  orig_name,
  tags,
  tokenize = 'unicode61'
);
