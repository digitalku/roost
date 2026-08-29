-- Schema v6 — M4 derived work: the job queue, page counts, and the properties a
-- format-specific backend reports.
--
-- Everything here is derived from bytes, so none of it carries a journal op
-- (DATA_MODEL.md §2). Losing all of it costs time and never data: the queue
-- refills by scanning for assets whose derived data is missing.
--
-- The first migration this repository authors. See DATA_MODEL.md §2.5 for what
-- each choice buys, including what it costs a library that has to go back to
-- the Rust implementation.

ALTER TABLE assets ADD COLUMN page_count INTEGER;

CREATE TABLE asset_props (
  hash  TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (hash, key)
) WITHOUT ROWID;

CREATE TABLE jobs (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  hash        TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  priority    INTEGER NOT NULL DEFAULT 0,
  state       TEXT NOT NULL DEFAULT 'ready'
              CHECK (state IN ('ready', 'running', 'blocked', 'failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  reason      TEXT,
  enqueued_at INTEGER NOT NULL,
  UNIQUE (kind, hash)
);

CREATE INDEX idx_jobs_ready      ON jobs(priority, id) WHERE state = 'ready';
CREATE INDEX idx_jobs_unfinished ON jobs(kind, state)  WHERE state <> 'ready';
