# Storage — how this build meets the library format

**Roost Library Format 1, revision 1.0.** The normative document is `SPEC.md` in the
[`roost-library`](../../roost-library) repository, checked out beside this one. This file is
**not** a specification and binds nothing on its own: it is the map from that document's
numbered requirements to the code here, plus the notes that belong to this implementation
and to no other.

> **Where the rules are.** `SPEC.md` (requirements `RL-1`…`RL-41`), `ops/REGISTRY.md` (every
> journal operation), `conformance/` (a library and the state replaying it must produce), and
> `CHANGING.md` (how any of those may change). Nothing from them is copied here. A copy drifts
> the moment somebody fixes one of them, and a format read by three implementations cannot
> afford a second opinion — see ADR-0045.

## Status (2026-09-15)

Until this date the binding document was **this file**, carried over from the Rust
implementation at `../roost-old` and amended four times in place. It has been replaced by a
standard that no implementation owns, with the requirements numbered and with nothing in it
naming a path in anybody's source tree. **No rule changed in the move.** What changed is who
gets to change them, and how: every change now raises a document revision or a format version,
and `conformance/` is extended in the same commit.

Two things the old document did that the standard deliberately does not:

- **It specified thumbnails as WebP.** They are outside the format now (`RL-2`), because they
  are derived from bytes the format *does* define and an implementation that throws them away
  loses nothing but time. WebP at quality 80 is still what this build encodes; it is our
  decision now, not the format's, and `ARCHITECTURE.md` §4.5 owns it.
- **It carried schema v1.** The index is a cache (`RL-2`), so the schema moved to
  `DATA_MODEL.md` §2.0 where the rest of the migrations already lived.

## The map

Every requirement, and where this build meets it. A row with no code reference is met by
construction or by a rule nothing here can break.

### Scope and identity

| | | |
|---|---|---|
| RL-1 | The normative files are read and written as specified | `packages/core` |
| RL-2 | `index.db`, `settings.json`, `staging/` are ours, not the format's | `db/`, `settings.ts`, `storage/handoff.ts` |
| RL-3 | Nothing unlisted is created in the library root | Only the six names are ever joined to the root |
| RL-4 | A library is a readable `library.json` with an integer version | `library/src/manifest.ts` |
| RL-5, RL-5b | All four fields required; a bad file is *not a library*, never repaired | `manifest.ts` · `tests/standard.test.ts` |
| RL-5a | Unrecognised fields ignored on read and **kept on write** | `Manifest.unrecognised` |
| RL-6 | A higher version refuses to open and touches nothing | `LibraryTooNewError`, thrown before any handle is taken |
| RL-6a, RL-6b | `<name>.roost` on write; never required on read, never renamed | `library/src/naming.ts` (ADR-0014) |

### Layout and hashing

| | | |
|---|---|---|
| RL-7 | One shard level, first two hex characters | `core/src/model/content-hash.ts` — `shardOf` |
| RL-8, RL-8a, RL-8b, RL-8c | `<hash>.<ext>`, extension from the name's last dot, no trailing dot | `storage/managed.ts` — `locate` · `import.ts` |
| RL-9 | Shards created as files arrive | `storage/managed.ts` — `put` |
| RL-10 | Nothing under `originals/` is moved, renamed, edited or deleted | |
| RL-11 | Identity is the content hash | `ContentHash` is branded, not a bare string |
| RL-12, RL-12a | BLAKE3; over 50 MiB, size prefix plus two 64 KiB windows, seeking | `media/src/hash.ts` |
| RL-13 | A partial hash is recorded as one | `add.partial`, `assets.is_partial_hash` |
| RL-14 | The size prefix is eight bytes, unsigned, little-endian | `writeBigUInt64LE` |

### Modes

| | | |
|---|---|---|
| RL-15, RL-15a | reflink → hardlink → copy, and which succeeded is recorded | `storage/managed.ts` — `place` (ADR-0012) |
| RL-16 | `referenced` mode never writes into the user's directories | `storage/referenced.ts` refuses rather than stubbing |
| RL-17 | A missing referenced file is reported, never dropped | `library/src/doctor.ts` — `missingReferences` |

### The journal

| | | |
|---|---|---|
| RL-18 | Append-only | `journal/writer.ts` — files opened `"a"`, never rewritten |
| RL-19, RL-19a | `YYYY-MM.jsonl`, the month read in **UTC** | `journal/writer.ts` — `monthKey` |
| RL-20 | Oldest month first, records in file order | `journal/replay.ts` |
| RL-21 | Journal before index, always | `edit.ts` — `apply`, `import.ts` — `commit` |
| RL-22 | Never rewritten, compacted, rebuilt or pruned | No code anywhere writes to a journal file except by append |
| RL-23, RL-23a | `ts` and `op` on every record; `at` is the one number in ms | `journal/op.ts` |
| RL-24 | The operations are the registry's | `OP_NAMES`, checked against it by `spec-conformance.test.ts` |
| RL-25, RL-25a | Ids are journalled explicitly, and minted from the **journal's** maximum | `db/repo.ts` — `noteIdUsed`, `nextFolderId` |
| RL-26 | An unknown `op` is skipped with a warning, never an error | `journal/replay.ts` — `unknownOps` |
| RL-26a | A dangling reference is skipped, logged, counted — and nothing is invented | `db/sink.ts` — `referentsOf` |
| RL-27 | A torn final line is skipped like an unknown op | `journal/replay.ts` — `tornTrailing` |
| RL-28 | The **person** is told, and the platform named where the prefix says it | `JournalNotice.tsx` · `cli/src/open.ts` |
| RL-29 | Platform operations carry a prefix | `journal/op.ts` — `platformOf`, `platformName` |

### Extension, text, and what is forbidden

| | | |
|---|---|---|
| RL-30, RL-31 | A new operation never raises the format version | This build writes no operation the registry lacks |
| RL-32 | Unknown fields on a known operation are ignored, never rewritten away | `toRecord` reads the fields it knows and nothing else |
| RL-33, RL-34 | No extension entity is a prerequisite for a core one | This build defines no platform operation |
| RL-35 | UTF-8, `\n`, no BOM | `writeFile(…, "utf8")`; `toLine` ends every record with `\n` |
| RL-36 | Filenames normalised to NFC on write | `core/src/model/text.ts` — `toNfc` |
| RL-37 | An absent optional field is absent, except where `null` carries meaning | `journal/op.ts` — `?:` versus `\| null`, and the comment that says why |
| RL-38 | The forbidden list | Reproduced in `CLAUDE.md` §5, which is what a session reads |

### Conformance

| | | |
|---|---|---|
| RL-39 | The standard's suite is run, against a checkout beside this one | `packages/library/tests/format-conformance.test.ts` |
| RL-40 | Delete the cache, replay, assert the same state | `packages/core/tests/journal-replay.test.ts` |
| RL-41 | Digests the standard publishes, not ones this code produced | `packages/media/src/hash.test.ts` |

---

## Implementation notes

Ours, not the format's. They record consequences an implementer has to handle, add no
requirements, and permit no deviation from `SPEC.md`.

### Derived, not stored

Thumbnails and FTS rows are *derived* and therefore outside the journal: they are regenerated
from `originals/` and from replayed state. Everything a user **authored** — tags, folders,
membership, names, ratings, notes — is a journal line first (RL-21). The test for which is the
one worth remembering: if a person typed it or clicked it, it goes in the journal; if a machine
derived it from bytes, it does not.

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

One consequence is worth knowing before anybody edits `applyAdd`: `width` and `height` are
`coalesce`d on conflict, because they are the only columns with two sources — a header probe at
import and a derive backend afterwards. An absent `w` on an `add` means the importer could not
tell, not that the asset has none, and a fold that applied it as `NULL` would square off every
asset whose dimensions had come from the second source, with nothing to restore them.

**It is a whole-journal fold, not an incremental one.** The mark is a length, so the records past
it could be read alone — that is a worthwhile optimisation and it is not built. `TODO.md` §3
carries it.

### Partial-hash collisions cannot be detected by size

An early draft of this note claimed the importer should escalate to a full hash on finding an
existing row with the same hash and a different size. **That check can never fire.** The size is
hashed as the little-endian prefix, so two files sharing a partial hash necessarily share a size.

The real blind spot is narrower and undetectable at import time: two files sharing a size, a
first 64 KiB and a last 64 KiB but differing in the middle hash the same and would be merged
into one asset. Distinct videos rarely satisfy all three; files derived from one another — a
re-muxed container, a patched disk image — plausibly can.

This build **verifies on collision** (since 2026-08-24). When a duplicate is decided by a partial
hash and the stored bytes are reachable, the two files are compared byte for byte before merging.
That costs a full read only on the rare duplicate and never on an ordinary import. Matching bytes
are an ordinary duplicate; differing bytes are refused outright and counted in
`ImportReport.partialCollisions`, because merging them would lose one of the two files.
`partialDuplicates` means the narrower thing it always should have: a partial match whose stored
bytes could **not** be reached — a referenced original, which lives outside the object store.

RL-12's own note permits all of accepting, verifying and refusing. Refusing is not the last word:
the file is untouched on disk, and the partial-to-full upgrade below is what would eventually let
both be stored.

### Partial-hash upgrade

Identity is the hash (RL-11) and the on-disk filename is the hash (RL-8), so upgrading an asset
over 50 MiB from a partial hash to a full one changes both its primary key and its filename. It
has to be a journalled operation rather than an in-place `UPDATE`, or a rebuild will not
reproduce it — and **the format defines no operation for it yet** (`SPEC.md` §11.3). Nothing here
may invent one; it is proposed against the standard first.

### Journal durability

A write that reaches the database but not the journal is data loss, so every mutation is ordered
journal-first and the journal is `fdatasync`ed per batch rather than per record — an import of
100 000 files would otherwise spend most of its time waiting on the disk. A trailing torn line
from a crash is skipped on replay with a warning, exactly as an unknown `op` is (RL-27).

### Fields the `add` record needs beyond the published example

`ref`, `created` and `partial` are optional in the registry and are **not** optional in practice,
because each is state that exists nowhere else once import has happened: a referenced asset's
location, the source file's mtime, and whether the hash was partial. All three are omitted from
the line when empty, so the common case stays as small as the published example.

### Where the schema lives

`DATA_MODEL.md` §2 — v1 at §2.0, and one numbered migration per section after it. The index is a
cache, so none of that is the format's business; what is the format's business is that every row
in it can be rebuilt from the journal and `originals/`.
