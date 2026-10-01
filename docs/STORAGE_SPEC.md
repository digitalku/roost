# Storage — how this build meets the library format

**Roost Library Format 2, revision 2.2.** The normative document is [`FORMAT.md`](FORMAT.md),
beside this file, with [`OPS.md`](OPS.md) for the journal operations and `conformance/` at the
repository root for the suite. This file is **not** a specification and binds nothing on its own:
it is the map from that document's numbered requirements to the code here, plus the notes that
belong to this build.

> **Whose the rules are.** Until 2026-09-26 the format lived in the `roost-library` repository and
> this build conformed to it (ADR-0045). Since ADR-0052 it is this repository's own: copied home at
> revision 2.0, changed here, in the same commit as the code. The map stays separate from the
> format so that the normative text and this build's notes about it cannot blur into each other.

## Status (2026-09-21)

**This build reads and writes Format 2, and nothing else** (ADR-0046). Version 2 is not a
revision of version 1: an asset's identity is an id minted at random rather than the hash of its
bytes, `files/` is editable in place, and every fact about the bytes is derived rather than
journalled. A manifest at a lower version is not a library (RL-6a), and format 1 is not named
(ADR-0053).

The numbering starts again with the format: version 1's `RL-1`…`RL-41` are archived under
`v1/` in the `roost-library` repository and are unrelated to the numbers below.

Two things the format deliberately leaves to this build:

- **Thumbnails are WebP at quality 80, in `thumbs/roost.db`.** They are outside the format (RL-2)
  because they are derived from bytes the format *does* define, and `thumbs/` is a reserved name
  the format leaves to the implementation. A SQLite file of its own beside the index, so that a
  rebuild keeps them (ADR-0051). `ARCHITECTURE.md` §3.3 owns the encoding, and `DATA_MODEL.md`
  §2.2 the schema.
- **The index schema.** A cache (RL-2), so it lives in `DATA_MODEL.md` §2.0.

## The map

Every requirement, and where this build meets it. A row with no code reference is met by
construction or by a rule nothing here can break.

### Scope and identifying a library

| | | |
|---|---|---|
| RL-1 | The normative files are read and written as specified | `packages/core` |
| RL-2 | `index.db`, `thumbs/`, `settings.json`, `staging/` are ours, not the format's | `db/`, `db/pictures.ts` (`thumbs/roost.db`), `settings.ts`, `storage/handoff.ts` |
| RL-3 | Nothing unlisted is created in the library root | Only the reserved names are ever joined to the root |
| RL-4 | A library is a readable `library.json` with an integer version | `library/src/manifest.ts` |
| RL-5, RL-5b | All four fields required; a bad file is *not a library*, never repaired | `manifest.ts` · `tests/standard.test.ts` |
| RL-5a | Unrecognised fields ignored on read and **kept on write** | `Manifest.unrecognised` |
| RL-6 | A higher version refuses to open and touches nothing | `LibraryTooNewError`, thrown before any handle is taken |
| RL-6a | A **lower** version is *not a library*, and nothing is read or repaired | `NotALibraryError`, checked before the other three fields |
| RL-7, RL-7a | `<name>.roost` on write; never required on read, never renamed | `library/src/naming.ts` (ADR-0014) |
| RL-7b | The folder is the name; `name` is written on a rename and never repaired | `Library.name`, `library/src/rename.ts` — `renameLibrary`; `recent.ts` names entries from the path (ADR-0056) |

### Layout

| | | |
|---|---|---|
| RL-8 | One shard level, the first two characters of the id | `core/src/model/asset-id.ts` — `shardOf` |
| RL-9 | `<id>.<ext>`, extension lowercased, from the name's last dot | `storage/files.ts` — `locate` · `import.ts` |
| RL-9a | A file with no extension is the bare id, with **no trailing dot** | `locate` · asserted against a directory entry, never `stat` |
| RL-9b | A file saved under another extension is renamed; nothing is journalled | Not built — the workspace stage. `TODO.md` §3 |
| RL-10 | Shards created as files arrive, never all 1 024 | `storage/files.ts` — `#ensureShard` |
| RL-11 | A file whose name is not an id is neither adopted nor deleted | `iterAll` skips it; `iterUnrecognised` reports it; `doctor` lists it |
| RL-12 | One id, one file — two are reported and neither is chosen | `storage/files.ts` — `findFiles` · `doctor.ts` — `ambiguous` |

### Identity

| | | |
|---|---|---|
| RL-13 | Identity is the id: minted once, never the path, never the hash | `AssetId` is branded, not a bare string |
| RL-14 | Twelve characters of Crockford base32, upper case, random | `model/asset-id.ts` — `ID_ALPHABET`, `mintAssetId` |
| RL-14a | An id encodes nothing — no timestamp, or the shard would collapse | `crypto.getRandomValues`, and no other source |
| RL-15 | A newly minted id is checked against the library before it is written | `mintAssetId(isTaken)` · `import.ts` passes `hasAsset` **and** the batch |
| RL-16 | An id is never reused, including after a removal | Nothing derives an id from a maximum; only `mintAssetId` makes one |
| RL-17 | Folders, groups, comments and watched roots are integers from the journal's maximum | `db/repo.ts` — `noteIdUsed`, `#nextId` |
| RL-18 | A content hash is derived, never identity, never a filename | `media/src/hash.ts` · `assets.content_hash` |

### The bytes, and editing them

| | | |
|---|---|---|
| RL-19 | Every asset's bytes are under `files/`. There is no second mode | `storage/files.ts` is the only store |
| RL-20 | The bytes may change at any time, and that is ordinary | `clearDerived`, `dropThumbnails`, and the derive queue |
| RL-21 | No file is held open in a way that stops another application writing it | Every read opens and closes; nothing keeps a handle |
| RL-22 | Size, dimensions, duration, page count, hash and thumbnails are derived | `repo.putDerived` · `jobs.ts` — `measure` |
| RL-23 | An edit is never journalled | `edit.ts` — `saveEdit` appends nothing |
| RL-24 | The library is reconstructible from `journal/` and `files/` alone | `library.rebuild()` · `tests/journal-replay.test.ts` |
| RL-25 | An asset whose file is missing is reported, never dropped | `doctor.ts` — `missingFiles` · the derive parks as `missing:file` |
| RL-26 | An import moves or copies, says which, and the result is independent | `storage/files.ts` — `put` · `ImportReport.moved`/`copied` |

### The journal

| | | |
|---|---|---|
| RL-27 | Append-only | `journal/writer.ts` — files opened `"a"`, never rewritten |
| RL-28, RL-28a | `YYYY-MM.jsonl`, the month read in **UTC** | `journal/writer.ts` — `monthKey` |
| RL-29 | Oldest month first, records in file order | `journal/replay.ts` |
| RL-30 | Journal before index, always | `edit.ts` — `apply`, `import.ts` — `commit` |
| RL-31 | Never rewritten, compacted, rebuilt or pruned | No code anywhere writes to a journal file except by append |
| RL-32, RL-32a | `ts` and `op` on every record; `at` is the one number in ms | `journal/op.ts` |
| RL-33 | A name carries no extension | `import.ts` — `nameOf` · `applyAssetRename` |
| RL-34 | The operations are the registry's | `OP_NAMES`, checked against it by `spec-conformance.test.ts` |
| RL-35, RL-36 | Ids are journalled explicitly, and minted from the **journal's** maximum | `db/repo.ts` — `noteIdUsed`, `nextFolderId` |
| RL-37 | An unknown `op` is skipped with a warning, never an error | `journal/replay.ts` — `unknownOps` |
| RL-38 | A dangling reference is skipped, logged, counted — and nothing is invented | `db/sink.ts` — `referentsOf` |
| RL-39 | A torn final line is skipped like an unknown op | `journal/replay.ts` — `tornTrailing` |
| RL-40 | The **person** is told, and the operations are named | `JournalNotice.tsx` · `cli/src/open.ts` |

### Extension, text, and what is forbidden

| | | |
|---|---|---|
| RL-41 | Platform operations carry a prefix | `journal/op.ts` — `platformOf`, `platformName` |
| RL-42, RL-43 | A new operation never raises the format version | This build writes no operation the registry lacks |
| RL-44 | Unknown fields on a known operation are ignored, never rewritten away | `toRecord` reads the fields it knows and nothing else |
| RL-45, RL-46 | No extension entity is a prerequisite for a core one | This build defines no platform operation |
| RL-47 | A query this build cannot evaluate is kept byte for byte and shown as unavailable | `applySmartFolderCreate` stores it verbatim; the sidebar marks it |
| RL-48 | UTF-8, `\n`, no BOM | `writeFile(…, "utf8")`; `toLine` ends every record with `\n` |
| RL-49 | Names normalised to NFC on write | `core/src/model/text.ts` — `toNfc` |
| RL-50 | An absent optional field is absent, except where `null` carries meaning | `journal/op.ts` — `?:` versus `\| null`, and the comment that says why |
| RL-51 | The forbidden list | Reproduced in `CLAUDE.md` §5, which is what a session reads |

### Conformance and what is open

| | | |
|---|---|---|
| RL-52 | The suite in `conformance/` is run by `pnpm test` | `packages/library/tests/format-conformance.test.ts` |
| RL-53 | Delete the cache, replay, assert the same state | `packages/core/tests/journal-replay.test.ts` |
| RL-54, RL-54a | The suite is layered by revision; this build states **2.0** | It passes `conformance/library.roost`, which is required of everyone |
| RL-56 | The reserved names are not used for anything else | `versions/` is reserved and stays empty |
| §11.1 | *Does removing an asset delete its file?* **This build says yes** | `edit.ts` — `removeAssets` (ADR-0031) |
| §11.2 | *Version history* — not invented | Nothing writes `versions/` |
| §11.4 | *Does an empty tag survive?* **This build keeps it** | `repo.tags()` lists it at zero |

---

## Implementation notes

Ours, not the format's. They record consequences an implementer has to handle, add no
requirements, and permit no deviation from `FORMAT.md`.

### Two halves of a row, and the line between them

`assets` splits in two, and the split is the whole of what version 2 changed. Everything down to
`poster_ms` is something a person **said**, and every one of those columns arrives through a
journal operation. Everything after it was **read out of the file** and is journalled by nothing.

The test for which is the one worth remembering: if a person typed it or clicked it, it goes in
the journal; if a machine read it out of the bytes, it does not.

`created_at` is the exception that proves the rule. It is the source file's own date at import,
and nothing can recover it afterwards — the stored file's date becomes the date of the last edit
the moment anybody saves it. So it is journalled, and it is the only fact about a file that is.

### What version 2 gave up, stated rather than discovered

Version 1 named every file by the hash of its contents, so a file that no longer hashed to its
name was **provably** damaged. Here the bytes are allowed to change under an unchanged id
(RL-20) and an edit is journalled nowhere (RL-23), so bit rot, a bad sync and a person editing
their own file are indistinguishable: **no implementation can promise to detect corruption**
(`FORMAT.md` §5).

`doctor --deep` still reads every file. What it reports is that the bytes **changed** — a reason
to derive them again, not an accusation — and `hasDamage` deliberately does not count it. A
build that called a person's own save damage would be crying wolf at the product's main feature.

What `doctor` keeps: an asset whose file is missing (RL-25), a file whose name is not an id
(RL-11), an id with two files (RL-12), and an index that disagrees with the disk.

### Deduplication is a decision now, not a consequence

Under version 1 an identical file was already present by construction: the path *was* the hash.
Here an import that placed a second copy would make a second asset, so skipping it is something
this build **chooses** — and it chooses to, because re-importing a directory is the ordinary way
to produce duplicates and nobody means to double their library by doing it (ADR-0046 §5).

The check reads `assets.content_hash`, which is derived (RL-18), so the import hashes what it
places and writes the hash in the same transaction as the row. That is also why the duplicate
dialog comes *after* a run rather than in front of one (ADR-0037).

### The cache is caught up on open

The format puts the index outside itself, so a library written by another implementation arrives
with no cache of ours — or with one built before that implementation last appended. `index.db`
therefore records how far it has folded the journal, as the byte length of each month file, and
an open that finds a mismatch folds the journal before the window draws anything. Sizes rather
than digests: the journal is append-only, so a file that has not grown cannot have changed, and
hashing it would make every open cost what a rebuild costs.

The fold is **not** preceded by emptying the index. A rebuild does that deliberately; an open
must not, or meeting one file another implementation added would throw away every thumbnail in
the library. Replaying over what is there converges on the same state, because every operation
sets a value rather than toggling one and the journal never loses a line.

**A fold is cheaper than it was.** Version 1's `applyAdd` had to `coalesce` the dimensions on
conflict, because they were the only columns with two sources — a journal line and a derive.
Version 2's `add` names no derived column at all, so that whole class of bug cannot occur here.

**It is a whole-journal fold, not an incremental one.** The mark is a length, so the records past
it could be read alone — that is a worthwhile optimisation and it is not built. `TODO.md` §3
carries it.

### Journal durability

A write that reaches the database but not the journal is data loss, so every mutation is ordered
journal-first and the journal is `fdatasync`ed per batch rather than per record — an import of
100 000 files would otherwise spend most of its time waiting on the disk. A trailing torn line
from a crash is skipped on replay with a warning, exactly as an unknown `op` is (RL-39).

### Where the schema lives

`DATA_MODEL.md` §2.0 — one baseline, and one numbered migration per section after it as the
schema grows. The index is a cache, so none of that is the format's business; what **is** its
business is that every row in it can be rebuilt from the journal and `files/` (RL-24).
