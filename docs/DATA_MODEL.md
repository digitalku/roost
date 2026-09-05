# Roost — Data Model

Status: v3 · Last updated: 2026-08-24

> **The authoritative document is [`STORAGE_SPEC.md`](STORAGE_SPEC.md).** It is binding:
> directory layout, invariants, hashing, import modes, schema v1, journal format, and
> forbidden patterns all live there. This file holds only what the spec does not cover —
> the query language, and the plan for schema growth beyond v1.
>
> If this file ever contradicts `STORAGE_SPEC.md`, the spec wins and this file is the bug.

## Port note (2026-08-24)

Carried over from the Rust implementation at `../roost-old`, which built all of it. Nothing in
the schema or the grammar changed when the language did, and nothing may: a library written by
either implementation opens in the other, and a smart folder saved in one has to evaluate the
same way in the other.

So **migrations 0001–0005 are carried over verbatim**, numbers included. This repository does
not get to consolidate them into a single v5 baseline, tempting as that is with no users yet —
a library created by `roost-old` arrives already at schema v5 with those five rows in its
migration bookkeeping, and a fresh baseline would either re-run against it or disagree about
what version it is. The first migration this project authors is **0006**.

The RQL section below describes a grammar that exists and is tested — in the other repository.
Here it is a specification to be implemented in M2, and the acceptance test is a corpus of
queries with their expected compiled SQL, taken from the Rust implementation's own tests.

---

## 1. Summary of the storage model

For orientation only; normative text is in the spec.

- **Identity is the BLAKE3 content hash.** Not a UUID, not a path. Dedupe is therefore
  automatic: importing the same bytes twice yields one asset.
- **`journal/YYYY-MM.jsonl` is the source of truth.** Append-only, monthly rotation.
- **`index.db` is a derived cache.** Deletable at will; rebuilt by replaying the journal.
- **`originals/<2-hex>/<full-hash>.<ext>`** — one shard level, 256 buckets, created lazily.
- **Thumbnails are WebP BLOBs inside `index.db`**, never loose files.
- **Folders are collections** joined through `asset_folders`; assets carry no path column.

## 2. Schema growth plan

Schema v1 in the spec is deliberately minimal — it covers M1–M3. Later milestones add
columns and tables through **numbered migrations**, never by editing an applied migration.
Each addition also needs a journal `op` if it stores user-authored state, otherwise it
violates invariant 6.

| Milestone | Addition | Journal op needed |
| --- | --- | --- |
| M2 | `assets.rating`, `assets.note`, `assets.is_favorite` | yes — `rate`, `note_set`, `favorite_set` |
| M2 | `smart_folders(id, name, query, parent_id)` | yes — `smart_folder_*` |
| M2 | folder rename/move/delete, asset rename, tag rename | yes — new ops, see spec notes |
| M4 | `assets.page_count`, capability/probe results | no — derived from the file |
| M3 | `assets.trashed_at` | yes — `trash`, `restore` |
| M5 | `asset_colors(hash, rank, l, a, b, ratio)` | no — derived |
| M5 | `asset_hashes(hash, dhash, phash)` | no — derived |
| M5 | `asset_stacks(stack_id, hash, position, is_cover)` | yes — user-authored grouping |
| M5 | `watched_roots(path, recursive, enabled, last_scan)` | yes — configuration |
| — | `asset_comments(id, hash, at_ms, body, created_at, updated_at)` | yes — `comment_add`, `comment_set`, `comment_remove` |
| — | `assets.superseded_by` | yes — `supersede` |

Rule of thumb, and the cleanest test for whether an op is required: **if a user typed it or
clicked it, it goes in the journal. If a machine derived it from bytes, it does not.**

Derived tables (`thumbs`, `assets_fts`, colors, perceptual hashes) are rebuilt by
re-processing `originals/`, so they stay exempt from the journal.

### 2.1 Migration 0002 — M2 organize (schema v2)

Landed 2026-08-21 in the Rust engine; carried over here unchanged. Published here rather than in `STORAGE_SPEC.md` because the
specification's schema block is v1 and stays v1; growth lives in this file.
`packages/core/tests/spec-conformance.test.ts` asserts the migration still matches
this block, so the two cannot drift.

```sql
ALTER TABLE assets ADD COLUMN rating INTEGER
      CHECK (rating IS NULL OR rating BETWEEN 1 AND 5);

ALTER TABLE assets ADD COLUMN note TEXT;

ALTER TABLE assets ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0
      CHECK (is_favorite IN (0, 1));

CREATE INDEX idx_assets_rating   ON assets(rating)      WHERE rating IS NOT NULL;
CREATE INDEX idx_assets_favorite ON assets(is_favorite) WHERE is_favorite = 1;

CREATE TABLE smart_folders (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER REFERENCES smart_folders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  query      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_smart_folders_parent ON smart_folders(parent_id);
```

Three choices in that block are load-bearing:

- **`rating IS NULL` means unrated**, which is not the same as a deliberate one
  star. A `0` sentinel would make "show me everything I have not rated yet"
  indistinguishable from "show me what I rated lowest".
- **The indexes are partial.** `rating:>=4` and `is:favorite` select a small
  minority of a large library; indexing only matching rows keeps both the index
  size and the write cost proportional to what is actually rated.
- **A smart folder stores its query, not its results.** It is evaluated on read,
  so it cannot go stale, and `query` is parsed into bound parameters — never
  concatenated into SQL.

### 2.2 Migration 0003 — the keyset index (schema v3)

Approved and landed 2026-08-21 in the Rust engine; carried over here unchanged.

```sql
DROP INDEX idx_assets_imported;

CREATE INDEX idx_assets_imported ON assets(imported_at DESC, hash);
```

The grid pages on `(imported_at, hash)`, not on `imported_at` alone, because
`imported_at` is **not unique** — a bulk import writes thousands of assets in
the same second, and without a tie-break column keyset paging can show the same
asset twice or skip it entirely. Holding that order in the index is what makes
paging cost the same at row 900,000 as at row 100; without it SQLite sorts the
second column itself, reading the whole table into a temporary B-tree to produce
the first screen.

It **replaces** the single-column index rather than joining it. An index on
`(imported_at DESC, hash)` already serves any query that orders by
`imported_at` alone, since that is its leading column, so keeping both would
buy nothing and cost a second index to maintain on every insert. Roughly 90 MB
at one million assets.

### 2.3 Migration 0004 — tag groups (schema v4)

Decided and landed 2026-08-21 in the Rust engine, after weighing it against hierarchical
tags; carried over here unchanged.

```sql
CREATE TABLE tag_groups (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE tags ADD COLUMN group_id INTEGER
      REFERENCES tag_groups(id) ON DELETE SET NULL;

CREATE INDEX idx_tags_group ON tags(group_id) WHERE group_id IS NOT NULL;
```

**Groups organize tags; they do not nest them.** `tags.name` stays globally
`UNIQUE COLLATE NOCASE`, so `tag:icons` names exactly one tag however many
groups exist.

That is the whole reason this was chosen over hierarchical tags. Hierarchy
would have forced `UNIQUE(parent_id, name)`, letting `design/icons` and
`nature/icons` coexist — and from that moment `tag:icons` is ambiguous, and
every query either has to spell out a full path or accept an answer that mixes
two unrelated concepts. Grouping buys the readable sidebar without buying the
ambiguity, and it is what Eagle itself does.

`ON DELETE SET NULL`, never `CASCADE`: deleting an arrangement must not delete
the tags arranged by it, nor unpick every asset carrying them.

### 2.4 Migration 0005 — grid filter indexes (schema v5)

Approved and landed 2026-08-24 in the Rust engine; carried over here unchanged. See `docs/adr/0006-grid-filter-indexes.md` for the measurements and the
options it was chosen against.

```sql
DROP INDEX idx_assets_ext;
DROP INDEX idx_assets_rating;
DROP INDEX idx_assets_favorite;

CREATE INDEX idx_assets_ext      ON assets(ext, imported_at DESC, hash);

CREATE INDEX idx_assets_rating   ON assets(rating, imported_at DESC, hash)
                                 WHERE rating IS NOT NULL;

CREATE INDEX idx_assets_favorite ON assets(is_favorite, imported_at DESC, hash)
                                 WHERE is_favorite = 1;
```

Every grid query filters, orders by `(imported_at DESC, hash)`, and takes one screen. Given a
single-column index on the filtered column, SQLite seeks the matches through it and sorts all
of them in a temporary B-tree to produce two hundred — so `ext:png`, matching a fifth of the
library, read and sorted a fifth of the library for one screen: **18.9 ms at 96,666 assets**,
against a budget of 100 ms p95 at a million. `ANALYZE` does not change the plan; SQLite costs
the sort but not the early exit the LIMIT allows.

Carrying the sort key inside the filter index means the index is already in the order asked
for. SQLite seeks the filtered range and walks it until the LIMIT is satisfied: **0.51 ms**,
and the cost is now the page rather than the match set.

Each index **replaces** its predecessor, whose column is the new one's leading column, so
nothing the old index answered is lost. The partial ones stay partial for the reason §2.1
gives.

`size`, `width`, `height`, and `duration` are deliberately left unindexed. Having no index is
why SQLite already walks the ordering index and stops at the LIMIT for those terms — which is
the plan this migration buys everywhere else. Adding one would create the problem.

### 2.5 Migration 0006 — M4 derived work (schema v6)

Decided and landed 2026-08-29, and **the first migration this repository authors**. Everything it
adds is derived from bytes, so nothing here takes a journal op.

```sql
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
```

**`page_count` is a column and font family is not.** A page count is a number every document
format has, it sorts, and RQL will want `pages:>10` — that is a column. A font's family name, a
video's codec, an audio file's sample rate are open-ended, format-specific, and absent for most
assets: a column each would be a migration per format and a mostly-null table. `asset_props` takes
those, keyed `(hash, key)` and `WITHOUT ROWID` because the primary key *is* the row.

The key vocabulary is fixed in `@roost/media`, not open to callers, so the table cannot quietly
become a place to stash anything:

| Key | Set for | Example |
| --- | --- | --- |
| `font.family` | fonts | `Adwaita Sans` |
| `font.style` | fonts | `Regular` |
| `font.glyphs` | fonts | `2937` |
| `video.codec` | video | `h264` |
| `video.fps` | video | `30` |
| `audio.codec` | audio | `mp3` |
| `audio.channels` | audio | `2` |
| `audio.sampleRate` | audio | `44100` |

**One job row per `(kind, hash)`, and a finished job is deleted.** The queue holds outstanding
work, not a history: an asset's derived data is its own record that the work happened, and a table
that accumulated a row per completed job would grow to the size of the library for no reader. What
stays behind is what still needs attention — `blocked` for work waiting on a capability the machine
does not have (`ARCHITECTURE.md` §3.3), `failed` for work that was tried and did not survive, both
carrying `reason`. That is what lets the UI say *"12 videos are waiting for ffmpeg"* rather than
showing twelve blank cells.

**`running` is a claim, not a state that survives.** A crash leaves rows claimed by a process that
no longer exists, so the runner resets `running` to `ready` when it starts. Re-running a derive is
idempotent — it recomputes from the same bytes — so a job that was in flight is cheaper to repeat
than to reason about.

**The indexes match the two questions asked of this table.** `idx_jobs_ready` is partial on the
one state a claim looks at, so the claim query never walks rows that are blocked or failed, and it
is ordered by `(priority, id)` — which *is* the claim order, so the runner seeks and stops rather
than sorting the backlog. `idx_jobs_unfinished` is the mirror image, for the counts the UI shows.
Both are partial in the direction that keeps them proportional to the work outstanding rather than
to the library.

**What this costs a library that goes back.** `roost-old` understands schema v5 and refuses
anything newer, so a library this build has opened will not open there again — measured: every one
of its commands stops at *"library uses schema version 6, but this build supports up to 5"*,
`rebuild` included, because it opens the library before rebuilding it. Deleting `index.db` first
lets it in, and its own replay restores the library from the journal.

**That is a fact about a discontinued build, not a cost being paid.** The user retired the
obligation on 2026-08-29: `roost-old` is not a target, schema growth is what M4 through M7 are made
of, and holding v5 to keep a dead build readable would trade every later milestone for it. The
direction that still matters — a library it wrote opening *here* — is tested and unaffected.

### 2.6 Migration 0007 — trash is a column (schema v7)

Decided by the user on 2026-09-01 and recorded as ADR-0022: `Delete` moves an asset to the
trash, nothing is ever emptied on a schedule, and permanent removal is a second, deliberate
gesture.

```sql
ALTER TABLE assets ADD COLUMN trashed_at INTEGER;

DROP INDEX idx_assets_imported;
DROP INDEX idx_assets_ext;
DROP INDEX idx_assets_rating;
DROP INDEX idx_assets_favorite;

CREATE INDEX idx_assets_imported ON assets(imported_at DESC, hash)
                                 WHERE trashed_at IS NULL;

CREATE INDEX idx_assets_ext      ON assets(ext, imported_at DESC, hash)
                                 WHERE trashed_at IS NULL;

CREATE INDEX idx_assets_rating   ON assets(rating, imported_at DESC, hash)
                                 WHERE rating IS NOT NULL AND trashed_at IS NULL;

CREATE INDEX idx_assets_favorite ON assets(is_favorite, imported_at DESC, hash)
                                 WHERE is_favorite = 1 AND trashed_at IS NULL;

CREATE INDEX idx_assets_trashed  ON assets(imported_at DESC, hash)
                                 WHERE trashed_at IS NOT NULL;
```

**A column, because trash is a state.** A `Trash` folder was the obvious alternative and is
wrong: a folder is a collection an asset can be in *as well as* others, so being in Trash would
not take it out of anything. Moving the bytes to a `trash/` directory is wrong twice over — it
breaks the content-addressed layout invariant 2 exists to protect, and for a `referenced` asset
it would write into a user's own directory, which invariant 6 forbids.

**It preserves the row, because the row is the expensive half.** `remove` already leaves the
bytes for a deliberate `doctor --reclaim`, so the *file* had a grace period all along; what had
none was the tags, the rating, the note, and the folder memberships. A file imported once can be
imported again. Forty tags applied by hand over a month cannot.

**The scope predicate is part of the schema.** SQLite uses a partial index only when the query's
WHERE clause contains a term implying the index's, so `a.trashed_at IS NULL` has to be spelled
exactly that way to keep the plans migration 0005 bought. It is written in one place —
`@roost/search`'s compiler, which scopes every query unless it mentions `is:trashed` — and
`repo.test.ts` asserts the plans in both directions rather than trusting it.

**Nothing empties on a timer.** Eagle empties after thirty days. An application that deletes a
person's files on a schedule, possibly while they are not looking, is not one this project ships:
`CONCEPT.md` §2 makes the library outlive the application, and a background deleter is the one
thing that could make that false.

### 2.7 Migration 0008 — comments carry a moment (schema v8)

Decided by the user on 2026-09-02 and recorded as ADR-0023, after they asked for comments at a
video timestamp: a comment is a row of its own, the moment is a column, and the whole thing is
journalled so that it survives a rebuild like every other thing a person types.

```sql
CREATE TABLE asset_comments (
  id         INTEGER PRIMARY KEY,
  hash       TEXT    NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  at_ms      INTEGER CHECK (at_ms IS NULL OR at_ms >= 0),
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

CREATE INDEX idx_comments_asset ON asset_comments(hash, at_ms, id);
```

**A row, not a field.** `assets.note` is one note and stays one note — the thing an asset is
*about*. A comment is one of many and is edited on its own, so it needs an identity a journal op
can name. The alternative, a JSON array in a column, fails on concurrent editing before it fails
on anything else: every edit rewrites the whole array, so two windows editing two different
comments on one asset would each write a complete set and the later one would discard the other's
work without saying so. Per-comment ops cannot lose an edit that way.

**`at_ms` is nullable, and the null means something.** No moment is a comment about the asset —
so a `.zip` can carry comments too, and the timeline case is one value of one column rather than a
second feature beside it. It is the one number in the format that is **not** seconds; `at` in the
journal line is milliseconds, while the line's own `ts` stays unix seconds and is what
`created_at` is replayed from.

**Positions other than time are deliberately absent.** A PDF has pages, an image has rectangles,
and both are different decisions. Eagle unifies all three in one comment type — worth knowing, and
worth revisiting when the second one is actually wanted rather than guessed at here.

**Cascade, so trash and remove keep meaning what they mean.** Trashing marks the asset and its
comments stay with it, exactly as its tags do (ADR-0022); `remove` deletes the row, and the
foreign key takes the comments with it.

### 2.8 Migration 0009 — a thumbnail can be pinned to a moment (schema v9)

Asked for by the user on 2026-09-02 while ADR-0024 was being written, and decided there as its
fourth stage: right-click a video, and set the frame it is paused on as the asset's thumbnail.

```sql
ALTER TABLE assets ADD COLUMN poster_ms INTEGER CHECK (poster_ms IS NULL OR poster_ms >= 0);
```

**The thumbnail does not stop being a function of the file — it becomes a function of the file and
one number.** That is the whole design, and it is what keeps invariant 1 intact. The journal
records *where to look*, never the pixels: a rebuild replays `poster_set`, the derive pass
re-extracts the frame at that offset, and the picture comes back from `originals/` plus the journal
like every other derived artefact. Storing the image itself would be base64 in a text file, which
the forbidden-patterns list refuses twice over.

**`NULL` is the default frame, and it is not the first one.** The video backend takes a frame a
tenth of the way in, capped at ten seconds, because a first frame tends to be a slate or a fade
from black. Clearing is `poster_set` with `"at":null` rather than an op of its own: "use the
default again" and "use this moment" are the same decision with one value absent.

**Milliseconds, like a comment's `at_ms`**, and for the same reason — this is an offset into a
medium, not a date.

**No index.** It is read one asset at a time, by the derive pass and by nothing else, always beside
the row it belongs to. It also travels on the grid's card and on the asset detail, because it is
part of the thumbnail's *address*: `roost://thumb/<hash>@<size>` is served as immutable on the
promise that a hash and a size fix the pixels, and a pinned frame is the one thing that can change
them. The moment goes in the URL's query so the promise stays true and a changed thumbnail is a
changed address (ADR-0008, amended).

**A different ffmpeg build may land a frame away** on a long-GOP file, where a seek resolves to the
nearest decodable frame. Acceptable, and said out loud rather than discovered in a conformance
test: the instruction is the durable thing and the thumbnail is a cache.

### 2.9 Migration 0010 — an edit is a new asset (schema v10)

Decided and built 2026-09-03 as ADR-0026 stage 2, from the user asking for text to be editable
inside Roost. Identity is the content hash, so a save cannot be a write: the new bytes are a
different asset, and this column says which one replaced which.

```sql
ALTER TABLE assets ADD COLUMN superseded_by TEXT REFERENCES assets(hash);

DROP INDEX idx_assets_imported;
DROP INDEX idx_assets_ext;
DROP INDEX idx_assets_rating;
DROP INDEX idx_assets_favorite;
DROP INDEX idx_assets_trashed;

CREATE INDEX idx_assets_imported ON assets(imported_at DESC, hash)
                                 WHERE trashed_at IS NULL AND superseded_by IS NULL;

CREATE INDEX idx_assets_ext      ON assets(ext, imported_at DESC, hash)
                                 WHERE trashed_at IS NULL AND superseded_by IS NULL;

CREATE INDEX idx_assets_rating   ON assets(rating, imported_at DESC, hash)
                                 WHERE rating IS NOT NULL AND trashed_at IS NULL
                                   AND superseded_by IS NULL;

CREATE INDEX idx_assets_favorite ON assets(is_favorite, imported_at DESC, hash)
                                 WHERE is_favorite = 1 AND trashed_at IS NULL
                                   AND superseded_by IS NULL;

CREATE INDEX idx_assets_trashed  ON assets(imported_at DESC, hash)
                                 WHERE trashed_at IS NOT NULL AND superseded_by IS NULL;
```

**It took 0010 although §2.5's table and ADR-0025 both name that number for subtitles.** The
number goes to whatever is built, because a reserved gap is a migration that can never run: the
runner records version numbers and applies only what is higher than the library's, so a 0010
arriving after a library had reached 11 would be skipped in silence. **Subtitles take 0011.**

**One step forward, and the chain is history.** Following `superseded_by` gives every version
oldest to newest. Nothing prunes it and nothing expires: removing an old version is `remove` on
that hash, a second and deliberate gesture, exactly as ADR-0022 decided for the trash.

**Not the trash, and not `asset_stacks`.** The user did not delete the old version — a Trash place
filling with intermediate saves is one nobody opens — and a stack (M5) is a *user-made* grouping of
assets that are different things, where a version chain is automatic and directional.

**The carry-over is journalled, never copied in SQL.** Tags, folders, rating, note, favourite, the
pinned poster moment and the comments travel to the replacement through the ops that own them —
`tag_add`, `folder_add`, `rate`, `note_set`, `favorite_set`, `poster_set`, `comment_add` — so a
rebuild reconstructs it from the journal rather than from a rule that happened to be in the code
which replayed it (invariant 1). A comment is **copied**: the old version keeps its own, so the
copies are new rows whose `created_at` is the save rather than the original remark.

**The five grid indexes gained the second half of the default scope.** Migration 0007 made them
partial on `trashed_at IS NULL`; they now carry `AND superseded_by IS NULL`, and `MATCH_LIVE` plus
`@roost/search`'s scope table spell the predicate in exactly that order. SQLite uses a partial
index only when the query's WHERE contains a term implying the index's, so the spelling is part of
the schema — `repo.test.ts` asserts that half the scope loses the index, which is the failure that
would otherwise be silent and slow.

### 2.10 Migration 0011 — a subtitle is an asset (schema v11)

Decided as ADR-0025 on 2026-09-03 and built on 2026-09-05, from the user asking how Roost should do
what Eagle does with an `.srt` dropped beside a video. Eagle's answer is a folder per asset, which
this layout does not have — so adjacency cannot carry the meaning, and **the attachment is a row**.

```sql
CREATE TABLE asset_subtitles (
  hash       TEXT    NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  track_hash TEXT    NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL,
  lang       TEXT,
  label      TEXT,
  PRIMARY KEY (hash, track_hash)
) WITHOUT ROWID;

CREATE INDEX idx_subtitles_track ON asset_subtitles(track_hash);
```

**The `.srt` is an ordinary asset.** Content-addressed like everything else, which buys two things
the convention it replaces does not have: the subtitle survives its source (delete the file from
the disk it came from and the track is still here), and one track can caption many videos, stored
once and attached twice.

**Two journal ops**, because the attachment is a judgement a person made about two files and
nothing in either file's bytes implies it (invariant 9): `subtitle_attach { hash, track, lang?,
label? }` and `subtitle_detach { hash, track }`. Detach un-says the sentence and deletes nothing.

**`ordinal` is not carried by the op.** It is the count of what is already attached, computed at
apply time, so a replay produces the order it recorded without the journal having to state it.

**The third hidden-by-default rule, and the first that cannot be indexed.** An attached track leaves
the grid — the rule is about *attachment, not format*, so an `.srt` imported on its own is an
ordinary text asset and appears like one — and `is:subtitle` finds it again. Unlike `trashed_at IS
NULL` and `superseded_by IS NULL`, `NOT EXISTS (…)` cannot be part of a partial index, because
SQLite forbids a subquery in an index's WHERE. The grid still seeks on `idx_assets_imported` and
pays this per row it returns, against `idx_subtitles_track`. **What it costs is owed to
`scripts/bench-search.ts`**; ADR-0025 §4 names the fallback if it is too much — a column on
`assets`, maintained beside the join table.

`is:captioned` is the mirror, and the question nobody could ask before: *which of my videos still
have no subtitles*.

## 3. Roost Query Language (RQL)

The search bar and smart folders share one grammar. It compiles to SQL with **bound
parameters only** — never string concatenation. This is user input reaching SQL, so the
parser is fuzz-tested.

Terms are gated on the schema that backs them; a term whose column does not exist yet is a
parse error with a clear message, not a silent empty result.

The grammar is frozen by compatibility, not by preference. A smart folder stores its query
text, so a query this implementation cannot parse is a folder the user loses.

**Specified — implemented in the Rust engine, and M2's job here**
```
tag:wood                      tag equals, case-insensitive as the schema stores it
tag:"brand assets"            quoted values; "" escapes a quote inside one
group:Materials               any tag in that group
-tag:wip                      negation
folder:Moodboards             folder and everything beneath it
folder:Design/Icons           nested path; a bare name matches every folder so named
                              (a folder name may therefore not contain "/")
ext:png                       extension, with or without the dot
size:>10mb                    byte size; kb/mb/gb are binary multiples, 1.5mb is fine
w:>2000  h:<=1080             dimensions
duration:>30s                 ms/s/m/h; a bare number is seconds
created:2024-01-01..2024-12-31
created:2024-03-01            a bare date is the whole day, not midnight exactly
imported:>2026-01-01
rating:>=4                    1 to 5; anything else is a parse error, not an empty result
is:favorite is:untagged is:tagged is:rated is:unrated
is:managed is:referenced is:partial-hash
is:trashed                    in the trash; also `is:trash`
is:superseded                 replaced by a newer version; also `is:old`
is:subtitle                   attached as somebody's caption track; also `is:subtitles`
is:captioned                  has at least one caption track
"free text"                   FTS5 over orig_name and tags
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
- **Negation is total.** `-tag:wip` is `NOT (…)` over the whole library, so it includes
  assets with no tags at all.
- **Every query is scoped by two rules, and naming a flag opts out of that rule only.** Not in
  the trash (ADR-0022) and not superseded (ADR-0026). `is:trashed` therefore still excludes old
  versions, because a superseded row in the trash is a version rather than something somebody
  deleted. The rules live in one table in `@roost/search`'s compiler; the third such rule is where
  a pattern becomes a design and the fourth is where it becomes a bug. Trash is a state,
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
similar:<hash>                perceptual-hash neighbours
is:duplicate
```

Implicit `AND` between terms; `OR` and parentheses supported. Grammar, parser, and SQL
compiler live in `@roost/search`.

### Notes on compiling RQL

- `is:duplicate` cannot mean "same hash" — identical bytes are one asset by invariant 1.
  It means *perceptually* near-duplicate, via `asset_hashes`, and is therefore M5.
- `folder:` matches the folder and its descendants. The subtree is expanded to a list of
  ids **before** compiling, by a `Folders` resolver the caller supplies, rather than by a
  recursive CTE inside every query: a folder tree is user-made and small, and expanding it
  keeps the compiled SQL simple and lets `@roost/search` be tested without a database. A
  smart folder recompiles on every run, so the expansion cannot go stale.
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
(`STORAGE_SPEC.md` §Ops added after v1). `JSON.stringify` drops `undefined` and keeps `null`,
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
