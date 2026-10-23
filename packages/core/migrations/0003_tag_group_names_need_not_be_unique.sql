-- Schema v3: a tag group's name is not unique in the index (ADR-0061),
-- verbatim from docs/DATA_MODEL.md §2.3.
--
-- The rule moves to where a folder's already is: a new name is refused before
-- it is journalled (`DuplicateTagGroupNameError`), and replay applies whatever
-- the journal says. With the constraint here, a duplicate that reached the
-- journal made the index refuse the line, and then made every rebuild of that
-- library stop at it.
--
-- `tags.group_id` refers to this table with ON DELETE SET NULL, and a migration
-- runs inside a transaction, where `PRAGMA foreign_keys` cannot be turned off.
-- So the drop below empties every tag's group, and the groups are kept aside
-- first and put back after.

CREATE TEMP TABLE kept_groups AS
  SELECT id, group_id FROM main.tags WHERE group_id IS NOT NULL;

CREATE TABLE main.tag_groups_next (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT INTO main.tag_groups_next (id, name, sort_order)
  SELECT id, name, sort_order FROM main.tag_groups;

DROP TABLE main.tag_groups;

ALTER TABLE main.tag_groups_next RENAME TO tag_groups;

CREATE INDEX main.idx_tag_groups_name ON tag_groups(name);

UPDATE main.tags
   SET group_id = (SELECT k.group_id FROM kept_groups k WHERE k.id = tags.id)
 WHERE id IN (SELECT id FROM kept_groups);

DROP TABLE kept_groups;
