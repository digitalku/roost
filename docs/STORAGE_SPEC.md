# Storage Specification

**Status: BINDING** · Version 1 · Accepted 2026-08-20 (ADR-0004)

This document is binding. Any deviation requires explicit approval.

## Port note (2026-08-24)

This specification is carried over **unchanged in substance** from the Rust/Tauri
implementation at `../roost-old`. It governs the on-disk format, and the format did not
change when the language did.

**Amended 2026-08-29 (user decision).** This note used to require that a library written by
either implementation open in the other. It no longer does: `roost-old` is a discontinued
project, and schema growth this specification always allowed — `DATA_MODEL.md` §2 — reached the
point where its build refuses the index (v6, M4). Nothing about the *format* changed with that
decision: the layout, the hashing, the journal records, and the invariants below are untouched,
and a library `roost-old` wrote still opens here. What was retired is an obligation to a dead
build, not a rule about bytes on disk.

Exactly two things were edited, both of them file paths naming where the *code* lives, never
what the *library* contains:

- `crates/core/migrations/` became `packages/core/migrations/`
- `crates/core/src/journal/op.rs` became `packages/core/src/journal/op.ts`

Nothing else — no invariant, no schema line, no journal record, no forbidden pattern — was
touched. Those two edits are listed in `docs/TODO.md` §1 for confirmation rather than assumed,
because this document is binding and even a path is a deviation in letter.


## Directory Layout

```
MyLibrary/
├── originals/
│   └── a3/
│       ├── a3f2c9d1e5b4...8f.jpg
│       └── a3b71e4a8802...c1.psd
├── index.db              SQLite. Derived cache. Safe to delete.
├── journal/
│   ├── 2026-08.jsonl     Append-only. Source of truth.
│   └── 2026-07.jsonl
└── library.json          Format version, library id, configuration.
```

## Invariants

These must hold at all times. A violation is a bug, not a tradeoff.

1. **Asset identity is the content hash.** Not the path, not the filename.
2. **Sharding is one level**: the first two hex characters of the hash,
   giving 256 buckets. Not two levels. Not one directory per asset.
3. **On-disk filename is the full hash plus the original extension**,
   lowercased. The user's original filename lives in the database only.
4. **Shard directories are created lazily** as files arrive. Do not
   pre-create all 256.
5. **The journal is append-only.** Never edited, never rewritten in place.
   Rotated monthly.
6. **`index.db` must be fully rebuildable** from journal plus originals.
   Any state that exists only in the database is a bug.
7. **Thumbnails are BLOBs in `index.db`**, never loose files.
8. **Folders are collections.** An asset belongs to zero or more folders
   through a join table. Never a path column on the asset.

## Hashing

- Files up to 50 MB: BLAKE3 over the entire file.
- Files over 50 MB: BLAKE3 over the concatenation of
  `file_size as u64 little-endian` + `first 64 KB` + `last 64 KB`.
- Stored as a 64-character lowercase hex string.
- Assets hashed partially set `is_partial_hash = 1` so they can be upgraded
  to a full hash later without a schema change.

## Import Modes

**`managed`** — the file is placed under `originals/`. Attempt in order:

1. **reflink** (`FICLONE` ioctl) — copy-on-write, zero bytes consumed.
   Works on Btrfs and XFS. Preferred: the copy is independent, so later
   edits to the user's file do not silently alter the library copy.
2. **hardlink** — same filesystem only. Note that the two names share an
   inode, so edits are visible through both.
3. **copy** — fallback across filesystems.

Record which method succeeded in `link_method`. Never move or delete the
user's original file.

**`referenced`** — the file stays where it is. The database stores an
absolute path and a hash. Nothing is ever written into the user's folders.

## Schema

Version 1. Schema changes go in numbered migration files under
`packages/core/migrations/`. Never edit an applied migration.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- must contain ('schema_version', '1')

CREATE TABLE assets (
  hash            TEXT PRIMARY KEY,
  ext             TEXT NOT NULL,
  size            INTEGER NOT NULL,
  width           INTEGER,
  height          INTEGER,
  duration_ms     INTEGER,          -- video and audio only
  orig_name       TEXT NOT NULL,
  storage_mode    TEXT NOT NULL
                  CHECK (storage_mode IN ('managed', 'referenced')),
  link_method     TEXT CHECK (link_method IN ('reflink', 'hardlink', 'copy')),
  ref_path        TEXT,             -- referenced mode only
  is_partial_hash INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER,          -- source file mtime, unix seconds
  imported_at     INTEGER NOT NULL
);

CREATE INDEX idx_assets_imported ON assets(imported_at DESC);
CREATE INDEX idx_assets_ext      ON assets(ext);

CREATE TABLE thumbs (
  hash   TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  size   INTEGER NOT NULL,          -- longest edge: 256 or 512
  width  INTEGER NOT NULL,
  height INTEGER NOT NULL,
  data   BLOB NOT NULL,             -- WebP, quality 80
  PRIMARY KEY (hash, size)
);

CREATE TABLE folders (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_folders_parent ON folders(parent_id);

CREATE TABLE asset_folders (
  hash      TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  PRIMARY KEY (hash, folder_id)
);

CREATE INDEX idx_asset_folders_folder ON asset_folders(folder_id);

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE asset_tags (
  hash   TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (hash, tag_id)
);

CREATE INDEX idx_asset_tags_tag ON asset_tags(tag_id);

CREATE VIRTUAL TABLE assets_fts USING fts5(
  hash UNINDEXED,
  orig_name,
  tags,
  tokenize = 'unicode61'
);
```

## Journal Format

One operation per line, JSON, newline-delimited. `ts` and `op` are required
on every record. `ts` is unix seconds.

```json
{"ts":1755648000,"op":"add","hash":"a3f2...","ext":"jpg","size":204813,"name":"beach trip.jpg","mode":"managed","link":"reflink","w":4000,"h":3000}
{"ts":1755648100,"op":"tag_add","hash":"a3f2...","tags":["reference","blue"]}
{"ts":1755648200,"op":"tag_remove","hash":"a3f2...","tags":["blue"]}
{"ts":1755648250,"op":"folder_create","id":7,"parent":null,"name":"Moodboards"}
{"ts":1755648260,"op":"folder_add","hash":"a3f2...","folder":7}
{"ts":1755648300,"op":"remove","hash":"a3f2..."}
```

Replay processes files in chronological order, oldest month first.

**Unknown `op` values must be skipped with a warning, not treated as an
error.** This lets a library written by a newer version still open in an
older one, and is what keeps invariant 6 survivable across releases.

## Rebuild Test

There must be a test that deletes `index.db`, replays the journal, and
asserts the resulting database is equivalent to the original. This test
guards invariant 6, which is the easiest one to leak as the project grows.

## Forbidden Patterns

Do not, under any framing:

- Store thumbnails as separate PNG or JPEG files on disk
- Write a `metadata.json` sidecar per asset
- Shard across two directory levels
- Use the original filename as the on-disk filename
- Encode images as base64 anywhere in the pipeline
- Write anything into user directories in `referenced` mode
- Add a `path` or `folder` column to `assets` to represent collections
- Move or delete a user's original file during import

---

## Implementation notes

Non-normative. These record consequences of the spec that implementers must
handle. They add no requirements and permit no deviation.

### Derived, not stored
Thumbnails and FTS rows are *derived* and therefore exempt from invariant 6's
journal requirement: they are regenerated from `originals/` and from replayed
state, not replayed from the journal. Everything a user *authored* — tags,
folders, membership, names — must be in the journal.

### Partial-hash upgrade
Because identity is the hash (invariant 1) and the on-disk filename is the hash
(invariant 3), upgrading a >50 MB asset from partial to full hash changes both
its primary key and its filename. Treat it as a journalled operation, not an
in-place `UPDATE`, so a rebuild reproduces it.

### Partial-hash collisions cannot be detected by size
An earlier draft of this note claimed the importer should escalate to a full
hash when it finds an existing row with the same hash but a different size.
**That check can never fire.** The size is hashed as the little-endian prefix,
so two files with the same partial hash necessarily have the same size.

The real blind spot is narrower and undetectable at import time: two files that
share a size, a first 64 KB, and a last 64 KB, but differ somewhere in the
middle, produce the same hash and are merged into one asset. Distinct video
files rarely satisfy all three conditions; files derived from one another —
a re-muxed container, a patched disk image — plausibly can.

Options, none free:
- **Accept it.** Report partial-hash duplicates separately so the count is
  visible rather than implied.
- **Verify on collision** (current behaviour, since 2026-08-24). When a
  duplicate is decided by a partial hash and the stored bytes are reachable,
  the two files are compared byte for byte before merging. Costs a full read
  only on the rare duplicate, never on an ordinary import. Matching bytes are an
  ordinary duplicate; differing bytes are refused outright and counted in
  `ImportReport::partial_collisions`, because merging them would lose one of the
  two files. `ImportReport::partial_duplicates` now means the narrower thing it
  always should have: a partial match whose stored bytes could **not** be
  reached — a referenced original, which lives outside the object store.
- **Full-hash override.** A per-import flag that hashes everything completely,
  for libraries where even the unverifiable remainder is unacceptable. Not
  implemented.

Refusing is not the last word: the file is untouched on disk, and the
partial-to-full hash upgrade above is what would eventually let both be stored.

### Folder ids in replay
`folder_create` carries an explicit `id`. Replay must insert that exact id
rather than letting SQLite autoassign, or `folder_add` records will dangle.
Allocate ids from the journal's own maximum, never from `last_insert_rowid()`
after a partial replay.

### Journal durability
The journal is the source of truth, so a write that reaches the database but
not the journal is data loss. Order every mutation journal-first, then index,
and `fsync` the journal on a bounded interval (or per batch during bulk
import). A trailing torn line from a crash must be skipped on replay with a
warning, exactly as an unknown `op` is.

### Fields the `add` record needs beyond the published example

**Approved 2026-08-20.** The example `add` line carries
`hash, ext, size, name, mode, link, w, h`. Invariant 6 cannot hold with only those,
because three pieces of state exist nowhere else once import has happened:

- `ref` — absolute path, referenced mode only. Those bytes are not under `originals/`, so a
  rebuild has no other source for their location. Without it, every referenced asset and
  its tags are lost on rebuild.
- `created` — the source file's mtime. The library copy's mtime is the import time, so the
  original's is unrecoverable. This is `assets.created_at`.
- `partial` — mirrors `assets.is_partial_hash`. Derivable from `size` today, but recorded
  explicitly so that changing the 50 MB threshold later cannot retroactively reinterpret
  old records.

All three are omitted from the line when empty, so the common case stays as small as the
published example. Implemented in `packages/core/src/journal/op.ts`.

### Ops added after v1

**M2, 2026-08-21.** The v1 set covers add, remove, tag add/remove, folder
create, and folder add — enough to import, not enough to organize. The
operations below were added under the rule this document already states: a new
`op` value, never a repurposed one, tolerated by older builds because unknown
ops are skipped.

```json
{"ts":1755648400,"op":"folder_remove","hash":"a3f2...","folder":7}
{"ts":1755648410,"op":"folder_rename","id":7,"name":"References"}
{"ts":1755648420,"op":"folder_move","id":7,"parent":null}
{"ts":1755648430,"op":"folder_delete","id":7}
{"ts":1755648440,"op":"asset_rename","hash":"a3f2...","name":"beach at dusk.jpg"}
{"ts":1755648450,"op":"tag_rename","from":"blue","to":"cyan"}
{"ts":1755648460,"op":"rate","hash":"a3f2...","rating":4}
{"ts":1755648470,"op":"note_set","hash":"a3f2...","note":"client approved"}
{"ts":1755648480,"op":"favorite_set","hash":"a3f2...","favorite":true}
{"ts":1755648490,"op":"smart_folder_create","id":1,"parent":null,"name":"Recent PNGs","query":"ext:png imported:>2026-01-01"}
{"ts":1755648500,"op":"smart_folder_update","id":1,"name":"Recent PNGs","query":"ext:png rating:>=4"}
{"ts":1755648510,"op":"smart_folder_delete","id":1}
{"ts":1755648520,"op":"tag_group_create","id":1,"name":"Material"}
{"ts":1755648530,"op":"tag_group_rename","id":1,"name":"Materials"}
{"ts":1755648540,"op":"tag_group_set","tag":"wood","group":1}
{"ts":1755648550,"op":"tag_group_delete","id":1}
```

`tag_group_set` names its tag rather than numbering it, exactly as `tag_add`
and `tag_rename` do: tag ids are assigned by the index, which is derived, so a
journal record must never depend on one. `"group":null` takes the tag out of
its group.

`tag_group_delete` removes the arrangement, not the tags. `tags.group_id` is
`ON DELETE SET NULL`, so the tags survive ungrouped and every asset carrying
them is untouched.

Three of them carry meaning in a `null` that an absent field would lose, so the
field is always written: `rate` with `"rating":null` clears the rating, which is
distinct from one star; `note_set` with `"note":null` clears the note; and
`folder_move` with `"parent":null` moves a folder to the top level.

`tag_rename` onto a name that already exists **merges** into it. That is not a
convenience — `tags.name` is `UNIQUE COLLATE NOCASE`, so no other outcome both
succeeds and replays to the same state.

`folder_delete` removes the folder, its descendants, and every membership in
them, by cascade. The assets are untouched: folders are collections, not
locations.

Still undefined, for want of a feature that needs them: stacking, watched
roots, and the partial-to-full hash upgrade described above.

### Referenced mode and rebuild
A `referenced` asset's bytes are not under `originals/`, so a rebuild after the
user moves or deletes that file cannot restore it. Replay must reinstate the
row with its recorded `ref_path` and mark it missing at verification time
rather than dropping it — dropping it would lose the user's tags for a file
that may simply be on an unmounted drive.

### TypeScript implementation notes

Non-normative, and specific to this implementation. They record where a hosted language can
silently produce bytes the specification does not describe.

**The partial hash's size prefix is 8 bytes, little-endian, unsigned.** The spec says
`file_size as u64 little-endian`, which in TypeScript means an 8-byte buffer written with
`writeBigUInt64LE`, never a `Number` written as a double and never a decimal string. A library
whose >50 MB assets hash differently from `roost-old`'s is not compatible with it, and nothing
in a test that only round-trips through one implementation will say so. The conformance test
must hash a fixed 50+ MB fixture and assert a hard-coded hex digest taken from the Rust.

**Hashing streams.** BLAKE3 over a whole file must not read the file into memory: assets are
routinely gigabytes. The partial scheme reads exactly two 64 KB windows by seeking, and reads
nothing in between.

**WebP encoding is not byte-identical across encoders**, and does not need to be. Thumbnails
are derived (see *Derived, not stored* above), so an encoder change re-derives them rather than
breaking a library. Only `size`, `width`, and `height` in the `thumbs` row are normative; the
BLOB is whatever the current encoder produced at quality 80.

**Text is written as UTF-8 with `\n` line endings, one JSON object per line, no BOM.**
`JSON.stringify` is used for journal records; it must be given a plain object built field by
field, never a class instance and never an object carrying `undefined` values, so that an
absent optional field is *absent* rather than serialised inconsistently.
