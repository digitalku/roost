-- Schema v2 — the state M2 lets a user author: rating, note, favourite, and
-- saved queries.
--
-- Published in docs/DATA_MODEL.md §2.1 and guarded by
-- packages/core/tests/spec-conformance.test.ts. Migration 0001 stays untouched: the
-- storage specification is binding, and growth happens in new numbered files.
--
-- Every column here holds something a user typed or clicked, so each one has a
-- matching journal op (invariant 6). Nothing in this file is derivable from
-- `originals/`.

-- NULL means unrated, which is distinct from a deliberate one star. SQLite does
-- not verify a CHECK against rows that already exist, which is harmless here:
-- every existing row gets NULL.
ALTER TABLE assets ADD COLUMN rating INTEGER
      CHECK (rating IS NULL OR rating BETWEEN 1 AND 5);

ALTER TABLE assets ADD COLUMN note TEXT;

ALTER TABLE assets ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0
      CHECK (is_favorite IN (0, 1));

-- Partial indexes: `rating:>=4` and `is:favorite` select a small minority of a
-- large library, so indexing only the matching rows keeps both the index and
-- the write cost proportional to what is actually rated or favourited.
CREATE INDEX idx_assets_rating   ON assets(rating)      WHERE rating IS NOT NULL;
CREATE INDEX idx_assets_favorite ON assets(is_favorite) WHERE is_favorite = 1;

-- A smart folder is a saved RQL string, not a materialised set: it is evaluated
-- on read, so it cannot go stale. `query` is never concatenated into SQL — it is
-- parsed and compiled to bound parameters.
CREATE TABLE smart_folders (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER REFERENCES smart_folders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  query      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_smart_folders_parent ON smart_folders(parent_id);
