-- Schema v2: the thumbnails leave the index (ADR-0051), verbatim from
-- docs/DATA_MODEL.md §2.1.
--
-- They move to thumbs/roost.db, which the db module attaches as `pictures`
-- before any migration runs. Copied rather than dropped, so an upgrade does not
-- send a library back to placeholders; `sources` is filled from the asset's own
-- derived columns, which is what lets the copied pictures survive a later
-- rebuild.
--
-- Idempotent on purpose. A transaction over two attached files in WAL mode is
-- atomic in each file but not across both, so a crash can leave the copy
-- committed and this migration not -- and then it simply runs again.

INSERT INTO pictures.sources (asset_id, file_size, file_mtime, poster_ms, content_hash,
                              width, height, duration_ms, page_count, props)
  SELECT a.id, a.size, a.mtime, a.poster_ms, a.content_hash,
         a.width, a.height, a.duration_ms, a.page_count,
         (SELECT json_group_object(p.key, p.value) FROM main.asset_props p
           WHERE p.asset_id = a.id HAVING count(*) > 0)
    FROM main.assets a
   WHERE a.size IS NOT NULL AND a.mtime IS NOT NULL
     AND EXISTS (SELECT 1 FROM main.thumbs t WHERE t.asset_id = a.id)
  ON CONFLICT (asset_id) DO NOTHING;

INSERT INTO pictures.thumbs (asset_id, size, width, height, data)
  SELECT asset_id, size, width, height, data FROM main.thumbs WHERE true
  ON CONFLICT (asset_id, size) DO NOTHING;

DROP TABLE main.thumbs;
