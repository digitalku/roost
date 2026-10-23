# Journal operation registry

**Normative.** Part of the Roost Library Format, version 2, revision 2.0. Referenced by `FORMAT.md`
RL-34. Copied from `roost-library`'s `ops/REGISTRY.md` on 2026-09-26 and kept here since
(ADR-0052).

Thirty-three operations. Version 1's registry is kept in `roost-library`, at `v1/ops/REGISTRY.md`,
and nothing here is compatible with it: version 2 keys every record by an **id** rather than by a
content hash, and the operations that existed only to describe the bytes are gone.

**This file is what replaces a version bump.** An implementation written against revision 2.0 and
meeting a library written against 2.3 skips what it does not know (RL-37) and tells the person which
operations it skipped (RL-40).

## How to read the tables

- Every record also carries `ts` and `op`, required by RL-32. They are not repeated below.
- **Required** fields are always present. **Optional** fields are absent when they have no value —
  except where the notes say a `null` carries meaning, in which case the field is always written.
- **`id` is the entity the record creates. `asset` is an asset the record refers to.** Both are
  identifiers; naming them apart is what lets one record carry a comment's id and the id of the
  asset it is about.
- An asset id is twelve characters of Crockford base32, upper case (RL-14). Every other entity is
  identified by an integer (RL-17).

---

## Assets

### `add` — an asset enters the library

```json
{"ts":1755648000,"op":"add","id":"K7QM4X2AJH9F","ext":"docx","name":"laporan tahunan","created":1754102400}
```

| Field | | Type | Meaning |
|---|---|---|---|
| `id` | required | string | The asset's identity (RL-13, RL-14) |
| `ext` | required | string | Extension without a dot, lowercase. **Empty when the file has none** — RL-9, RL-9a |
| `name` | required | string | The name the user reads, **without the extension** (RL-33). NFC (RL-49) |
| `created` | optional | integer | The source file's own date when it was imported, unix seconds |

**What is not here is the point of version 2.** Version 1's `add` also carried `size`, `w`, `h`,
`mode`, `link` and `partial`. Every one of them describes the bytes, and the bytes now change
whenever somebody saves the file — so they are derived (RL-22), read from the file when needed, and
never journalled (RL-23).

**`created` survives that test and stays.** It is the date the file had *before* it entered the
library, which nothing can recover afterwards: the stored file's own date becomes the date of the
last edit the moment anybody saves it. The date shown for an asset with no `created` is its import
time, which is this record's `ts`.

`ext` is recorded as well as being on disk because it is what an implementation uses to find the
file (RL-9) without listing the directory. When an application saves the file under another
extension, RL-9b renames the file and journals nothing; an implementation that cannot find
`<id>.<ext>` looks for `<id>.*` and takes the one file RL-12 allows.

### `remove` — the asset and everything about it are gone

```json
{"ts":1755648300,"op":"remove","asset":"K7QM4X2AJH9F"}
```

The only operation that discards a user's work. Emptying a trash is what writes it.

**Whether the file under `files/` goes with the row is open** — `FORMAT.md` §11.1. An implementation
MUST NOT assume the other one behaves as it does.

### `trash` · `restore` — reversible removal

```json
{"ts":1755648600,"op":"trash","asset":"K7QM4X2AJH9F"}
{"ts":1755648610,"op":"restore","asset":"K7QM4X2AJH9F"}
```

`trash` marks the asset and changes nothing else — name, tags, rating, note, folder memberships and
the file itself all stay. **It carries no timestamp of its own**: the record already has `ts`, so a
live edit and a rebuild cannot disagree about when something was trashed.

An implementation that does not know these two sees every asset as live. It shows *more* than it
should rather than losing anything, which is the correct direction for a skip to fail in.

### `asset_rename` · `rate` · `note_set` · `favorite_set` · `source_set`

```json
{"ts":1755648440,"op":"asset_rename","asset":"K7QM4X2AJH9F","name":"laporan tahunan final"}
{"ts":1755648460,"op":"rate","asset":"K7QM4X2AJH9F","rating":4}
{"ts":1755648470,"op":"note_set","asset":"K7QM4X2AJH9F","note":"client approved"}
{"ts":1755648480,"op":"favorite_set","asset":"K7QM4X2AJH9F","favorite":true}
{"ts":1755648830,"op":"source_set","asset":"K7QM4X2AJH9F","url":"https://example.com/the-post"}
```

**`asset_rename` never touches the disk.** The file is named by the id (RL-9), so renaming is a
journal record and nothing else: it cannot fail on a locked file, an invalid character, a reserved
name or a path that grew too long, and it costs the same for one asset as for five hundred. The name
it carries excludes the extension (RL-33).

**`rating`, `note` and `url` are always written, `null` included** (RL-50's exception). `null` clears
the value, and an absent field would be indistinguishable from "unchanged" — clearing a rating is not
the same as one star.

`url` is stored **exactly as the user typed it** — unparsed, unnormalised, not required to have a
scheme. It answers a question rather than being an address this format vouches for.

---

## Tags

### `tag_add` · `tag_remove` · `tag_rename` · `tag_delete`

```json
{"ts":1755648100,"op":"tag_add","asset":"K7QM4X2AJH9F","tags":["client","2026"]}
{"ts":1755648200,"op":"tag_remove","asset":"K7QM4X2AJH9F","tags":["2026"]}
{"ts":1755648450,"op":"tag_rename","from":"client","to":"clients"}
{"ts":1755648480,"op":"tag_delete","tag":"draft"}
```

**Tags are named, never numbered.** A tag id is assigned by an implementation's own cache, which is
derived, so a journal record depending on one would not survive a rebuild.

**`tag_rename` onto a name that already exists merges into it.** Not a convenience: tag names are
unique and case-insensitive, so no other outcome both succeeds and replays to the same state.

**`tag_delete` takes the tag off every asset and out of the library**, in one line however many
assets carried it (revision 2.4). The name compares case-insensitively, as every tag name does, and
a name nobody has is an ordinary no-op rather than a dangling reference: a tag is named, never
numbered. Its place in a group goes with it, so a tag of the same name added afterwards is new and
in no group. Nothing else about the assets changes.

*An implementation at revision 2.3 or earlier meeting this line* skips it and says so (RL-37,
RL-40): it reads the library incompletely, still showing the tag, and never wrongly.

### `tag_group_create` · `tag_group_rename` · `tag_group_set` · `tag_group_delete`

```json
{"ts":1755648520,"op":"tag_group_create","id":1,"name":"Material"}
{"ts":1755648530,"op":"tag_group_rename","id":1,"name":"Materials"}
{"ts":1755648540,"op":"tag_group_set","tag":"wood","group":1}
{"ts":1755648550,"op":"tag_group_delete","id":1}
```

`tag_group_set` names its tag and numbers its group, for the reason above. `"group":null` takes the
tag out of its group.

**`tag_group_delete` removes the arrangement, not the tags.** The tags survive ungrouped and every
asset carrying them is untouched.

*A group has no stored colour, and this is settled rather than missing.* An implementation that
colours tags in its interface derives the colour from the group and stores nothing.

---

## Folders

Folders are **collections**, never locations. An asset belongs to zero or more of them (RL-51).

This is why `files/` is sharded by id rather than laid out to match the folder tree: a file that is
in three folders has no one place on disk to be.

### `folder_create` · `folder_rename` · `folder_move` · `folder_delete`

```json
{"ts":1755648250,"op":"folder_create","id":7,"parent":null,"name":"Moodboards"}
{"ts":1755648410,"op":"folder_rename","id":7,"name":"References"}
{"ts":1755648420,"op":"folder_move","id":7,"parent":null}
{"ts":1755648430,"op":"folder_delete","id":7}
```

`folder_create` carries an explicit `id`, and RL-35 requires replay to insert exactly that one.

`folder_move` always writes `parent`, `null` included: `null` means the top level, and an absent
field would mean "unchanged".

**`folder_delete` removes the folder, its descendants, and every membership in them.** The assets are
untouched. An implementation that also trashes what was filed there writes those `trash` records
itself, in the same batch, as records of their own.

### `folder_add` · `folder_remove` — membership

```json
{"ts":1755648260,"op":"folder_add","asset":"K7QM4X2AJH9F","folder":7}
{"ts":1755648400,"op":"folder_remove","asset":"K7QM4X2AJH9F","folder":7}
```

---

## Smart folders

### `smart_folder_create` · `smart_folder_update` · `smart_folder_delete`

```json
{"ts":1755648490,"op":"smart_folder_create","id":1,"parent":null,"name":"Recent PNGs","query":"ext:png imported:>2026-01-01"}
{"ts":1755648500,"op":"smart_folder_update","id":1,"name":"Recent PNGs","query":"ext:png rating:>=4"}
{"ts":1755648510,"op":"smart_folder_delete","id":1}
```

**`query` is an opaque string as far as this format is concerned.** The query language is not part of
the library format. An implementation that cannot evaluate a query stores it, shows the smart folder
as **unavailable** naming the part it could not evaluate, and writes it back untouched — `FORMAT.md`
RL-47. It MUST NOT rewrite or drop it: a query it cannot run is one another implementation can.

---

## Time-based media

### `comment_add` · `comment_set` · `comment_remove`

```json
{"ts":1755648700,"op":"comment_add","id":1,"asset":"K7QM4X2AJH9F","at":91500,"body":"the cut lands early"}
{"ts":1755648710,"op":"comment_set","id":1,"at":91000,"body":"two frames early"}
{"ts":1755648720,"op":"comment_remove","id":1}
```

**`at` is milliseconds** — the one number in this format that is not unix seconds (RL-32a). A second
of granularity on a 24fps cut is twenty-four frames of ambiguity.

`at` is always written. **`"at":null` is a comment about the asset rather than about a moment in
it**, which is what lets a `.zip` carry one.

**A comment survives the file being edited**, and this is the case version 2 has to be honest about:
the asset is the same asset after a save, so a comment at 1:31.5 stays at 1:31.5 even if the cut it
described has moved. That is the price of an identity that does not change with the bytes, and it is
the user's to manage.

### `poster_set` — which frame represents a video

```json
{"ts":1755648730,"op":"poster_set","asset":"K7QM4X2AJH9F","at":91500}
```

**It records where to look, never the pixels.** The thumbnail is a function of the file *and one
number*, so a rebuild replays this record and extracts the frame again. An image inline here would be
base64 in a text file, which RL-51 forbids twice over.

`"at":null` returns the video to its default frame, which is not the first frame but one a tenth of
the way in.

### `subtitle_attach` · `subtitle_detach`

```json
{"ts":1755648800,"op":"subtitle_attach","asset":"K7QM4X2AJH9F","track":"M4T0PZ71QJ2B","lang":"en","label":"English"}
{"ts":1755648810,"op":"subtitle_detach","asset":"K7QM4X2AJH9F","track":"M4T0PZ71QJ2B"}
```

**A caption track is an ordinary asset**, addressed by its own id. The attachment is this record
rather than a folder convention. `lang` and `label` are omitted when unknown.

---

## Watched roots

### `watch_add` · `watch_remove` — a directory the library keeps an eye on

```json
{"ts":1772323300,"op":"watch_add","id":1,"path":"D:\\Inbox","take":"move"}
{"ts":1772323303,"op":"watch_remove","id":3}
```

| Field | | Type | Meaning |
|---|---|---|---|
| `id` | required | integer | Minted by the writer and journalled explicitly (RL-35) |
| `path` | required | string | **Absolute**, NFC (RL-49). Not interpreted by this format |
| `take` | required | string | `move` or `copy` — what happens to a file found there |

**A watched root is configuration somebody typed, which is why it is here rather than in
`settings.json`.** RL-2 puts that file outside the format entirely, so a watched root stored there
would make *"is this folder watched?"* a question whose answer depends on which implementation is
asked — and both answers would be right.

**`take` replaces version 1's `mode`.** There is only one storage mode now (RL-19), so the question a
watched root still has to answer is not *where do the bytes live* but *what happens to the file it
found*: moved out of the inbox, or copied and left there. Nobody is at the screen when a watched
folder catches something, so the answer is decided once, when the root is registered.

**RL-25's sentence applies here too**: a watched root whose directory cannot be found is reported as
unreachable and is never removed. A drive that is not mounted today is mounted tomorrow.

**The path is not a key; the id is.** Two `watch_add` records naming the same directory are two
watched roots, and replay keeps both. An implementation SHOULD NOT create a second root for a
directory it already watches, and MUST NOT remove one it finds.

**There is no `recursive` field and no `watch_update`.** A watched root is its subtree; changing one
is `watch_remove` followed by `watch_add`.

**Nothing here requires a daemon.** An implementation that catches up when the library opens is
conforming. These operations record *which* directories are watched, never *when* they are looked at.

---

## Since

| Operation | Entered | Revision |
|---|---|---|
| `add` · `remove` · `trash` · `restore` · `asset_rename` · `rate` · `note_set` · `favorite_set` · `source_set` | 2026-09-20 | 2.0 |
| `tag_add` · `tag_remove` · `tag_rename` · `tag_group_create` · `tag_group_rename` · `tag_group_set` · `tag_group_delete` | 2026-09-20 | 2.0 |
| `folder_create` · `folder_rename` · `folder_move` · `folder_delete` · `folder_add` · `folder_remove` | 2026-09-20 | 2.0 |
| `smart_folder_create` · `smart_folder_update` · `smart_folder_delete` | 2026-09-20 | 2.0 |
| `comment_add` · `comment_set` · `comment_remove` · `poster_set` · `subtitle_attach` · `subtitle_detach` | 2026-09-20 | 2.0 |
| `watch_add` · `watch_remove` | 2026-09-20 | 2.0 |
| `tag_delete` | 2026-10-24 | 2.4 |

### What version 1 had and this does not

| Gone | Why |
|---|---|
| `supersede` | It recorded that an edit produced a new asset. An edit no longer produces one (`FORMAT.md` §5) |

Every other version 1 operation is here, with `hash` replaced by `id` or `asset`, and with the
fields that described the bytes removed from `add`.

---

## Platform operations

Not listed here, and deliberately. RL-41 requires a platform operation to carry a prefix —
`win.shell_pin` — and that prefix is the whole of what another implementation needs in order to skip
it safely and name the platform when it tells the user.

A registry of them would be a list every implementation must update and none can verify. The prefix
does the work instead. What the standard does require is RL-45: an extension owns its own entities
and may attach to core ones, never the reverse.
