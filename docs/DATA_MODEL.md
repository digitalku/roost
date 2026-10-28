# Roost — Data Model

Status: v5 · Last updated: 2026-09-26

> **The normative document is [`FORMAT.md`](FORMAT.md).** Directory layout, identity, the journal
> format and the forbidden patterns are requirements `RL-1` … `RL-56` there, and the document is
> this repository's own (ADR-0052).
>
> This file holds what the format deliberately does **not** cover: the **index schema**, which
> RL-2 puts outside it as a cache, and the **query language**, which the format calls an opaque
> string. If anything here contradicts `FORMAT.md`, the format wins and this file is the bug.
>
> §2.0 is the schema a Format 2 library starts with. [`STORAGE_SPEC.md`](STORAGE_SPEC.md) maps
> each `RL-n` to the code that meets it.

## Format 2 note (2026-09-21)

**The numbering starts again here** (ADR-0046). Version 1's fourteen migrations described a schema
keyed on the BLAKE3 hash of an asset's bytes, and version 2 identifies an asset by an id minted at
random (RL-13). Nothing migrates forward: no index at the old schema can reach this build, so there
was nothing to migrate from.

What that buys is a schema that can be read in one sitting — one baseline rather than a v1 plus
thirteen amendments, and no column that exists only because something else used to.

The rules that survive unchanged:

- **Never edit an applied migration.** Later changes go in a new numbered file.
- **Anything user-authored needs a journal `op`**, or it is a row a rebuild cannot produce
  (invariant 1, RL-24).
- **Anything derived from the bytes needs none**, and in version 2 that is much more than it was:
  the size, the dimensions, the duration, the page count and the content hash are all derived
  (RL-22) and none of them is journalled (RL-23).

Rule of thumb, and the cleanest test for whether an op is required: **if a user typed it or clicked
it, it goes in the journal. If a machine read it out of a file, it does not.**

---

## 1. Summary of the storage model

For orientation only; normative text is in the spec.

- **Identity is a minted id** (RL-13): twelve characters of Crockford base32, upper case, random,
  never reused. Not the hash of the bytes, not a path, not the name.
- **`journal/YYYY-MM.jsonl` is the source of truth.** Append-only, monthly rotation, UTC months.
- **`index.db` is a derived cache.** Deletable at will; rebuilt by replaying the journal.
- **`files/<2-char>/<id>.<ext>`** — one shard level, at most 1 024 buckets, created lazily, and
  **editable in place**: the bytes may change at any time, by any application (RL-20).
- **Thumbnails are WebP BLOBs in `thumbs/roost.db`**, a SQLite file of their own beside the
  index, never loose files (ADR-0051, §2.2).
- **Folders are collections** joined through `asset_folders`; assets carry no path column.
- **A content hash is kept as a derived attribute** (RL-18), for duplicate reports and `doctor`.
  It is never identity, never a filename, and never a reason to refuse a file.

## 2. The schema

### 2.0 Migration 0001 — the index a Format 2 library starts with (schema v1)

```sql
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
```

**The two PRAGMAs are deliberately not in the migration.** `journal_mode` cannot be set inside a
transaction and `foreign_keys` is per-connection, so both are applied when a connection is opened:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
```

**The `assets` table splits in two, and the split is what version 2 changed.** Everything down to
`poster_ms` is something a person said, and every one of those columns arrives through a journal
operation. Everything after it is read out of the file and is journalled by nothing — so a rebuild
drops all of it, and the derive pass puts it back.

**`created_at` is the exception that proves the rule.** It is the source file's own date at import,
and nothing can recover it afterwards: the stored file's date becomes the date of the last edit the
moment anybody saves it. So it is the one fact about a file that the journal carries (RL-22's
"derivable" does not cover a fact the bytes no longer hold).

**`mtime` and `size` together are how a change is noticed without reading the file.** A save
changes at least one of them, and the sweep that compares them is cheaper than hashing a library.

**`content_hash` is spelled out rather than called `hash`** so that no statement written against
version 1's schema — where `hash` was the primary key — can compile against this one and quietly
mean something else.

**One index per order the view menu offers** (ADR-0039), each with its tie-break pointing the same
way as its key, so one index serves both directions. Two of them index an **expression**, and the
expression is the definition of the order — indexed, ordered by, and compared in the resume,
spelled identically in all three places. `lower(name)` because sorting by name is case-insensitive
and SQLite's `lower()` folds ASCII only; `COALESCE` on the nullable columns because a NULL in a
keyset comparison yields NULL and silently drops rows.

`COALESCE(size, 0)` is version 2's own: a size is derived, so an asset nothing has read yet has
none, and the order has to place it somewhere rather than losing it.

**A resume is two seeks rather than one predicate.** The rows still to come are those further along
the key plus those with the same key and a later id, and as one disjunction SQLite seeks on the key
and then walks the whole run of equal keys. A rating has six values: page 500 cost 5.8 ms that way
and 0.06 ms as a `UNION ALL` of two ranges over `(key, id)`.

**No index for the random order and no possibility of one.** Its key is where one character of
the id falls in a reordered alphabet, `instr(@shuffleAlphabet, substr(a.id, @shuffleAt, 1))`, with
the id breaking ties, and an index per seed is an index per shuffle. ADR-0039 §5 records why that is
the right trade, and §11 why the key is an integer that ties: the first page sorts every match, and
a resume walks the rest of one character's run along the primary key.

**No journal op, no column, no table for the order itself.** It is a *preference*, not library
data: it lives in `settings.json` (ADR-0019, ADR-0039 §7) with the view, the icon shape and the
zoom.

### 2.1 Migration 0002 — the thumbnails leave the index (schema v2)

ADR-0051. `thumbs` moves out of `index.db` into `thumbs/roost.db` (§2.2), which the db module
attaches as `pictures` **before** any migration runs. The pictures are copied rather than dropped,
so an upgrade does not send a library back to placeholders, and `sources` is filled from each
asset's own derived columns, so the copied pictures survive a later rebuild too.

```sql
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
```

**It is idempotent, and has to be.** A transaction over two attached files in WAL mode is atomic in
each file but not across both, so a crash can commit the copy and not the drop. The migration then
runs again and the `ON CONFLICT` clauses make the second copy a no-op. The opposite interleaving
loses the copied pictures, and the backfill sweep draws them again.

**The open that runs it also runs `VACUUM main`, once.** A drop frees pages without returning them,
and the table that went was nearly all of the file. Without the pictures the index is small, so the
rewrite is of the rows alone.

### 2.2 The thumbnail database — `thumbs/roost.db`

Not the index and not a numbered migration: a cache of its own (ADR-0051), inside `thumbs/`, which
the format reserves (RL-56) and leaves to the implementation (RL-2). Named for this build so that
nothing else writing into `thumbs/` can collide with it. Its version is in `PRAGMA user_version`,
and it is at **2**. Version 1 is brought forward in place, by `ALTER TABLE … ADD COLUMN chosen`, so
an upgrade does not send a library back to placeholders. A file at any other version is emptied and
made again rather than migrated. That used to cost only time, because every row could be drawn
again from `files/`. **Since ADR-0060 it also loses the thumbnails somebody chose**, which are kept
here and nowhere else, by the user's choice: a row with `chosen = 1` is never drawn over, and a
changed file under it is measured again while its pictures stay.

```sql
-- What the pictures were drawn from, one row per asset. A thumbnail is reused
-- only while `file_size`, `file_mtime` and `poster_ms` still match the file and
-- the asset, and then so is everything else here -- which is what lets a
-- rebuild restore the derived columns without decoding or hashing anything.
--
-- `chosen` is 1 where somebody supplied the pictures (ADR-0060). Those are
-- never drawn over: a changed file is measured again and its pictures kept,
-- and `file_size` = -1 says the file has not been measured since.
CREATE TABLE pictures.sources (
  asset_id     TEXT PRIMARY KEY,
  file_size    INTEGER NOT NULL,
  file_mtime   INTEGER NOT NULL,     -- unix seconds, floored, as assets.mtime
  poster_ms    INTEGER,
  content_hash TEXT,
  width        INTEGER,
  height       INTEGER,
  duration_ms  INTEGER,
  page_count   INTEGER,
  props        TEXT,                 -- JSON object, or NULL for none
  chosen       INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- A rowid table on purpose: WITHOUT ROWID stores a row inside the B-tree, and a
-- row the size of a thumbnail is what SQLite's own guidance says not to put
-- there.
CREATE TABLE pictures.thumbs (
  asset_id TEXT NOT NULL,
  size     INTEGER NOT NULL,          -- longest edge: 256 or 512
  width    INTEGER NOT NULL,
  height   INTEGER NOT NULL,
  data     BLOB NOT NULL,             -- WebP, quality 80
  PRIMARY KEY (asset_id, size)
);
```

**`PRAGMA auto_vacuum = INCREMENTAL` is set before the first table, when the file is empty**, which
is the only moment it can be. Deleting a picture then frees pages that `incremental_vacuum` can hand
back. That is what *Reclaim space…* runs, instead of a `VACUUM` that would rewrite gigabytes.

**`sources` is what lets the pictures outlive the index.** A rebuild deletes `index.db` and leaves
this file alone. The derive pass that follows compares each asset's file with its `sources` row. If
the size, the modification time and the pinned frame all agree, the pictures are kept and the rest
of the row (the hash, the dimensions, the duration, the page count and the properties) is written
back into `assets` without the file being decoded or hashed. That is the same test ADR-0047 uses to
decide that a file changed, turned round. If anything disagrees, the asset's pictures and its source
are dropped and drawn again.

**No foreign keys, because they cannot cross files.** `applyRemove` deletes an asset's pictures in
the same transaction as its row. What a crash between the two files leaves, and what a rebuild
leaves when the journal no longer holds an asset, is removed by `prunePictures`: one `NOT IN` over
the primary key, run after every fold and by *Reclaim space…*.

**The backfill sweep asks two questions now.** It queues an asset with no thumbnail, *or* with
`derived_at IS NULL`. After a rebuild the second is true of every asset and the first of almost
none, and a sweep that asked only about pictures would leave the derived columns empty for ever.

### 2.3 Migration 0003 — a tag group's name need not be unique (schema v3)

ADR-0061. `tag_groups.name` loses its `UNIQUE`, and gains an ordinary index for the lookup by name.
**The rule did not go away; it moved.** A new name is refused before it is journalled
(`DuplicateTagGroupNameError`), as a folder's name is, and replay applies whatever the journal
holds. With the constraint in the index, a duplicate that reached the journal was refused by the
index after the line was written, the refused id was handed to the next group, and every later
rebuild of that library stopped at the line.

```sql
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
```

**The tags' groups are kept aside, because the drop empties them.** `tags.group_id` refers to this
table with `ON DELETE SET NULL`, and a migration runs inside a transaction, where
`PRAGMA foreign_keys` cannot be turned off; so dropping the old table sets every tag's group to
`NULL`, and the temporary table puts them back. `findTagGroupByName` answers the oldest group of a
name, since two may now share one.

## 3. Roost Query Language (RQL)

The search bar and smart folders share one grammar. It compiles to SQL with **bound
parameters only** — never string concatenation. This is user input reaching SQL, so the
parser is fuzz-tested.

Terms are gated on the schema that backs them; a term whose column does not exist yet is a
parse error with a clear message, not a silent empty result.

The grammar is frozen by compatibility, not by preference. A smart folder stores its query
text, so a query this implementation cannot parse is a folder the user loses.

**What that costs is now forward-only.** The freeze was written when a library had to open in
both implementations; the user retired that requirement on 2026-08-29 (`CLAUDE.md` §1.1), so an
*addition* costs only that a smart folder written by this build cannot be parsed by an older
build of this one. Changing or removing a term still costs what it always did. `infolder:` was
added on that basis (ADR-0036 §5); `kind:` was declined on it (ADR-0035 §3.4) and could be
reconsidered.

**Specified — implemented in the Rust engine, and M2's job here**
```
tag:wood                      tag equals, case-insensitive as the schema stores it
tag:"brand assets"            quoted values; "" escapes a quote inside one
group:Materials               any tag in that group
-tag:wip                      negation
folder:Moodboards             folder and everything beneath it
folder:Design/Icons           nested path; a bare name matches every folder so named
                              (a folder name may therefore not contain "/", and two
                               siblings may not share one)
infolder:Moodboards           that folder alone, no descendants (ADR-0036). Same path
                              resolution as `folder:`; the two differ only in depth
ext:png                       extension, with or without the dot
size:>10mb                    byte size; kb/mb/gb are binary multiples, 1.5mb is fine
w:>2000  h:<=1080             dimensions
duration:>30s                 ms/s/m/h; a bare number is seconds
created:2024-01-01..2024-12-31
created:2024-03-01            a bare date is the whole day, not midnight exactly
imported:>2026-01-01
rating:>=4                    1 to 5; anything else is a parse error, not an empty result
is:untagged is:tagged is:rated is:unrated
is:favorite                   retired (ADR-0029) and still in the grammar: nothing sets one
                              any more, and a smart folder that says it must still parse
is:trashed                    in the trash; also `is:trash`
is:subtitle                   attached as somebody's caption track; also `is:subtitles`
is:captioned                  has at least one caption track
olahrag                       FTS5 over the name, tags, note, and comments; a bare word
                              is the start of a word (ADR-0057 §7)
"free text"                   the same, its words whole
```

Implicit `AND` between adjacent terms; `OR` and parentheses are explicit; a leading `-`
negates. Precedence, loosest first: `OR`, `AND`, negation, term.

Four behaviours are worth stating because they are decisions, not accidents:

- **A bare date covers its whole day.** `created:2024-03-01` compiles to a range ending at
  23:59:59 UTC. Matching midnight exactly would return nothing, which is never what was
  meant. Dates resolve in UTC because the stored timestamps are UTC.
- **An unknown field is an error, with a byte offset.** `colour:red` does not quietly become
  a full-text search for "colour:red" — the user asked a question this build cannot answer,
  and an empty grid would not say so.
- **Free text is searched as a phrase.** FTS5's `MATCH` argument is a query language of its
  own, so raw text would let `AND`, `NEAR`, `*`, or a stray quote change or break the
  search. Quoting the whole input is what a person typing into a search box means.
  **A bare term's last word is a prefix** — `olahrag` binds `"olahrag"*` — and a quoted term
  binds the phrase alone, so `"olahrag"` finds only the whole word (ADR-0057 §7).
- **Negation is total.** `-tag:wip` is `NOT (…)` over the whole library, so it includes
  assets with no tags at all.
- **Every query is scoped by two rules, and naming a flag opts out of that rule only.** Not in
  the trash (ADR-0022) and not attached as somebody's caption track (ADR-0025). Version 1 had a
  third — not superseded — and version 2 does not, because an edit no longer makes a second asset
  (ADR-0046). The rules live in one table in `@roost/search`'s compiler; the third such rule is
  where a pattern becomes a design and the fourth is where it becomes a bug. Trash is a state,
  not a place, so a trashed asset is still a row `tag:wip` would otherwise match —
  and an application where deleting something leaves it in every search is one where deleting
  does not work. The compiler appends `a.trashed_at IS NULL` to anything that does not name the
  flag, in any polarity and at any depth. The consequence worth knowing: `is:favorite OR
  is:trashed` is *not* scoped, so it answers with live favourites and every trashed asset. The
  alternative — a scope argument threaded through the engine, the CLI, and the renderer — puts
  the same rule in three places, and one of the three eventually forgets it.
- **`group:` reaches assets through the tags in the group**, since a group arranges tags
  rather than containing assets. It was added with the groups themselves so the CLI can
  answer "everything tagged with anything in Materials" — ADR-0005 does not let the GUI
  have a capability the CLI lacks.

**Arriving at M5**
```
color:#3a7fd5~15              dominant colour within CIELAB ΔE 15
similar:<id>                  perceptual-hash neighbours
is:duplicate
```

Implicit `AND` between terms; `OR` and parentheses supported. Grammar, parser, and SQL
compiler live in `@roost/search`.

### Notes on compiling RQL

- `is:duplicate` could mean "same content hash" in version 2, where two assets may hold
  identical bytes — but it does not: it means *perceptually* near-duplicate, via `asset_hashes`,
  and is therefore M5. Exact duplicates are what an import reports (ADR-0037).
- `folder:` matches the folder and its descendants, and `infolder:` matches the folder
  alone (ADR-0036). The ids are expanded **before** compiling, by a `Folders` resolver the
  caller supplies, rather than by a recursive CTE inside every query: a folder tree is
  user-made and small, and expanding it keeps the compiled SQL simple and lets
  `@roost/search` be tested without a database. A smart folder recompiles on every run, so
  the expansion cannot go stale. The two terms share one path resolution and differ only in
  whether it descends, which is what lets the *Show subfolder contents* checkbox rewrite one
  into the other without changing what was asked.
- **The setting never changes what a term means**, only which one the sidebar writes. That is
  the whole of ADR-0036 and the reason it is a term at all: a smart folder stores its query
  *text*, so a `folder:` saved months ago has to keep asking the same question.
- A **path** resolves to at most one folder — names are unique among siblings, which is what
  makes `Design/Icons` name one thing. A **bare name** is tried only when no path matches, and
  then it matches *every* folder with that name, subtrees included. That is deliberate and it
  matches the Rust build: someone typing `folder:Icons` wants the folder they are looking at,
  and refusing because a second one exists elsewhere would be a worse answer than including
  both. Folding is ASCII-only, so it agrees with `COLLATE NOCASE` and with `tag:`.
- `tag:` names exactly one tag, always. Tags are flat and `tags.name` is globally
  `UNIQUE COLLATE NOCASE`; migration 0004 added groups to arrange them, deliberately
  choosing that over hierarchy so the guarantee survives (§2.3).
- Result paging is keyset-based on `(imported_at, hash)`, never `OFFSET`. Migration 0003
  put that exact order in the index, so both the sort and the resume are seeks.
- The parser is the one place user input becomes SQL, so it is property-tested rather than
  example-tested: any input string must either produce an AST or a positioned error, and must
  never produce SQL text containing a character the user typed.
- `duration:` compiles today but matches nothing: `assets.duration_ms` exists in schema v1
  and stays `NULL` until M4 fills it. The term is not gated, because the column is there —
  the gating rule is about columns that do not exist.

## 4. What a JavaScript implementation must be careful about

Non-normative, and specific to this port. Each of these is a place where the Rust
implementation got a guarantee from its type system that this one has to test for.

**Integers.** `size`, `imported_at`, `created_at`, and `duration_ms` are SQLite integers, and a
file can exceed `Number.MAX_SAFE_INTEGER` bytes only in theory.

This section previously said `better-sqlite3` returns `BigInt` for values that do not fit a
double, and only when they do not. **Measured on 2026-08-24 against 13.0.3, that is wrong, and
wrong in the worse direction.** Storing `9007199254740993` and reading it back returns the
`number` `9007199254740992` — no `BigInt`, no error, one lost unit. `BigInt` is not a default
the driver falls into; it is a mode (`safeIntegers`) that must be asked for, and asking for it
turns *every* integer into a `bigint`, including the row ids and counts that arithmetic here
treats as numbers.

So the decision is to read integers as `number` and to keep the boundary out of reach rather
than handle it: no column in this schema can approach 2^53. `size` would need a nine-petabyte
file, `imported_at` a date 285 million years out, and the ids are row counters. What is worth
writing down is that the failure mode is silent rounding rather than a type surprise — a
`typeof` check would never have caught it, and a corrupt or hostile database is the only way to
reach it.

**Placeholders are not all the same placeholder.** SQLite accepts `?`, `?NNN`, and `@name`;
`better-sqlite3` does not treat them alike. It reads `?NNN` as a *named* parameter and refuses
to bind it positionally, so a statement ported from the Rust build unchanged fails with "too
many parameter values were provided" no matter how many values it is given. This matters
because the numbering was load-bearing there: the keyset predicate writes the cursor's
timestamp twice, and numbering both occurrences as one parameter is what lets SQLite recognise
a range and seek instead of walking the index from the newest row — 23x on page 200 of a
50,000-asset library, in that build's own benchmark.

The port keeps the property and changes the spelling: the cursor and the limit are bound **by
name**, and a compiled RQL filter keeps its anonymous `?`. Mixing the two in one statement
works — the anonymous ones are bound positionally from the argument list, the named ones from a
trailing object — and it also drops the parameter counting the Rust version had to thread
through, since nothing appended needs to know how many placeholders the filter used.

**A boolean is not a bindable value.** `better-sqlite3` binds numbers, strings, bigints,
buffers, and `null`, and throws a `TypeError` on anything else. `undefined` is the exception it
makes quietly, binding as `NULL`. Neither is worth relying on: `is_favorite` and
`is_partial_hash` are `INTEGER CHECK (… IN (0, 1))` in the schema, so the conversion belongs at
the call site that knows which column it is filling, and an optional journal field is written
`?? null` rather than left to a convenience the driver does not document.

**`NULL` is not `undefined`.** The schema uses `NULL` to mean "unrated", "no note", "top-level
folder", and the journal ops for those carry an explicit `null` rather than omitting the field
(RL-37, and the registry's notes). `JSON.stringify` drops `undefined` and keeps `null`,
so the difference between clearing a rating and not mentioning it is one keystroke in the code
and invisible in review. Journal records are built by constructors that take `null`, never by
spreading an object that might carry `undefined`.

**`COLLATE NOCASE` is not `toLowerCase()`.** `tags.name` is unique under SQLite's `NOCASE`,
which folds ASCII only. JavaScript's `toLowerCase` folds Unicode. Deduplicating tag names in JS
before the insert would make `İ` and `i̇` collide in one implementation and not the other. Let
the database decide uniqueness; never pre-fold.

**Dates.** Every timestamp in the schema and the journal is unix **seconds**, UTC.
`Date.now()` is milliseconds. RQL date terms resolve in UTC because the stored values are UTC,
and a bare date covers its whole day — `new Date('2024-03-01')` already parses as UTC midnight,
but `new Date(2024, 2, 1)` does not, and the two are one habit apart.
