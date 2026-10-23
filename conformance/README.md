# Conformance

**Normative.** `docs/FORMAT.md` RL-52 requires this build to pass it, and `pnpm test` runs it.
Copied from the `roost-library` repository on 2026-09-26 and kept here since (ADR-0052). It is ours
to extend, in the same commit as the requirement a new case checks.

| | |
|---|---|
| [`library.roost/`](library.roost/) | A Roost library, carrying the cases that are easy to get wrong |
| [`expected.json`](expected.json) | The state a correct replay produces |
| [`made-before-the-rule/`](made-before-the-rule/) | A library whose folder has no `.roost` suffix, which must open anyway |
| [`revision-2.4/`](revision-2.4/) | `tag_delete`: its own library and `expected.json`, required from revision 2.4 |

**The suite is layered by revision (RL-54).** `library.roost` is required of every implementation.
Each revision that adds operations adds a library of its own, and an implementation passes the ones
up to the revision it states — **an implementation at 2.0 is not expected to pass a 2.1 library and
is not failing when it does not.**

**With one implementation, this suite is the only thing keeping the specification a specification.**
Everything else in this repository is prose that the build can quietly disagree with.

## How to run it

1. **Copy the library somewhere writable.** Replaying it produces a cache, and the fixture is
   committed without one on purpose.
2. Replay `library.roost/journal/2026-01.jsonl` then `library.roost/journal/2026-02.jsonl`, in that
   order.
3. Compare the result with `expected.json`.
4. Check that nothing under `library.roost/files/` was created, deleted or renamed by the replay —
   including the lock file, which is the point of RL-11.
5. Open `made-before-the-rule/` and check that it opens, is reported as a library named
   *made-before-the-rule*, the folder's name, while its `library.json` still says *Made before the
   rule* (RL-7b, from revision 2.2), and is **not renamed**.

**The library is committed with no cache, and an implementation must not add one to it.** A
committed `index.db` would bake one implementation's schema into a shared fixture, and every other
implementation would then be conforming to that rather than to the format.

**The files under `files/` are placeholders and their contents are not normative.** In version 2
every fact about the bytes is derived (RL-22), so there is nothing about them for a fixture to pin —
which is itself the difference from version 1, whose expected state asserted a size, a width and a
height for every asset.

## What each case checks

### Replay and ordering

| | |
|---|---|
| Two month files | RL-28, RL-29. `2026-02` renames a tag created in `2026-01`, so an implementation reading them in the wrong order gets a different tag set |
| 52 records, 51 complete | The last line of `2026-02.jsonl` is deliberately truncated mid-key, with no newline |

### Skipping

| Case | Record | Requirement |
|---|---|---|
| Unknown core operation | `lightbox_create` | RL-37, RL-40. A feature from a revision this implementation does not have. Skipped, and the person told |
| Another platform's operation | `mac.quicklook_tag` | RL-37, RL-41. The prefix is what lets the message name macOS without a registry of features |
| A newer build of this platform | `win.shell_pin` | RL-41. Same shape, different meaning: a `win.` operation unknown to a Windows implementation is a *newer Windows build* |
| Unknown field on a known operation | `spotlight_id` on the first `add` | RL-44. The asset must import normally and the field must not be rewritten away |
| Dangling reference | `folder_add` naming folder 99 | RL-38. Skipped, logged and counted — and folder 99 must **not** be created |
| Torn final line | `{"ts":…,"op":"tag_ad` | RL-39 |

### Identity and the disk

| Case | Requirement |
|---|---|
| `H8VKC0S6ZB1P` has no extension, and its file has **no trailing dot** | RL-9a. The one a Windows implementation passes against itself and fails against every other system |
| `files/K7/~$QM4X2AJH9F.docx` — a lock file Word left behind | RL-11. Neither adopted as an asset nor deleted |
| Every file is `<id>.<ext>` under the first two characters of its id | RL-8, RL-9 |
| `ZQ2F7YNM4KDW` was removed and has no file | Nothing is asserted about whether a `remove` deletes one — `docs/FORMAT.md` §11.1 is open |

### State

| Case | Requirement |
|---|---|
| `asset_rename` changes the name and **nothing on disk** | RL-9, RL-33. The file is still `K7QM4X2AJH9F.docx` |
| Names carry no extension | RL-33. `laporan tahunan final`, not `laporan tahunan final.docx` |
| `café möbel` in NFC | RL-49 |
| `tag_rename` onto an existing name merges | The asset that carried `blue` carries `clients` |
| `folder_delete` takes the subtree and the memberships, and leaves the assets | `docs/OPS.md` → Folders |
| `folder_move` to `null` means the top level | The `null` is written rather than omitted |
| `rate` with `"rating":null` clears rather than being ignored | RL-50's exception |
| `trash` then `restore` leaves the asset live and unchanged | |
| A smart folder whose query names `color:` | RL-47. Stored byte for byte and presented as **unavailable** |
| `watch_add` carries `take` | `move` or `copy`, decided when the root is registered |
| A tag left with no assets | **Not asserted.** `docs/FORMAT.md` §11.4 is open |

## Revision 2.4 — `tag_delete`

[`revision-2.4/library.roost`](revision-2.4/library.roost/) is replayed on its own, one month file,
and compared with [`revision-2.4/expected.json`](revision-2.4/expected.json). Required of an
implementation stating revision 2.4 or later (RL-54); one at 2.3 skips the two `tag_delete` lines and
says so (RL-37, RL-40).

| Case | Checks |
|---|---|
| `wood` and `Wood` on two assets, deleted as `WOOD` | A tag name compares case-insensitively, and the delete takes it off both |
| `tag_delete` of `never-was` | A no-op, **not** a dangling reference: a tag is named, never numbered |
| `wood` added again after the delete | A new tag, in no group: the old one's place in `Material` went with it |
| `glass` in `Material`, untouched | Deleting one tag of a group leaves the group and the others |

