-- Schema v4 — tag groups.
--
-- Published in docs/DATA_MODEL.md §2.3 and guarded by
-- packages/core/tests/spec-conformance.test.ts.
--
-- Groups organize tags; they do not nest them. `tags.name` stays globally
-- UNIQUE COLLATE NOCASE, so `tag:icons` still names exactly one tag no matter
-- how many groups exist. That is the whole point of choosing this over
-- hierarchical tags: a sidebar that stays readable at two hundred tags, without
-- making every tag reference in a query potentially ambiguous.

CREATE TABLE tag_groups (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ON DELETE SET NULL, never CASCADE: a group is a way of arranging tags, and
-- deleting the arrangement must not delete the tags themselves, nor unpick
-- every asset that carries them.
ALTER TABLE tags ADD COLUMN group_id INTEGER
      REFERENCES tag_groups(id) ON DELETE SET NULL;

CREATE INDEX idx_tags_group ON tags(group_id) WHERE group_id IS NOT NULL;
