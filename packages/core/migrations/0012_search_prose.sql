-- Schema v12 — free text searches what a person wrote (ADR-0027).
--
-- The full-text index has held two columns since 0001, and both are labels:
-- the filename a camera chose, and the tags picked from a small vocabulary.
-- The two places in Roost where somebody writes a *sentence* — the note on an
-- asset (0002) and its comments (0008) — were not searchable at all. Typing
-- what you remember writing found nothing.
--
-- **The table is dropped and rebuilt rather than altered**, because FTS5 has
-- no ALTER TABLE ... ADD COLUMN. That is alarming anywhere else in this schema
-- and free here, for a reason the specification states as invariant 1: the
-- index is derived. `assets_fts` holds nothing that `assets` and
-- `asset_comments` do not already hold, so this migration is a recomputation.
--
-- **One row per asset, so an asset's comments are concatenated** — exactly as
-- its tags already are. The known cost is a phrase that matches across the
-- seam between two comments; ADR-0027 §4 weighs it against a second FTS table
-- with a row per comment, and takes this.
--
-- The rowid stays aligned with `assets.rowid`. It is what makes both the
-- delete and the insert in `#refreshFts` rowid lookups instead of scans of an
-- UNINDEXED column, which was measured in the Rust build as a 4x throughput
-- collapse between 20k and 100k assets.

DROP TABLE assets_fts;

CREATE VIRTUAL TABLE assets_fts USING fts5(
  hash UNINDEXED,
  orig_name,
  tags,
  note,
  comments,
  tokenize = 'unicode61'
);

INSERT INTO assets_fts (rowid, hash, orig_name, tags, note, comments)
SELECT a.rowid,
       a.hash,
       a.orig_name,
       coalesce((SELECT group_concat(t.name, ' ')
                   FROM asset_tags at JOIN tags t ON t.id = at.tag_id
                  WHERE at.hash = a.hash), ''),
       coalesce(a.note, ''),
       coalesce((SELECT group_concat(c.body, ' ')
                   FROM asset_comments c
                  WHERE c.hash = a.hash), '')
  FROM assets a;
