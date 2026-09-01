-- Schema v8 — comments that carry a moment (ADR-0023).
--
-- A comment is a row rather than a field on the asset, because there are many
-- of them and each is edited on its own. A JSON array on `assets` would make
-- every edit rewrite the whole set, so two windows editing two comments on one
-- asset would silently discard one of them (ADR-0020 allows several windows).
--
-- `at_ms` is NULL for a comment about the asset rather than about a moment in
-- it, which is what lets this one table be both the several-comments feature
-- and the timeline one. Milliseconds, not seconds: this is an offset into a
-- medium, not a date, and a second of granularity on a 24fps cut is
-- twenty-four frames of ambiguity.
--
-- `id` is minted `max(id) + 1` and journalled, exactly as folders are, so a
-- rebuild reproduces it by construction rather than from insertion order.

CREATE TABLE asset_comments (
  id         INTEGER PRIMARY KEY,
  hash       TEXT    NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  at_ms      INTEGER CHECK (at_ms IS NULL OR at_ms >= 0),
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

CREATE INDEX idx_comments_asset ON asset_comments(hash, at_ms, id);
