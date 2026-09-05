-- Schema v11 — a subtitle is an asset, and the attachment is a row (ADR-0025).
--
-- Eagle answers "give this video a subtitle" with a folder per asset: drop the
-- `.srt` beside the video and it is found. This layout has no such folder —
-- originals are content-addressed and the forbidden-patterns list refuses both
-- a per-asset sidecar and a folder per asset — so adjacency cannot carry the
-- meaning. The `.srt` is an ordinary asset, and **this table is the sentence**
-- that says which video it captions.
--
-- Two consequences, both improvements on the convention it replaces. The
-- subtitle survives its source: delete the `.srt` from the disk it came from
-- and the track is still here, because the bytes were copied into the store at
-- import. And one track can caption many videos: identical bytes are one asset
-- by invariant 1, so the same translation attached to two encodes is stored
-- once and attached twice.
--
-- **The primary key is the pair**, so attaching the same track to the same
-- video twice is not representable rather than merely discouraged.
--
-- **`idx_subtitles_track` is for the other direction**, which is the question
-- asked constantly: *is this asset somebody's caption track?* Every grid query
-- asks it, because an attached track is hidden from the default scope — the
-- primary key cannot answer it, since `track_hash` is its second column.
--
-- `ordinal` orders the tracks of one video, so a menu lists them the way they
-- were attached. `lang` is BCP-47 where a filename or a stream declared one,
-- and NULL rather than a guess where nothing did. `label` is what a person
-- typed, and NULL until they do.

CREATE TABLE asset_subtitles (
  hash       TEXT    NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  track_hash TEXT    NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL,
  lang       TEXT,
  label      TEXT,
  PRIMARY KEY (hash, track_hash)
) WITHOUT ROWID;

CREATE INDEX idx_subtitles_track ON asset_subtitles(track_hash);
