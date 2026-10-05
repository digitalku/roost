# Roost Library Format

**Format version 2 · Document revision 2.3 · Status: DRAFT**

**This document belongs to this repository** (ADR-0052). It was written in the `roost-library`
repository and copied here unchanged at revision 2.0 on 2026-09-26. From then on it is kept here, it
is not synchronised with that repository, and it changes in the same commit as the code that
implements the change (§12). **Revision 2.1** (2026-09-26, ADR-0053) rewrote RL-6a: a lower version
is not a library, and version 1 is no longer named. **Revision 2.2** (2026-10-01, ADR-0056) made
the folder the library's name: RL-5 rewords `name`, and RL-7b is new. **Revision 2.3** (2026-10-05,
ADR-0060) corrected what RL-2 says of `thumbs/`: an implementation may keep there pictures somebody
chose, and those are lost with it. `docs/STORAGE_SPEC.md` maps each requirement to the code that meets it,
`OPS.md` beside this file is the operation registry, and `conformance/` at the repository root is
the suite.

**Version 2 is a different format, not a revision of version 1.** Version 1 described an
**archive**: the bytes were the identity, files under `originals/` were immutable, and an edit
produced a new asset. Version 2 describes a **workspace**: a file is opened by whatever application
owns its type, edited in place, and saved — and it is still the same asset afterwards.

That one change moves everything resting on it, so the format version rose to 2. Nothing written
under version 1 is read, migrated or named (RL-6a).

This document defines the Roost library format, and it is binding on this build. A build that does
not meet a requirement here does not read or write Roost libraries, whatever else it does. Where the
text speaks of *implementations* in the plural, it was written when the format was shared (ADR-0045).
It still describes what a library written by any other program must be for this build to open it.

Requirements are numbered `RL-n` and use **MUST**, **MUST NOT**, **SHOULD** and **MAY** in the usual
sense. Text outside a numbered requirement is explanation and binds nothing. The numbering starts
again at version 2.

---

## 0. The two numbers

**Format version** — the integer in `library.json`. It is `2`. It changes only when a library
becomes unreadable by an implementation written against the previous version.

**Document revision** — `2.0` here. It changes when an operation is added, a sentence is corrected,
or an ambiguity is closed. **The format does not move when it changes.**

An implementation states both: *"Roost Library Format 2, revision 2.0"*. It may state an older
revision and still conform — that is what the two numbers are for.

---

## 1. Scope

A Roost library is a directory, not a file. Not everything in it belongs to this format.

**RL-1.** The following are normative. An implementation MUST read and write them exactly as
specified:

- `library.json`
- `journal/`
- the layout and naming of `files/`
- the identifiers of §4
- the journal grammar of §6
- the text encoding of §8

**RL-2.** The following are **not** part of this format. An implementation MAY create them, name
them differently, omit them, or use a different technology entirely:

| | |
|---|---|
| `index.db` | A cache. RL-24 requires the library be reconstructible without it, which is what makes it not data |
| `thumbs/` | Pictures of the files. Discarding them costs time, and any pictures somebody chose in place of a file's own |
| `settings.json` | Per-library preferences |
| `staging/` | Named copies handed to other applications. Transient |

**RL-3.** An implementation MUST NOT create a file or directory in the library root whose name is
not listed in §3, and MUST leave untouched any it does not recognise.

The root is a reserved namespace. An implementation needing a private file puts it inside a
directory named for itself — `.roost-win/` — never beside `library.json`, so that a later revision
of this document cannot collide with it.

*Why the cache and the thumbnails are out of scope.* A library is defined by what it means, and
neither means anything the journal and the files do not already say. Version 1 went further and
forbade thumbnails inside the library at all; version 2 does not, because `thumbs/` is a reserved
name here and an implementation that fills it is not writing data — it is writing a cache it may
delete at any time.

*Pictures somebody chose* (revision 2.3). An implementation MAY let a person choose a file's
thumbnail, and MAY keep that picture in `thumbs/` and nowhere else. It is then not reconstructible,
and deleting `thumbs/` loses it. Nothing in this format records the choice, so another implementation shows the file's own picture,
and is right to: what a library means is unchanged.

---

## 2. Identifying a library

**RL-4.** A directory is a Roost library **if and only if** it contains a readable `library.json`
whose top-level value is a JSON object carrying an integer `roost_library_version`.

This is the format's signature. Nothing else — not the presence of `files/`, not a directory name,
not an extension on the folder — identifies a library.

**RL-5.** `library.json` MUST contain these four fields, and an implementation MUST reject the
library if any is absent or of the wrong type:

```json
{
  "roost_library_version": 2,
  "id": "e0ec4720-c791-4a56-84a5-2c7fc11bb00e",
  "name": "Studio",
  "created_at": 1789344118
}
```

| Field | Type | Meaning |
|---|---|---|
| `roost_library_version` | integer | The format version. `2` |
| `id` | string | A UUID, stable for the life of the library |
| `name` | string | What the library was called when an implementation created or last renamed it. Informative: a library is **called** by its folder's name (RL-7b) |
| `created_at` | integer | Unix seconds |

**RL-5a.** An implementation MUST ignore fields it does not recognise in `library.json`, and MUST
preserve them when it rewrites the file.

**RL-5b.** Validation of `library.json` MUST be strict, and a file that fails it MUST be reported as
"not a Roost library" rather than repaired or replaced.

This file decides whether a directory is a library at all. An implementation that guesses at a
damaged one is an implementation that can write into somebody's work by accident.

**RL-6.** An implementation meeting a `roost_library_version` **higher than it supports** MUST
refuse to open the library, MUST say so in terms the person can act on, and MUST NOT modify anything
in the directory — including deleting or rebuilding a cache it cannot read.

**RL-6a.** An implementation meeting a `roost_library_version` **lower than 2** MUST report the
directory as not a Roost library (RL-5b), MUST check the version before any other field, and MUST
NOT read, repair, convert or modify anything in it.

A lower version is a different layout, and anything done with one would be a guess. Until
revision 2.1 this requirement named version 1 and asked for it to be refused as such. No such
library is expected any more, so the rule is the general one.

### 2.1 The folder is named `<name>.roost`

**RL-7.** An implementation creating a library MUST name the directory `<name>.roost`, lowercase
suffix, and MUST NOT append a second one to a name that already ends in `.roost`.

**RL-7a.** An implementation MUST NOT require the suffix in order to open a library, MUST NOT refuse
a library that lacks it, and MUST NOT rename one it finds. Identification is RL-4 and only RL-4.

Strict on write, lenient on read — the rule every durable format follows.

**RL-7b.** A library's name is the name of its directory, with a trailing `.roost` removed. An
implementation MUST show a library by that name, not by `name` in `library.json`. An implementation
renaming a library at a person's request MUST rename the directory under RL-7, and SHOULD then set
`name` to match. A `name` that disagrees with the directory is not damage: an implementation MUST
NOT refuse, report or repair a library on that account, and MUST NOT write `library.json` in order to
bring the two into line.

Renaming the folder in a file manager is therefore a complete rename, which is what a person who
has used Eagle expects. `name` stays because RL-5 requires it, and a manifest without it is refused
by every reader written before this revision; it is kept up to date where that costs nothing, and
otherwise left alone. RL-7a forbids renaming a library an implementation finds; a rename the person
asked for is not that. Until revision 2.2, `name` was what the library was called and the folder
was not consulted.

---

## 3. Directory layout

```
Studio.roost/
├── library.json          Required. §2
├── journal/              Required. §6
│   ├── 2026-08.jsonl
│   └── 2026-09.jsonl
├── files/                Required. §3, §5
│   └── K7/
│       ├── K7QM4X2AJH9F.docx
│       └── K7ZZ1B9C4TM0.png
├── thumbs/               Not normative. RL-2
├── index.db              Not normative. RL-2
├── settings.json         Not normative. RL-2
└── staging/              Not normative. RL-2
```

**RL-8.** `files/` MUST be sharded one level deep, by the **first two characters of the asset's
id**, giving at most 1 024 directories. Not two levels. Not one directory per asset.

**RL-9.** The on-disk filename MUST be the **full id** followed by the file's extension, lowercased,
separated by a dot. The name a person gave the asset lives in the journal, never on disk.

**RL-9a.** A file with no extension is stored under the id **with no trailing dot**:
`K7QM4X2AJH9F`, never `K7QM4X2AJH9F.`

RL-9a is the one a Windows implementation can break without noticing. **Windows strips a trailing
dot from a path before it reaches the filesystem**, so a build that wrote one would find the file
again through its own API and pass its own tests, while producing a library other systems cannot
read. Checking it means reading the directory entry, not asking whether the path exists.

**RL-9b.** The extension is a fact about the file, not about the asset. When an application saves
the file under a different type — a `.docx` saved as `.pdf` — the implementation that notices MUST
rename the file so that RL-9 still holds, and MUST NOT journal anything: it is the same asset, and
§5 makes every fact about the bytes derived.

**RL-10.** Shard directories MUST be created as files arrive. An implementation MUST NOT pre-create
all 1 024.

**RL-11.** A file in `files/` whose name is not a valid id MUST NOT be adopted as an asset, MUST NOT
be deleted automatically, and SHOULD be reportable by a maintenance command.

Applications leave things beside the file they opened: Word writes `~$…` lock files into the
directory of the document, and an editor may leave a temporary file behind after a crash. Deleting
them automatically would put this format in the business of guessing which of a user's files are
rubbish; adopting them would invent assets nobody imported.

**RL-12.** An id MUST have exactly one file in `files/`. An implementation finding two — the same id
under two extensions — MUST report it and MUST NOT choose between them.

---

## 4. Identity

**RL-13.** An asset's identity is its **id**: a string, minted once, which never changes for the
life of the asset. Not the path, not the name the user sees, and **not the hash of its contents**.

**RL-14.** An id MUST be exactly **twelve characters** from the alphabet
`0123456789ABCDEFGHJKMNPQRSTVWXYZ` — the digits and the upper-case letters without `I`, `L`, `O` and
`U` — and MUST be generated randomly.

The alphabet is Crockford base32. Upper case only, because Windows compares filenames without regard
to case and two ids differing only in case would be one file. `I`, `L` and `O` are absent because
they read as `1`, `1` and `0`; `U` is absent so that a random id never spells something unfortunate.
Twelve characters is 2⁶⁰ ids: at a million assets the chance of a collision is about one in two
million, and RL-15 removes even that.

**RL-14a.** An id MUST NOT encode the time it was minted, or anything else that is not random.

ULID and UUIDv7 both put a timestamp in the leading characters. RL-8 shards on those characters, so
a time-ordered id would put everything imported this month into one directory — the single failure
sharding exists to prevent.

**RL-15.** An implementation MUST verify that a newly minted id is not already used in the library
before writing it, and MUST mint another if it is.

**RL-16.** An id is **never reused**, including after the asset it named has been removed.

The journal is append-only, so the record that created an asset is still there after the record that
removed it. Giving the id to something else would make a replay apply one asset's history to
another.

**RL-17.** Entities that are not assets — folders, tag groups, comments, watched roots — are
identified by **integers**, minted from the journal's own maximum rather than from the last row a
database inserted, and never reused.

Two kinds of identifier in one format looks untidy and is deliberate: only an asset becomes a
filename, so only an asset needs an identifier that is safe as one.

**RL-18.** A content hash is **not** part of this format. An implementation MAY compute one, for
duplicate detection or for recognising a file that moved, and MUST treat it as derived (§5) — never
as identity, never as a filename, and never as a reason to refuse a file.

An implementation that keeps one SHOULD use BLAKE3 over the whole file, hexadecimal and lower case,
so that two implementations comparing notes compare the same number.

---

## 5. The bytes, and editing them

This section is what makes version 2 a different format.

**RL-19.** Every asset's bytes live inside the library, under `files/`. There is no mode in which
they live anywhere else.

Version 1 had a second mode, `referenced`, holding an absolute path to a file left where the user
kept it. It is gone: with in-place editing there was little left to distinguish the two, and what
remained was a second rule for every feature, a path that means nothing on another machine, and a
library that could be partly unreadable. A version 2 library is one directory that can be copied,
backed up or moved with nothing left behind.

**RL-20.** The bytes of an asset **MAY change at any time**, by any application, without the library
being told. An implementation MUST treat this as ordinary rather than as damage.

**RL-21.** An implementation MUST NOT hold a file under `files/` open in a way that prevents another
application from writing to it, renaming it or deleting it. A preview, a text indexer and a
thumbnail pass MUST open files for shared read, write and delete.

This is the requirement that decides whether editing works at all, and it fails silently: Word
reports *"the file is in use"* and names no culprit, while the culprit is the preview pane of the
application the user opened the file from. Applications that save by writing a temporary file and
renaming it over the original — which is most of them — need the delete share too.

**RL-22.** Every fact derivable from the bytes is **derived**, and MUST NOT be required from the
journal: size, dimensions, duration, page count, extracted text, thumbnails and any content hash.

**RL-23.** An edit MUST NOT be journalled. The journal records what a person said about an asset —
its name, tags, folders, rating, note, comments — and never what the bytes currently are.

The two together are the line this format draws: **the journal for what you said, the disk for what
the file says.** It costs one thing, and this document states it rather than letting an
implementation discover it: bytes that change with no edit behind them — bit rot, a bad sync, a
careless script — are indistinguishable from bytes the user edited, so no implementation can promise
to detect corruption. Version 1 could, because it stored the hash of the bytes it expected; version
2 trades that for a file the user can simply open and work on.

**RL-24.** The library MUST be reconstructible from `journal/` and `files/` alone.

**RL-25.** An asset whose file is missing MUST be reported and MUST NOT be dropped. The row carries
everything the person wrote about it, and a missing file is a fact about today.

**RL-26.** An import places the bytes under `files/` as an **independent file**. The source file MAY
be moved or copied — the implementation decides, and MUST tell the person which it did — but the
stored file MUST NOT remain linked to anything outside the library by a hardlink or a symlink.

A copy-on-write clone (a reflink) is an independent file and is permitted; it is the fastest correct
import where the filesystem offers one. A hardlink is not: editing the file inside the library would
edit the user's file outside it, and removing the asset would free nothing.

Version 1 forbade moving the user's original outright. Version 2 permits it, because a workspace
implies it — the file now lives here — and requires only that the person is told which happened.

---

## 6. The journal

The journal is the library. Everything else can be rebuilt from it or from the files.

**RL-27.** The journal MUST be append-only. A record, once written, MUST NOT be edited, reordered or
removed.

**RL-28.** The journal MUST be rotated monthly, one file per calendar month, named `YYYY-MM.jsonl`
inside `journal/` — four digits, a hyphen, two digits, lowercase extension.

**RL-28a.** The month is the record's own `ts` read **in UTC**, never in the machine's local time.

`ts` is unix seconds, so it is already UTC; deciding the filename in local time means a record
written at 02:00 on 1 February in Jakarta lands in `2026-01.jsonl`, and the same library carried one
time zone east starts writing the same instant into a different file. `YYYY-MM` sorts
chronologically as plain text, which is what lets RL-29 be a string sort.

**RL-29.** Replay MUST process files in chronological order, oldest month first, and records within
a file in the order they appear.

**RL-30.** Every mutation MUST be written to the journal **before** the implementation's own index
or cache. A write that reaches a cache but not the journal is data loss.

**RL-31.** An implementation MUST NOT rewrite, compact, rebuild or prune the journal. This is
forbidden, not deferred.

### 6.1 Record format

**RL-32.** One operation per line, a single JSON object, newline-delimited. Every record MUST carry
`ts` and `op`.

- `ts` — unix **seconds**, integer.
- `op` — the operation name, a string.

```json
{"ts":1755648000,"op":"add","id":"K7QM4X2AJH9F","ext":"docx","name":"laporan tahunan"}
{"ts":1755648100,"op":"tag_add","id":"K7QM4X2AJH9F","tags":["client","2026"]}
{"ts":1755648260,"op":"folder_add","id":"K7QM4X2AJH9F","folder":7}
```

**RL-32a.** Every number in this format is unix seconds, **except** `at`, which is milliseconds into
a medium. It is named `at` rather than `ts` so that it cannot be read as the record's own timestamp.

**RL-33.** The `name` an `add` or a rename carries is the name a person reads, and it **MUST NOT
carry the file's extension**. The extension is on the file (RL-9) and is derived (RL-22); a display
name is `laporan tahunan`, and what a window shows is that name joined to the extension it finds.

This is the rule that makes RL-9b free. A name carrying `.docx` would have to be rewritten every time
an application saved the file as something else — a journal record written because a fact about the
bytes changed, which is exactly what RL-23 forbids.

**RL-34.** The operations of this revision, their fields, and the revision each appeared in are
listed in [`OPS.md`](OPS.md). That file is normative.

### 6.2 Identifiers in records

**RL-35.** An operation that creates an entity MUST carry that entity's identifier explicitly, and
replay MUST insert exactly that identifier rather than allocating one.

**RL-36.** An implementation allocating a new integer identifier MUST take it from the journal's own
maximum, never from the last row its database inserted.

A folder id allocated by a database after a partial replay collides with one the journal already
used, and every membership record pointing at it dangles.

### 6.3 Damaged and unknown records

**RL-37.** A record whose `op` is not recognised MUST be **skipped with a warning** and MUST NOT be
treated as an error.

**RL-38.** A record naming an entity that does not exist — a membership in an unknown folder, a
rating on an unknown asset — MUST be skipped, MUST be logged, and MUST be counted in a figure the
implementation can report. An implementation MUST NOT create the missing entity in order to accept
the record.

**RL-39.** A truncated final line — the ordinary result of a crash — MUST be skipped with a warning,
exactly as RL-37 requires for an unknown operation.

**RL-40.** An implementation that skipped a record under RL-37 MUST tell the **person**, not only a
log, and MUST name the operations it skipped.

Skipping is safe because the journal is append-only: a record one implementation ignores is still
there when the library opens in another. Skipping is not losing. Silently skipping is a library that
quietly means less than it says, and the user is the only one who can act on that. Naming the
operation matters because a noun can be searched for; *"this library holds changes this version
cannot show"* is a sentence nobody can act on.

---

## 7. Extension

**RL-41 — Operations are namespaced.** A core operation carries no prefix (`add`, `tag_add`). An
operation belonging to one platform MUST carry one, separated by a dot: `win.shell_pin`.

**RL-42 — A new operation MUST NOT raise the format version.** Neither may a new field, nor a
platform feature, nor a new table in anybody's cache.

**RL-43 — The version rises only when an older reader would be *wrong*.** Reading incompletely is
handled by RL-37 and RL-40. The version rises for: a change to the directory layout, a change to the
meaning of an existing field, a change to the shape of an identifier, a change to the naming of
files under `files/`, or a newly required field in `library.json`.

**RL-44 — Unknown fields on a known operation MUST be ignored, never rejected**, and the record MUST
NOT be rewritten to remove them.

**RL-45 — A new operation MUST NOT be a prerequisite for an existing one.**

An extension owns its own entities, may attach to core entities, and never the reverse. Otherwise an
implementation that skips the new operation processes the old one and holds a reference to nothing.

**RL-46 — Every feature MUST tolerate its referents disappearing.** An implementation that has never
heard of a feature will delete assets that feature referred to.

**RL-47 — A stored query an implementation cannot evaluate is not a mistake.** A smart folder whose
`query` names something this implementation does not understand MUST be kept byte for byte, MUST NOT
be dropped, rewritten or repaired, and MUST be presented as **unavailable**, naming the part that
could not be evaluated.

This is not a registry of query terms and one MUST NOT be inferred from it. The query language is
not part of this format, so no implementation holds a complete list of its terms. A query is
something a person wrote once into an append-only journal; reporting it as a syntax error would call
their saved work a typo, and "repairing" it would write a different query back.

---

## 8. Text and encoding

**RL-48.** Every text file in this format — `library.json` and every journal file — MUST be UTF-8,
with **`\n`** line endings, and **no byte-order mark**, on every platform.

**RL-49.** Names recorded in the journal MUST be normalised to **Unicode NFC** on write.

Systems disagree about normalisation, so the same name becomes different bytes depending on where it
was typed. Normalising at the write path is what makes comparison stable. This does not affect files
under `files/`, which are named by id.

**RL-50.** A JSON record MUST be built field by field. An absent optional field MUST be **absent**,
never present with a null-like placeholder — except where the registry states that a `null` carries
meaning an absent field would lose.

---

## 9. Forbidden

**RL-51.** An implementation MUST NOT, under any framing:

- use the name a person gave an asset as its on-disk filename;
- write a per-asset metadata sidecar, anywhere;
- put anything but assets' own files inside `files/`;
- shard `files/` across two directory levels, or give each asset a directory of its own;
- encode file data as base64 anywhere in the pipeline, journal included;
- represent folder membership as a path or a column on the asset — folders are collections, and an
  asset belongs to zero or more of them;
- journal a fact it derived from the bytes (RL-23);
- hold a file open in a way that stops another application editing it (RL-21);
- rewrite or compact the journal.

---

## 10. Conformance

**RL-52.** An implementation claiming to support Roost Library Format 2 MUST pass the suite in
[`conformance/`](../conformance/) and SHOULD run it in its own continuous integration.

**RL-53.** An implementation MUST have a test that deletes its cache, replays the journal, and
asserts the result equals the state before deletion (RL-24).

**RL-54 — The suite is layered by revision.** `conformance/library.roost` is required of every
implementation. A revision that adds operations adds a library of its own, and an implementation
MUST pass every library up to the revision it states — and is not required to pass the ones above
it.

An implementation written against 2.0 meeting a 2.1 library is not wrong; it is behind, and RL-37
and RL-40 say exactly what it does about that.

**RL-54a — A revision MAY add cases to an earlier library, for requirements that revision already
made.** A case for a requirement an implementation already claims cannot make a conforming build
fail. A revision that adds such cases MUST name them in the commit that adds them.

**With one implementation, this suite is the only thing standing between a specification and a
description.** A standard with a single implementation drifts into recording whatever that
implementation happens to do. On 2026-09-17 the version 1 suite found six operations that nothing
had ever replayed.

---

## 11. Open and reserved

Listed rather than decided. An implementation MUST NOT assume an answer to anything here.

### 11.1 Does removing an asset delete its file? — open

Trashing an asset is a state and changes nothing on disk. Removing one permanently is the question:
the row goes, and this document does not yet say whether the file under `files/` goes with it.

Version 1 left the same question open and could afford to, because its files were immutable and an
orphan was harmless. Here an orphan is a file in `files/` that RL-11 and RL-12 both have opinions
about, so the answer matters more.

### 11.2 Version history — undefined

Editing in place leaves no record that an edit happened (RL-23), so a history of versions would need
one. Nothing is defined for it, and `versions/` is reserved (RL-56) against the day something is. An
implementation MUST NOT invent it in the meantime.

### 11.3 Stacking — undefined

No operation is defined for grouping assets into a stack. `roost-net` ADR-0021 and ADR-0028 hold a
design; neither is proposed here, because nothing has been built that needs it.

### 11.4 Does a tag with no assets survive? — open

Tags are named rather than numbered, and nothing here says whether the library still holds `blue`
after the last asset carrying it is untagged or removed. A build that keeps it shows an empty tag in
a sidebar; a build that does not makes the tag reappear the next time anybody types it. Both are
defensible and they are visibly different, which is the combination that makes this worth listing.

Carried over unanswered from version 1, where it was §11.4.

### 11.5 Reserved names

**RL-56.** These names are reserved in the library root and MUST NOT be used for anything else:
`library.json`, `journal`, `files`, `thumbs`, `index.db`, `settings.json`, `staging`, `versions`,
and any name beginning with `roost`.

---

## 12. Changing this document

**Every change raises a number. Nothing about a library changes silently.**

1. A change is argued in an ADR in `docs/adr/`: what breaks today, and what the alternatives cost.
2. Additive changes (a new operation, a new optional field, a clarification) raise the **document
   revision**, and `OPS.md` records which revision introduced what.
3. A change that would make a current library unreadable raises the **format version**. The first
   such change also decides the value that marks the library, so that no program still written
   against revision 2.0 opens it believing it understands it (ADR-0052 §4).
4. This document, `OPS.md`, `conformance/` and the code change **in the same commit**. A requirement
   with nothing to check it is a requirement the build will quietly stop meeting.

Which number moves turns on one question: would a build written before the change read the new
library **wrongly**, or merely **incompletely**? Incompletely is a revision; wrongly is a version.
**A new feature is always the first.**

Until 2026-09-26 this section pointed to `CHANGING.md` in the `roost-library` repository, which
required a change to be made there before any implementation built it. That procedure no longer
applies (ADR-0052).

---

## Appendix A — lineage, and what version 2 changed

Version 1 was defined by the Rust implementation (`roost-old`, discontinued 2026-08-29), carried
unchanged into the TypeScript implementation (`roost`, this repository), and carried
unchanged again into the C# implementation (`roost-net`). It never changed version, it is FINAL, and
it is kept in the `roost-library` repository.

Version 2 was written on 2026-09-20, after the user stated that Roost is a **workspace** rather than
an archive: files are opened in the applications that own them, edited in place, and saved. What
changed, and why:

| Version 1 | Version 2 | Because |
|---|---|---|
| Identity is the hash of the bytes | Identity is a random 12-character id | Editing a file changes its bytes, and under version 1 that made it a different asset |
| `originals/`, sharded by hash, immutable | `files/`, sharded by id, editable in place | A workspace is a place where files change |
| The file is named by its hash | The file is named by its id | The name has to survive an edit |
| The journal records size, dimensions and link method | Every fact about the bytes is derived | They change whenever the file is saved, and journalling each save would fill the journal with what the disk already holds |
| Two modes, `managed` and `referenced` | One mode | With in-place editing the second mode bought a second rule for every feature, and an absolute path that means nothing on another machine |
| `supersede` recorded that an edit made a new asset | No such operation | An edit does not make a new asset any more |
| A partial hashing scheme for files over 50 MB | No hashing scheme at all | Hashing is no longer identity; an implementation that wants one may keep one (RL-18) |
| Thumbnails forbidden inside the library | `thumbs/` is a reserved, non-normative directory | The prohibition existed to stop sidecars; a cache in a reserved directory is not a sidecar |

**No library is migrated.** The libraries that existed when this was written were demonstrations, and
the obligation version 1 carried — to keep reading what the Rust and TypeScript builds wrote — is
retired in `roost-net`'s own decision records rather than assumed away here.

On 2026-09-26 the TypeScript implementation took this document into its own repository and stopped
following `roost-library` (ADR-0052). Nothing in the format changed on that day. Opening the same
library from `roost-net` is no longer a goal.
