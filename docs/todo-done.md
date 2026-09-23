# Roost — TODO, closed

Items from [`TODO.md`](TODO.md) that are done, in the sections and the order they were written
in. **This is an archive**: nothing here is outstanding, nothing here is edited, and nothing here
is deleted. It exists because `TODO.md` is read at the start of every session and a closed item
costs the same to read as a live one.

Look here for what was tried and what it cost on the day. The decision behind an item is in
[`adr/`](adr/), the session it happened in is in [`SESSION_LOG.md`](SESSION_LOG.md) or its
monthly archive under [`sessions/`](sessions/), and what shipped is in
[`ROADMAP.md`](ROADMAP.md).

---

## 1. Needs a decision from the user

- ☑ ~~**ADR-0032 §8 — Eagle fills what is empty.**~~ **Amended and built 2026-09-08**, from the
  user asking what an Eagle import does when the file is already in the library. The bytes were
  never the problem — the three fields a person writes one at a time were: `rating`, `note` and
  `source_url` were last-write-wins, so Eagle silently replaced a rating somebody set here. It now
  writes only where the field is empty, **inside one run as well as between two** (two Eagle items
  with identical bytes are one asset, and the ops are applied a chunk at a time, so the index cannot
  answer "is this empty" on its own). `preserved` counts what it declined to write, in the report,
  the status bar and the CLI; the Eagle dialog says the rule up front but never a number, because a
  number would cost a hash of the whole library. Union rules for tags, folders, comments and trash
  are unchanged. `repo.judgements()` is the one new read. 3 more tests, 1108 in the workspace.

- ☑ ~~**ADR-0037 — an import lands where you are.**~~ **Accepted 2026-09-08** and built the same
  day, from the user asking
  whether importing files or a folder while a folder is open can put them in that folder, and what
  should happen to the files the library already holds. Two answers already came from them, both as
  recommended: *folder baru* means the folder **already on screen**, and an import made outside a
  folder files nothing rather than asking. The folder half is small — the window knows which folder
  is open (`App.tsx`'s `openFolder`), `folder_add` is a line this build has written since M2, and
  the Eagle exclusion the user asked for is the default rather than a guard, because `eagle.ts`
  maps Eagle's own folders (ADR-0032 §3). The duplicate half carries the thinking: deduplication
  here is **structural**, so a duplicate is only discovered by hashing the incoming file — the
  dialog therefore comes **after** a run rather than in front of one, which costs nothing because
  an import writes nothing for a duplicate today. `ImportReport` has a count and not a list; the
  wire report gains a preview and the engine retains the run's full hash list, because a re-import
  of a large directory is the ordinary way to end up with a hundred thousand of them. The second
  choice is an **add**, not a move: `asset_folders` is many-to-many. No journal op, no migration,
  no schema change. Built: `ImportOptions.folder`, `folder` on `import:paths`,
  `import:fileDuplicates`, `duplicateNames` on the report, `DuplicatesDialog`, and
  `roost import --folder`. 15 more tests, 1105 in the workspace. **Pasting is deliberately left
  alone** (ADR-0026's gesture, and half of what it carries is not a file), and **no window check
  covers this** — neither door into an import can be driven over CDP, which the ADR §4 records
  rather than leaving to look like coverage.

- ☑ ~~**ADR-0022 — what `Delete` means.**~~ Accepted 2026-09-01 and built the same day: trash
  marks the row and keeps everything hanging off it, **nothing is ever emptied on a timer**, and
  permanent removal stays `remove`. Migration 0007, the `trash`/`restore` ops, `is:trashed`,
  the Trash place, `roost trash`, and the window's `Delete` key all landed together.

- ☑ ~~**ADR-0024 — a video transport of our own.**~~ Accepted 2026-09-02, the same day it was
  proposed, after the user asked what media player Eagle uses. It is the same player: Eagle is an
  Electron application, so its playback is Chromium's, with `controls` off and a transport drawn
  over it. The work is in §3 below.

- ☑ ~~**ADR-0025 — subtitles.**~~ **Accepted 2026-09-03** and **stage 1 built 2026-09-05**:
  migration 0011, `subtitle_attach`/`subtitle_detach`, sibling detection at import, SRT→WebVTT
  over `roost://subtitle/`, the CC menu in the transport, `roost subtitle`, and `is:subtitle` /
  `is:captioned` — and **Add subtitle…** in the transport's CC menu, which imports and attaches in
  one request (2026-09-05, at the user's choosing: of the two doors sketched, the one *inside* the
  CC menu is where somebody notices they have no subtitles), and the inspector's **Subtitles**
  block — Open, Show in file manager, Delete — which is how a track is opened for editing at all;
  Delete detaches *and* trashes the track in one journal batch, because a half-done state would
  leave a trashed-but-attached track that nobody can see and nothing can find (`roost subtitle
  --detach` keeps the narrower operation for the CLI). Sibling detection was sharpened the same
  day: the name is matched **case-insensitively** (`Holiday.MP4` beside `holiday.srt`), and the
  import report counts both what attached and what found no film — the two outcomes are otherwise
  indistinguishable afterwards, and only one of them needs the user.
  Stages 2 and 3 — embedded tracks through ffmpeg, and cues in the index so
  `said:"…"` answers with a moment — are not started. Accepted the day it was proposed, from the user asking how Roost should do what
  Eagle does with an `.srt` dropped beside a video. Eagle's answer is a folder per asset, which
  this layout does not have, so the proposal keeps the convention only as an import-time heuristic
  and makes the attachment a journal line: the `.srt` is an ordinary content-addressed asset, a
  `subtitle_attach` op names what it captions, migration 0010 holds the pair, and
  `roost://subtitle/<hash>` serves WebVTT because `<track>` accepts nothing else. Three stages,
  the third of which (cues in the index, `said:"…"`) is the part Eagle has no answer for. **The
  one question that needed the user is already answered** — 2026-09-03, an attached track stays a
  row in `assets`, leaves the grid, and comes back with `is:subtitle`. Nothing is built yet;
  waiting on Accepted.

- ☑ ~~**ADR-0026 — an edit is a new asset.**~~ **Accepted 2026-09-03**, the day it was proposed,
  and **stage 1 was built the same day**. It governs
  the whole of "making files in the library, and editing text" (§3) and nothing else. Its answer to
  all three questions is one fact — the bytes *are* the identity, so a save cannot be a write.
  A save imports the new bytes and journals `supersede { from, to }`, carrying tags, folders,
  rating, comments, poster and any subtitle attachment across; `superseded_by` is a column
  (migration 0011, schema v11) and a third hidden-by-default rule in the grid, which is where
  those rules earn one predicate builder instead of three special cases. A referenced asset opens
  **read-only** with *Duplicate into library to edit*, because invariant 6 does not bend. New File
  is a draft in the window until it has bytes. Paste is four gestures and **never fetches a URL** —
  invariant 7's one exception gets its own menu item that says so. **One part of the request cannot
  be served and the ADR says so rather than narrowing it quietly**: an empty file exists once per
  library, and no schema change worth making buys the second.

- ☑ ~~**ADR-0027 — what free text searches.**~~ **Accepted 2026-09-05** and built the same day,
  from the user asking for a search that finds a title, a note, or a comment. The full-text index
  had two columns and both were labels — the filename a camera chose, and tags from a small
  vocabulary — so the two places somebody writes a *sentence* were the one thing search could not
  reach. Migration 0012 rebuilds `assets_fts` with `note` and `comments` (FTS5 has no `ADD
  COLUMN`, and dropping a derived index is a recomputation, not a loss), and `#refreshFts` gained
  the note and comment write paths. **The user's decision on the proposal was to add no syntax**:
  `name:`, `note:` and `comment:` were designed and dropped, because bare words are already
  free-text terms and a search box you have to learn is one people stop typing into. Owed:
  a free-text case in `scripts/bench-search.ts`.

- ☑ ~~**ADR-0028 — the application menu.**~~ **Accepted 2026-09-05** and built the same day, from
  the user asking whether the menu bar was Electron's. It was: nothing here had ever called
  `Menu.setApplicationMenu`, so Electron installed File · Edit · View · Window — a Reload that
  throws away the query and the selection, a devtools toggle for end users, and a Paste meaning
  something other than Roost's (ADR-0026 §5). It is removed on Linux and Windows; **macOS keeps a
  menu bar**, because there it belongs to the system and `Cmd+C`/`Cmd+V`/`Cmd+Q` come from its
  roles. Close library moved off the toolbar into a `☰`, Quit joined it with `Ctrl+Q` bound on the
  window (a menu item is not an accelerator), and `F11` for fullscreen is the one thing lost that
  is worth a keyboard-map entry later.

- ☑ ~~**ADR-0030 — where a file came from.**~~ **Accepted 2026-09-05** and built the same day, from
  the user asking for a link under the note, as Eagle keeps one URL per item. `assets.source_url`,
  migration 0013 (schema v13), the `source_set` op, `sourceUrl` on the wire, `asset:source` and
  `link:open`, the field in the inspector, `roost source`, and a line in `roost show`. Stored as
  typed — no parsing, no scheme required — and only an `http(s)` value gets a button, which hands
  the URL to the desktop rather than fetching it, so invariant 7 is untouched. **The user accepted
  it while rejecting §4**: the URL was proposed for `assets_fts` on ADR-0027's reasoning and ruled
  out, because a URL is an address rather than prose about the asset. The ADR keeps both halves of
  that argument, and what leaving it out costs — a domain typed into the search box finds nothing.

- ☑ ~~**ADR-0031 — a permanent delete takes the bytes.**~~ **Accepted 2026-09-06** and built the
  same day, from the user reporting that a file deleted permanently was gone from Roost and still
  on disk. It was: `removeAssets` deleted the row and left the object for `doctor --reclaim`, on
  ADR-0022's reasoning that a metadata edit must not delete someone's only copy — which does not
  describe a gesture called **Delete permanently**, reached from inside the trash, behind a
  confirmation. The managed object now goes with the row, a **referenced original is never
  touched** (invariant 6), and the order is journal → index → bytes so a crash leaves waste rather
  than loss. Both frontends report what came back (`Freed 12 B from originals/.`,
  `Deleted 3 assets, freeing 3.0 MiB`), and **zero is said too**. Reclaiming stays for orphans from
  elsewhere and finally has a door in the window: **Reclaim space…** in the `☰`, with
  `library:reclaimable` and `library:reclaim`, the CLI's refusal rule, and a re-check before
  anything is deleted. `STORAGE_SPEC.md` is untouched — the `remove` op means what it always meant.

- ☑ ~~**ADR-0029 — favourite is retired.**~~ **Accepted 2026-09-05** and built the same day, on
  the user seeing the two controls side by side: *"sudah ada star, kalau memang disukai tinggal
  saya bintang 5"*. A favourite is a rating with one value and no scale. Everything that authors
  one is gone — the inspector control, the Favorites place, `asset:favorite`, `setFavorite`,
  `roost favorite`, and `F`. **`is_favorite`, `favorite_set` and `is:favorite` stay**: the index is
  rebuilt from the journal, so a build that did not understand the op could not open a library that
  has one, and a smart folder saying `is:favorite` must still parse (`DATA_MODEL.md` §3). The CLI
  still prints the state where it exists, and only there.

- ☑ ~~**ADR-0032 — importing an Eagle library.**~~ **Accepted 2026-09-06**, the day it was
  proposed, from the user asking
  whether their existing Eagle library can be brought across, and supplying a real Eagle **4.0.0**
  library — 14 items, 1.1 GB — to read rather than remember. The premise it corrects is most of the
  design: Roost *has* folders, and they are Eagle's idea of a folder (collections, nested, an asset
  in many), so **folders map to folders** instead of degrading into tags. It needs **no journal op,
  no migration, and no schema change** — every line of the mapping is an operation this build
  already writes, which is the strongest evidence the two models agree. Reading the real library is
  what caught the six things a parser written from memory gets wrong: `mtime.json` carries an
  `"all"` key that is a count and not an id, `tags.json` is a typing history rather than the
  vocabulary, `star` is omitted when unrated so absent ≠ 0, a comment's timestamp field is called
  `duration` and is a position in float seconds, `annotation` means the note on an item and the body
  inside a comment, and `palettes` leaks AngularJS `$$hashKey` internals to disk. Two things fit
  better than they deserved to: the original's mtime on disk **is** the item's `mtime` field, so
  `created_at` fills itself, and a `.srt` sits beside a video mentioned by no metadata at all —
  exactly ADR-0025's heuristic, attached with no Eagle-specific code. **Smart folders are scoped out
  by the user**: a half-translated saved query silently returns the wrong set. **Three questions are
  answered** the same day: Eagle's `btime` is **not** carried — `imported_at` comes from the journal
  line's `ts`, so every migrated asset shares one "date added" while `created_at` stays correct, and
  the alternatives were a journal that lies about when a line was written or a column for one
  importer; the command is **`roost import --from-eagle <path>`**, one import door where the flag
  changes how the source is read and nothing after it; and **there are no selection flags at all**.
  That last one is the interesting answer: the user asked for selective import, was shown the three
  shapes it could take — prune the kinds of metadata, prune the items, or both — and took none,
  because choosing what to keep is a judgement about specific files that is made better in a grid
  than in a terminal, and Roost already has search, selection and trash for it. The survey
  (`--dry-run`) stays, because it answers "what am I about to do" rather than filtering anything.
  The work is in §3 below.

- ☑ ~~**ADR-0033 — the folder tree in the sidebar.**~~ **Accepted 2026-09-07**, proposed the
  evening before, from a screenshot of the user's own library: twenty folders in one column, four
  of them called `highlights`, none foldable. The request was expand/collapse, add, right-click for
  a subfolder, and delete with a checkbox for the contents. What the screenshot showed underneath it
  is the reason there is a record at all — **the pane had never drawn a tree**: `repo.folders()`
  orders by `sort_order` then name, nothing sets `sort_order`, and the window indented that one
  alphabetical run by depth, so a child was drawn under whatever sorted above it. The CLI never had
  the bug because `roost folder list` walks the tree. Three decisions: a branch **starts closed**
  (a folder's count is its subtree's, so nothing is hidden by it); the tree is **editable from the
  pane**; and **deleting one asks a question that is not "are you sure"** — unticked the folder goes
  and the assets stay unfiled, ticked they go to the **trash** in the same journal batch, because a
  replay landing between two batches would produce a state nobody asked for. The work is in §3
  below.

- ☑ ~~**ADR-0034 — handing a file to another application.**~~ **Accepted 2026-09-07**, the day it
  was proposed, from the user asking for drag-out and copy-out together. Its subject is the
  filename: the store names a file by its hash, which is right for the library and unreadable
  anywhere else, so a named copy is staged in a new `staging/` directory **inside** the library — a
  layout change to the binding spec, approved in the ask. Reflink, then copy, and **never a
  hardlink**, because a shared inode would let another application write into the original. It is
  the first ADR here accepted with a section left **open on purpose**: whether a native drag
  delivers `drop` back to its own window is a fact nobody has, and it decides which of §4's three
  designs is even possible. The work is in §3 below.

- ☑ ~~**`STORAGE_SPEC.md`'s journal-op list keeps falling behind the code.**~~ **Closed
  2026-09-06**, the shape it asked for. Twice it had fallen behind: the comment and poster ops were
  recorded on 2026-09-02, two days after the first three shipped, and `subtitle_attach`,
  `subtitle_detach` and `supersede` sat unrecorded from 2026-09-03 until ADR-0030 went in on
  2026-09-05. `spec-conformance.test.ts` now parses the journal lines out of the specification,
  asserts their `op` values are exactly `OP_NAMES`, and round-trips each one through `toRecord`
  and `toLine`. The second assertion catches the drift the first cannot see: a name in `OP_NAMES`
  that `toRecord` has no case for, which replay reports as a **corrupt line** rather than as an
  operation from a newer build.

- ☑ ~~**Unstyled component primitives.**~~ `UI_SPEC.md` §3
  builds every component in-repo on top of unstyled primitives for menus, dialogs, tooltips, and
  Settled 2026-08-30 by ADR-0021: `radix-ui` 1.6.7, after measuring all four candidates and
  investigating the native alternative the user asked for first. All four were clean against
  invariant 7 — no `fetch`, no `@font-face`, no CDN — so the constraint most likely to decide it
  decided nothing, and Radix won on being smallest, stable, and shaped like the two features
  that needed it.

- ☑ ~~**Where configuration lives.**~~ Settled 2026-08-30 by ADR-0019: `settings.json` inside
  the library is the default, and `stateDir()`/`configDir()` hold only what cannot live in one.
  The binding layout in `STORAGE_SPEC.md` gained its fifth entry with the user's approval — the
  only change this repository has made to it.

- ☑ ~~**Licence and copyright.**~~ Answered 2026-09-08 by ADR-0038, and it did differ: MIT was
  inherited from `roost-old` and never chosen. Roost is **proprietary, © Digitalku**, distributed
  as a binary — so `LICENSE` is a licence to use, the eleven manifests say `UNLICENSED`, and
  `THIRD-PARTY-NOTICES.md` exists because a reader can no longer find the dependencies for
  themselves. **Two things are still owed**: the repository has to actually be private (outside
  this working copy — the one item here that cannot be verified from it), and the credit the user
  asked for has no home in the window yet.

- ☑ ~~**An About dialog, and the picker's credit line.**~~ Built 2026-09-08 with ADR-0038,
  `UI_SPEC.md` §3.12. **About Roost…** in the `☰`, the notices compiled into the bundle rather
  than fetched, the homepage through `link:open` and the address as selectable text, and one quiet
  line under the picker for the state that has no `☰`. `app:about` is the request main answers.
  **What is still owed is a real version.** An unpackaged build has none — `app.getVersion()`
  answers with Electron's, which is what the dialog said the first time it was opened in a real
  window — so it draws **Development build** and leans on `ROOST_COMMIT`, set by `pnpm dev` and,
  when M6 arrives, by packaging. `scripts/check-about.mjs` holds all of it to §3.12 in a window,
  17 checks.

## 2. Blocked on the environment

- ☑ ~~**The newer fontconfig caches came back, and now they crash the window.**~~ Session 79 moved
  39 `*.cache-11` files out of `~/.cache/fontconfig`; on 2026-09-23 there were 73, the newest
  written at 07:06 that morning, and Electron no longer drew a window without text — it **died
  on the first text it laid out** with `SIGTRAP` and
  `SkFontMgr_FontConfigInterface.cpp:163 Not implemented`. The window checks were run with
  `XDG_CACHE_HOME` pointed at an empty directory instead, which touches nothing of the user's.
  **The writer is Claude Desktop** — Electron 44.2.0 in the podman `ubuntu` container, with the
  home directory mounted read-write — and it rewrites them each time it starts (`SETUP.md` §7).
  Three ways out, none taken yet: give that container its own `XDG_CACHE_HOME` (outside this
  repository), move Roost to Electron 44 (ADR-0011's deliberate bump, which fixes it only until
  the two drift apart again), or give Roost's Electron a private cache without leaking it to
  what the window launches, which session 79 looked at and did not find a clean way to do.
  **Closed 2026-09-23 by the third way**, which turned out to be clean after all: main sets
  `FONTCONFIG_FILE` before `app.whenReady()` to a copy of `/etc/fonts/fonts.conf` whose
  `<cachedir>`s are replaced by `~/.cache/roost/fontconfig` (`apps/desktop/main/src/fonts.ts`).
  Adding a private directory *beside* the shared one was tried first and does nothing — the
  newer file is refused wherever it is found. Replacing them leaves every font, alias and
  `conf.d` rule the system's: six families measured to the same width as a clean cache. What the
  window launches inherits the variable and gets the same configuration, cached in Roost's
  directory. With the 73 files still in place, `check-about.mjs` passed where it had crashed.


## 3. To build — the working list

### Foundation (M0) — done 2026-08-24

- ☑ ~~The renderer import-restriction lint rule.~~ In place, and **verified by violating it**: a
  throwaway file importing `node:fs` and `@roost/core` was written, watched to fail, and deleted.
  Reading the config would not have proved anything.

- ☑ ~~The CSS token check.~~ In place before the first component, with unit tests and an
  end-to-end check in both directions. Comments are stripped before the scan, or the comment
  explaining the bug would report itself.

- ☑ ~~An `.editorconfig`.~~

### Importing an Eagle library (ADR-0032) — built 2026-09-06

- ☑ ~~**Folders map to folders — tried the other way, and withdrawn.**~~ The user asked twice for
  Eagle's folders to become tags, on the premise that Roost has none; it has them (`Sidebar.tsx`
  draws the section, `roost folder list` prints the tree), which was said both times, and the
  conversion was built anyway because how somebody organises their own library is not the
  application's call. It lasted one import: seeing it against their own data — `majorette` was a
  folder *and* a tag, so one tag ended up carrying 3 + 2 assets with no way to separate them — they
  withdrew it. ADR-0032 §3.1 keeps the measurements so the next person to propose it starts from
  them rather than from scratch. One finding survives the revert: `tag:Design/Icons` parses and
  names exactly one tag, so the `/` rule really is a folder-name rule.

- ☑ ~~**`roost import --from-eagle <DIR>`, with `--dry-run`.**~~ `packages/library/src/eagle.ts`:
  the root `metadata.json` for the folder tree and the tag groups, a streamed walk of
  `images/<id>.info/`, then two phases per chunk of 200 — the ordinary import pipeline for the
  bytes, then one `apply()` batch for the metadata, because an op naming an asset the index does
  not hold yet is a foreign-key violation. **No journal op, no migration, no schema change.** The
  pipeline gained exactly one thing: `ImportOptions.onAsset`, which reports the hash of every file
  that resolved — *including a duplicate*, since a file the library already holds is still that
  item's asset and a hook that skipped it would drop the metadata of every repeat.

- ☑ ~~**Idempotent, and tested as such.**~~ Folders and tag groups are looked up before they are
  created, and a comment is matched on the same words at the same moment on the same asset —
  `comment_add` mints an id, so it is the one operation here that is neither set membership nor
  last-write-wins, and a second run would otherwise duplicate every comment. Proved on the user's
  own library: the second run writes 0 files, 0 folders, 0 comments.

- ☑ ~~**Proved against a real Eagle 4.0.0 library**~~ (14 items, 1.0 GiB, the user's own): 14
  assets, 2 folders, 4 tags, 1 rating, 4 notes, 2 URLs, 6 comments at the right milliseconds
  (726.211598 s → 726212 ms), 1 subtitle attached from a sibling no metadata mentions, and 15
  distinct `created_at` values against 1 `imported_at` — which is exactly the `btime` loss §7
  describes, visible in the index.

- ☑ ~~**A door in the window.**~~ Built 2026-09-06 at the user's request. **Import from Eagle…**
  in the Add menu — an import, so it sits with the other two rather than in the `☰`, and it carries
  no accelerator because the obvious pair is taken and a third would be arbitrary. Its chooser takes
  **one** directory where the others take several. The survey is `UI_SPEC.md` §3.8: what the library
  holds, what will not come across, the folders that will be renamed, and how many items will be
  skipped — every block omitting what does not apply, because "0 comments" is a sentence about
  something the user does not use. Two requests (`eagle:survey`, `eagle:import`) and one chooser
  (`dialog:chooseEagle`, answered by main).

- ☑ ~~**The progress line said the queue's size, not the work's.**~~ Reported by the user —
  *"kok tidak ada tampilan progress nya ya?"* — and it was two defects, both measured against a
  running window rather than argued about. **The Eagle import reported once per chunk of 200**, so a
  library of fourteen items got its first progress event *after* everything was imported: two events
  in total, the first already reading 14 of 14. It now reports per item, from `onAsset`, counting
  originals only so a subtitle does not run the count past the survey's total — fifteen events for
  the same library. **And the path import throttled on `scanned`**, which is what the walk has
  *found*: it drains five hundred paths before hashing any of them, so a 3,000-file import emitted
  six events during its import phase and every one was a multiple of five hundred. It now throttles
  on what has finished, and the line reads *done of total* — the total being a fact for an Eagle
  import and the walk's running discovery otherwise. **Both are now asserted**, which needed
  `FakeEngine.hold`: every fake reply used to resolve in the microtask that started it, so the
  running state was mounted and unmounted before a render, and the test named *"shows progress while
  it runs"* checked only the outcome.

- ☑ ~~**`ImportProgress` gained a nullable `total`.**~~ An Eagle import counted its items before it
  began, so its status line says *3 of 14*; a directory walk cannot, sends `null`, and says how many
  it has scanned. Nullable rather than a sixth count: an unknown total and a total of zero are
  different things and only one of them is a number.

- ☑ ~~**`scripts/check-eagle.mjs`**~~ — 27 claims against a **running window**, with a real preload,
  main, engine, and Eagle library on disk. The one step it cannot drive is the native directory
  chooser, which belongs to the desktop; the menu item is asserted and the path handed to the page
  after that. It caught two things a component test could not: Radix opens on `pointerdown`, so a
  dispatched `click()` leaves the menu shut, and the first fixture shared `imageLibrary`'s gradients
  so every import deduplicated against the destination and proved the opposite of what it meant to.

### HEIC photographs (ADR-0040, 2026-09-10)

- ☑ ~~**A HEIC used to be handed to ffmpeg as if it were a video.**~~ A HEIF is ISO base media, so
  the sniffer's `ftyp` branch fell through to `mp4`; from the extension it was `unknown`, so the
  grid called it `other`. It was neither an image nor a video to Roost. `heic` is now a format with
  `kind: image`, sniffed from the ten major brands a camera writes, with `.heic`/`.heif`/`.hif`
  mapped from the extension. **The AVIF test runs first**, because AVIF carries the generic `mif1`
  brand too.

- ☑ ~~**The decoder is the system's libheif, never Roost's.**~~ HEVC is patent-encumbered and Roost
  is a proprietary binary (ADR-0038): a bundled decoder is a licensing question, not a packaging
  one. Nor is sharp a way round it: on Linux it is built against the system's libvips, and libheif
  refuses a 48-tile photograph on its own security limits even with the HEVC plugin present.
  A fifth capability, `heif`, through `heif-dec` — 0.19 s per photograph to JPEG, tiles
  assembled and rotation applied. **PNG output costs 1.35 s**, which is the whole reason the
  intermediate is a JPEG.

- ☑ ~~**A version is not a capability.**~~ Fedora ships `libheif-tools` in its own repositories and
  the HEVC plugin in none of them, so `heif-dec` installs, runs, reports 1.21.2, and refuses every
  photograph. The probe reads `--list-decoders` and wants a non-empty `HEIC decoders:` section.

- ☑ ~~**`refreshCapabilities()` was never called anywhere.**~~ `capability.ts` has claimed since M4
  that it is "the UI's try again"; nothing called it, so *install the tool, then press Try again*
  could not work in a running window — for ffmpeg either. `derive:retry` probes again first.

- ☑ ~~**A parked reason can outlive the build that wrote it.**~~ `unsupported:heic` is a fact about
  a build. Nothing in the window could release it — the capability retry matches `missing:`, and an
  unsupported format has nothing to install — so every HEIC already in a library would have stayed
  parked forever. `releaseNowSupported()` runs when a library opens.

- ☑ ~~**The preview pane could never show a HEIC, a RAW, or a TIFF.**~~ Older than this work: the
  pane loads the file's own bytes into an `<img>` and Chromium decodes none of the three, so all
  three opened as a thumbnail in the grid and a blank pane after it. `roost://render/<hash>` serves
  a rendition at full size — measured in a real window at 3024×4032 — and a rendition that cannot
  be made steps down to the thumbnail rather than to a broken-image glyph.

- ☑ ~~**The numbers are in `BENCHMARKS.md`, and the path has a window check.**~~ Both were the gap
  between "it works" and "it is guarded": `bench-derive.ts` now measures HEIC beside the other
  backends, and `check-heic.mjs` drives a real window twice — once with libheif, once with
  `ROOST_HEIF_DEC` pointed at nothing, which is the only way the parked state and its install line
  are ever exercised on a machine that has the decoder. It **skips loudly** where libheif is
  absent, because a check that quietly passed without it would assert nothing.

### What could not be drawn (2026-09-10)

- ☑ ~~**"36 could not be drawn" opens a list instead of retrying.**~~ Asked for from the user's own
  library: *"ada keterangan 36 could not be drawn. apakah bisa buat lebih informatif?"* The number
  was true and useless — which files, what fault, and whether a retry would change anything were all
  unanswered, and the button's only offer was to run the same failures past the same backends again.
  `UI_SPEC.md` §3.13. `derive:failures` reads every failed row and groups it; the dialog draws a row
  per fault with the files named under it, `Copy list`, and `Try again`. New: `repo.failedJobs`,
  `deriveFailures`/`normaliseReason` in `@roost/library`, `WireDeriveFailures`,
  `DeriveFailures.tsx`, `deriveReason.ts`, `scripts/check-failures.mjs`. 23 more tests, 1223 in the
  workspace.

- ☑ ~~**The grouping normalises the message, or thirty-six videos are thirty-six groups.**~~ Every
  backend that shells out names the file it was handed, so `GROUP BY reason` over one fault returns
  one row per file. Paths and content hashes are elided; **numbers are kept**, because an exit code
  is what such a message is about — `exited with 137` is a kill and `exited with 1` is a refusal.

- ☑ ~~**Try again no longer declines silently after three attempts.**~~ `requeueFailed` caps at
  three tries, which is right for the sweep that offers work again on its own and wrong for a button
  somebody just pressed: a library whose failures had been retried three times had a *Try again*
  that did nothing and said nothing. A retry that came from a person is now uncapped, and the group
  says how many times it has already been tried so the button is a known quantity.

- ☑ ~~**The blocked line now opens the same list.**~~ Written the same day as a *"whenever"* and
  answered by the user's own library within hours: `19 without a preview` and no way to learn which
  nineteen — they had to ask. `derive:failures` takes a state, both lines are buttons, and a group
  parked on a missing backend carries the command that would supply it with its own **Try again**.
  A group parked on `unsupported:` still gets no button, because nothing arriving would change it.

### Chrome the pictures have to live with (2026-09-07)

- ☑ ~~**The scrollbar is drawn rather than inherited.**~~ `UI_SPEC.md` §2.5. Chromium's own was a
  15px bar with a stepper at each end, and the one widget in the window that ignored `data-theme`.
  A transparent track and a rounded pill inset by a transparent border, `--gray-7` at rest in both
  themes because it is the one step that clears §2's 3:1 floor against both ends of the ramp.
  Guarded indirectly — a scrollbar has no computed style to read, so `check-grid.mjs` asserts the
  strip is the width `--scrollbar-size` asks for.

- ☑ ~~**The grid's frame stopped drawing a second focus ring.**~~ Asked about from a screenshot:
  *"kotak hijau ini apa ya kok sering muncul"*. It was `.grid:focus-visible` — correct, and
  redundant the moment a cell carries the roving ring. `:focus-visible` holds once an arrow key has
  been used and does not fall away on the next click inside the same element, so the box stayed for
  as long as the keyboard was in the grid. `data-roving` is written beside `aria-activedescendant`,
  so the frame draws its ring only while nothing inside it is focused.

### Handing a file to another application (ADR-0034, 2026-09-07)

- ☑ ~~**Copy file(s) to the clipboard.**~~ `Copy file` / `Copy N files` in the asset menu, beside
  `Copy path` — which stays, because a path is what a terminal wants and a file manager ignores it.

- ☑ ~~**A `staging/` directory inside the library.**~~ A **layout change** to `STORAGE_SPEC.md`, the
  second this repository has made, approved by the user when they asked for this. Inside the library
  rather than `/tmp` because a reflink works only within one filesystem. Reflink, then copy, and
  **never a hardlink**: a shared inode would let another application write into the original.
  Emptied when a library **opens**, since a clipboard reference outlives the session that wrote it.

- ☑ ~~**`reflinkSupported()` finally matters.**~~ It has existed since M1 with no caller. It is what
  decides whether a correct filename is free (btrfs, XFS) or costs the whole file (ext4, NTFS).

### The folder tree in the sidebar (ADR-0033, 2026-09-06)

- ☑ ~~**The sidebar was not drawing a tree.**~~ Found in the user's own screenshot: twenty folders
  in one column, four of them called `highlights`, at three depths and none of them under its
  parent. `repo.folders()` orders by `sort_order` then name, nothing sets `sort_order`, and the
  window indented that alphabetical run by depth — so a child was drawn under whatever sorted above
  it. `readSidebar` now returns the rows **depth-first** (`orderTree`), which is also what makes
  collapsing possible with no parent id on the wire. The CLI never had the bug: `roost folder list`
  walks the tree.

- ☑ ~~**Expand and collapse, and every branch starts closed.**~~ A closed branch hides nothing that
  matters, because a folder's count is its subtree's.

- ☑ ~~**The tree is editable from the pane.**~~ `+` in the heading, and right-click for **New
  subfolder…**, **Rename…**, **Delete folder…**. The heading is drawn even when the section is
  empty — a new library with no folders and no way to make one was a dead end.

- ☑ ~~**Deleting a folder asks what to do with its contents.**~~ One checkbox: unticked the assets
  stay in the library unfiled, ticked they go to the **trash** in the same journal batch.
  `ConfirmDialog` grew an optional `option` for it, and `roost folder delete --trash-contents` is
  the CLI's half.

- ☑ ~~**Driven against a real window.**~~ `scripts/check-folders.mjs`, 43 claims, on the shared
  harness. It found two things nothing else could, both on its first run: **renaming a folder
  sprang its branch open**, because `onDone` revealed the folder it had just renamed; and
  **`Ctrl+Delete` left the asset on screen** — the status bar said it was gone, the count agreed,
  and the grid went on showing it. And one thing about the check itself, which is the same lesson
  in a different place: the first version measured the *branch's* left edge to prove indentation,
  which never moves — the indent is padding, so what moves is the name. It passed against a pane
  with no indentation at all.

- ☑ ~~**Drag: assets onto a folder, and a folder onto a folder.**~~ Built 2026-09-07 (ADR-0033 §5),
  at the user's word. A drop from inside a folder **moves** and from anywhere else **adds**, because
  a folder is a collection and there is nothing to leave unless one is on screen; `Ctrl` forces the
  add. A folder dropped on another re-parents, on the heading goes to the top level, and a move into
  its own subtree is refused **visibly**. No journal op, no migration, no schema change — the third
  change running.

### The folders an asset is in (2026-09-06)

- ☑ ~~**The window can file an asset and unfile it.**~~ Asked for by the user — *"untuk file yang
  sudah tertaut ke folder, apakah memungkinkan ada opsi untuk melepas dari folder? kalau di eagle
  ada tombol itu di inspector"* — and the honest answer was that it could not do either. The ops
  (`folder_add`, `folder_remove`), the library functions, and `roost folder` had all been there
  since M2; what was missing was every layer above them. No journal op, no migration, and no schema
  change: `FolderEditor` in the inspector, `asset:folderAdd` / `asset:folderRemove` on the wire, and
  `Ctrl+Delete` finally bound to what `UI_SPEC.md` §9 had promised since M3.

- ☑ ~~**A membership crosses as an id *and* a path.**~~ `WireAssetDetail.folders` was a list of
  bare folder **names** while its own doc comment claimed they were paths — a nested folder read
  `Icons` with no way to tell which one, and nothing could name a folder to edit it. It is now
  `{ id, path }`, walked to the root by one recursive CTE in `repo.ts` seeded twice (one asset's
  memberships, and a selection's), and `SelectionSummary` gained the shared/partial split the tags
  already had.

- ☑ ~~**`Ctrl+Delete` does nothing outside a folder.**~~ Deliberate: there is no folder to name,
  and guessing at the first one an asset happens to be in is a removal nobody asked for.

### Running it from a checkout (2026-09-08)

- ☑ ~~**A desktop entry, and one command that brings a checkout up to date.**~~
  `scripts/install-launcher.mjs` writes `roost.desktop` pointing at the built output by absolute
  path — a desktop entry is not started from a login shell and cannot be assumed to have one on
  `PATH` — and `pnpm refresh` is `git pull --ff-only`, install, build. Documented in `SETUP.md` §4
  and in the README, which had no install instructions at all. The entry deliberately never builds:
  a menu click that ran `tsc -b` first would have nowhere to print the error. Superseded by
  packaging when M6 arrives, and not a substitute for it.

### Engine (M1)

- ☑ ~~**A journal file not named `YYYY-MM.jsonl` is invisible to replay.**~~ `roost doctor`
  reports them, and treats them as a reason to refuse `--reclaim`: a month replay cannot see is a
  month the index does not hold, which makes every asset in it look like an orphan. Named by
  `strayFilesIn`, next to `monthsIn`, so that "a journal file" has one definition rather than
  two that drift.

- ☑ ~~**The importer records the *last* extension component, lowercased, without the dot.**~~
  Verified against the Rust implementation, which stores `b.tar.gz` as `<hash>.gz` and a file
  with no extension as a bare `<hash>` with no trailing dot. Getting this wrong puts one asset
  at two addresses across the two implementations, and the object store cannot catch it —
  storage is handed the extension, it does not choose it. The fixture at
  `packages/core/src/storage/__fixtures__/rust-written-library` pinned the layout; the import
  pipeline now pins the *choice*, with a test that imports `archive.tar.gz`, `PHOTO.PNG`, and a
  file called `README` and asserts the three extensions land as `gz`, `png`, and the empty
  string — and that nothing on disk ends in a dot.

- ☑ ~~**Check `better-sqlite3` and `sharp` the way the hashing binding was checked.**~~ Two of
  three done 2026-08-24. `better-sqlite3` 13.0.3 is Node-API (`NAPI_VERSION=10`, prebuilds named
  by platform with no ABI number) and the **same installed binary loaded under Node 22.23.1
  (ABI 127) and Electron 43.4.1 (ABI 148)**, FTS5 present in both. **`sharp` failed**: it loads
  under Electron and segfaults on the first decode, because its bundled GLib collides with the
  one Electron links (ADR-0013). The probe now decodes and encodes rather than calling
  `require`, which is the only reason this was caught before M3.

- ☑ ~~**The per-platform native CI job.**~~ Landed 2026-08-24 with the second native module, on
  Linux, macOS, and Windows. It runs natively per platform rather than cross-compiling, for the
  reason §4.7 gives, and it is the one job that downloads Electron — probing under one ABI proves
  nothing about the other.

- ☑ ~~**A digest fixture from the Rust implementation.**~~ Done 2026-08-24, and it earned its
  keep immediately: flipping the size prefix to big-endian produces a different, entirely
  self-consistent set of digests, and only the cross-implementation expectations catch it. Six
  fixtures, both sides of the 50 MiB boundary, generator committed at
  `packages/media/src/testing/hash-fixtures.ts`.

- ☑ ~~**A fixture library written by `roost-old`**, committed, for the cross-implementation
  test.~~ Answered better than asked. The three committed fixtures pin the object store, the
  journal, and the index in the reading direction. The writing direction — which no fixture can
  test — is `packages/library/tests/interop.test.ts`: it builds a library here and has the Rust
  binary read its counts, replay its journal into a matching index, and run `doctor` over it.
  **That test skips where `../roost-old` is not built, which includes CI.** It is the only check
  in the repository that does, and it is worth knowing that a green CI run has not proved this.

- ☑ ~~Decide how integer columns are read.~~ Settled 2026-08-24, and the premise was wrong:
  `better-sqlite3` does **not** return `bigint` past 2^53, it silently rounds. `DATA_MODEL.md` §4
  carries the measurement and the decision — read `number`, and rely on no column in this schema
  being able to approach the boundary.

- ☑ ~~Journal `fsync` policy: per batch during import.~~ One flush and one transaction per
  window of 500. The ordering has a test now: the journal append is stubbed to fail and the index
  is asserted empty, which only holds if the journal really does go first.

- ☑ ~~**The CLI should report sizes in MiB.**~~ It does, and says MiB rather than MB. Unit-tested
  on exact strings, because a test that only checks the label passes either way.

- ☑ ~~**The M2 organize reads are deliberately absent from `Repo`.**~~ Added in M2 with the
  commands that need them: `folders`, `findFolderByPath`, `folderIsWithin`, `folderCounts`,
  `tags`, `tagGroups`, `findTagGroupByName`, `smartFolders`, `findSmartFolderByName`.

- ☑ ~~**ADR-0013 needs a decision before M3.**~~ Accepted 2026-08-25: build `sharp` from source
  against the platform's libvips on Linux, keep the prebuilt on macOS and Windows, WASM as a
  documented 6x-slower fallback. What it leaves behind is M6 work, below.

- ☑ ~~**The Linux app build must compile `sharp` from source** (ADR-0013).~~ Done 2026-08-27:
  `scripts/build-sharp.mjs`, wired to the root `postinstall` because `pnpm install` deletes the
  build. `probe-native --both` now passes under Electron. The prebuilt `@img/*` packages did
  **not** have to be removed — sharp tries the source build first — but that makes a missing
  source build a silent fallback rather than an error, so the build script, `decoderVersions()`,
  and a test each assert which binary actually loaded. ADR-0013 has the correction.

- ☑ ~~**`roost doctor` should report which sharp build is loaded.**~~ It prints the `sharp` and
  `libvips` versions on every run, shallow or deep, and since 2026-08-27 the word that the
  versions cannot carry: `source`, `prebuilt`, or `unknown`, read from the loaded shared objects.

- ☑ ~~**SVG is deliberately not rendered.**~~ Resolved 2026-08-29 by ADR-0015: resvg in
  WebAssembly, which has no filesystem to follow a reference into. Measuring the options
  corrected half of what this item claimed — the **native** resvg binding reads a neighbouring
  file with default options, and librsvg 2.62.3 did **not** fetch a remote URL. The local read
  is real and is enough on its own; the network half was removed from `decoder.ts` and
  `ARCHITECTURE.md` §3.3 in the same change.

### Search and organize (M2)

- ☑ ~~Extract the query corpus from `roost-old`'s parser tests before starting.~~ Done first,
  and it earned it: the corpus is now `packages/search/src/query.test.ts`, and two of its cases
  are behaviours nobody would think to write down — a bare duration means *seconds*, and `<=` on
  a date means the end of that day rather than its start.

- ☑ ~~`doctor --reclaim` must refuse when the index and the object store disagree.~~ It does, and
  both halves of the rule have a test: a missing object blocks the reclaim, and a moved
  *referenced* original does not — that one says the user moved their own file, and counting it
  would block reclaiming forever, since no rebuild returns a file someone meant to delete.

- ☑ ~~**Notes are not searchable at all, and `CONCEPT.md` §5.1 lists them as an M.**~~ Fixed
  2026-09-05 by ADR-0027: migration 0012 gives `assets_fts` a `note` column and a `comments` one,
  and free text searches all four. Found on 2026-09-01 while drafting ADR-0023, which refused to
  give comments a search path before notes had one — a library where the comments are findable and
  the notes are not is worse than one where neither is; in the end they arrived together. **Folder
  names are the other half of the parity line and are still not searchable**: `folder:Icons` finds
  a folder by name, but typing `icons` does not. A fifth column would cost a refresh on every
  folder rename and every membership change, which is why it was not taken with the other two —
  it wants measuring first.

### Shell and UI (M3)

- ☑ ~~The frontend test harness goes in **before** the components, not after.~~ In place with
  the first screen it covers: `vitest` with two projects so only the renderer gets a DOM, a fake
  `window.roost` installed at the same seam the real one occupies, and thirteen tests driving the
  picker and the creator the way a person does. Verified by breaking three things and watching
  the right tests fail.

- ☑ ~~Sandbox assertions as tests, not as configuration reviewed once.~~ `check-sandbox.mjs`,
  2026-08-28: sixteen checks against a running window, including the CSP header Electron
  actually served rather than the one `security.ts` computes. Two of the first three checks
  written turned out to be wrong about the *measurement* rather than about the sandbox — `eval`
  cannot be tested over CDP because DevTools is exempt from the page's policy, and `<webview>`
  is a tag Chromium knows, so what `webviewTag: false` withholds is the API and not the
  element. Verified by weakening three settings and watching four checks fail.

- ☑ ~~A short `Cache-Control` on the thumbnail 404.~~ `public, max-age=10`, added with the
  protocol on 2026-08-27: long enough to absorb a scroll back over a folder of videos, short
  enough not to outlive an import generating thumbnails while someone watches.

- ☑ ~~**A folder name containing `/` made its own path ambiguous.**~~ Found on 2026-08-27 by
  driving the real window: a top-level folder literally named `Design/Icons` and an `Icons`
  inside `Design` both compile to `folder:"Design/Icons"`, so the sidebar highlighted the wrong
  row and neither folder was reliably addressable from the CLI. Rejected now where a name is
  *authored* — replay still accepts one, because a library written before the rule must still
  rebuild.

- ☑ ~~**A sidebar click left the preview open over the answer.**~~ **Fixed 2026-09-08**, reported by
  the user: with a picture or a film open, clicking a folder in the pane changed the query behind it
  and left the pane standing, drawing an asset the new result does not hold — and with the grid's
  head replaced by the preview's, `Escape` was the only way back. The cause was one line older than
  the preview: `applyQuery` cleared the *selection* and `SelectionStore.clear()` deliberately leaves
  the focus alone, so `focused` survived the query and `previewing && focused !== undefined` stayed
  true. `reset()` is now the store's second gesture — the selection, the anchor **and** the ring —
  and `applyQuery` calls it and closes the preview. The stale ring was the same bug seen from the
  grid's side: `Enter` opened an asset that was not in the result. 3 more tests.

- ☑ ~~**Empty trash from the sidebar's Trash row.**~~ **Built 2026-09-08**, at the user's request
  with a screenshot: the command existed since ADR-0022 and lived in the grid's context menu only,
  so reaching it meant standing in the Trash place first. It is now on the row that carries the
  count, as the same item with the same confirmation. Drawn dead while the count is zero rather than
  coming and going. 4 more tests.

- ☑ ~~**An edit applies to the focused asset, not to the selection.**~~ Fixed 2026-08-30. The
  inspector takes the selection; `Rating`, the favourite button and `TagEditor` take a list of
  hashes and never learn how long it is, so one asset and several are the same components. The
  design `UI_SPEC.md` §3 owed is now §3.2. A new `asset:summary` request answers with the
  aggregate — shared and partial tags, a shared rating or `mixed`, all/none/mixed favourites —
  in one round trip rather than a detail per asset.
  - The regression tests **count the hashes that were sent**, because the broken version passed
    everything that only asked whether the tag arrived. Verified by breaking both halves and
    watching the right test fail.
  - A test also corrected a comment: there is no rated-zero to distinguish from unrated, because
    the schema is `rating BETWEEN 1 AND 5`. What makes `rated === count` necessary is that `min`
    and `max` skip NULLs, so two fours and an unrated asset would agree on 4.

- ☑ ~~**The preview fits the pane and stops there.**~~ It zooms from 2026-09-07, asked for as
  *"jika view foto. tambahkan untuk zoom in atau zoom out"* and then *"terus bisa pakai scroll
  untuk zoom in atau out nya"* — so it arrived as more than the 1:1 toggle §7 had been asking for:
  the wheel about the pointer, `−`/`+` and a readout at the foot of the pane, `+`/`-` from the
  keyboard, click to toggle 1:1, and a drag that pans and cannot take the picture off the pane.
  A transform and a gesture, exactly as this line said, and no new request.
  - **The fit is a state, not a number.** Held as `null` until somebody zooms, so a wider window
    re-fits rather than keeping the size the old pane wanted.
  - **The picture is transparent until it has been both loaded and measured.** The natural size and
    the pane's size arrive independently, and a picture drawn between them is drawn against a box
    of nothing — a flash of 1:1 before it settles to the fit, seen in a real window at 1600px in a
    pane 736 wide.
  - **React's `onWheel` is passive**, so `preventDefault` inside it does nothing. The listener is
    subscribed by hand, once, and reads the latest state out of refs: re-subscribing on every zoom
    would be swapping the listener in the middle of the gesture that is causing it.
  - `scripts/check-preview.mjs` is the guard, because every number here comes from layout — the
    fit, the point under the pointer, the clamp — and happy-dom computes none of it.

- ☑ ~~**Video range requests are still unexercised by a `<video>`.**~~ Exercised 2026-09-02: a
  real clip played and seeked twice from the comment strip, over `roost://original`, in a window.
  The unit tests had both directions of the range parser; what they could not have is a decoder
  asking for the middle of a file and getting it.

- ☑ ~~**How the grid paints selection has no automated guard.**~~ It has one from 2026-09-03:
  `scripts/check-grid.mjs`, on the shared harness the six findings below were all waiting for.
  Fixed on 2026-09-01 after two reports, one per shape. Icons drew a ring on the picture and a
  fill on the caption, with the 4px seam between them showing page background — two marks with a
  gap; the cell carries both now, so a selected icon is one card. And Compact and Details drew
  the Icons treatment — a filled pill on the label, a ring on a 40px thumbnail, and an outline
  around the whole row — where a filled row was wanted. Reading the CSS to fix it turned up a
  second defect nothing could have caught: `.grid[data-view] .cell:hover` outranks
  `.cell[data-view][data-selected]`, so **hovering a selected row erased its fill**. Neither is
  reachable from a component test — happy-dom loads no stylesheet, so the cascade is not there to
  get wrong.
  - **The hover half needed a real pointer, not a real window.** `:hover` never matches for a
    dispatched `PointerEvent` — the browser does not consider a synthetic pointer a pointer — so
    the claim could not be made from a page expression at all, however real the window was around
    it. The harness dispatches through CDP `Input`, which is also what makes `setPointerCapture`
    stop throwing: the same cause behind the sweep that died on its first frame, recorded below.
  - **The marquee was the fifth thing waiting on it** (2026-09-01) and the transport the sixth
    (2026-09-02) — the last of which had to build a library with a real video in it, which is one
    more thing the harness now owns. A twelve-check version of the marquee script was written and
    passed three times against a real window in September, then not landed, because landing it
    was the fourth copy of the CDP plumbing. What it found is the argument the harness was built
    on: **`setPointerCapture` throws for any pointer the browser does not consider active**, so a
    sweep begun from a dispatched event died on its first frame. Capture is best-effort in
    `Grid.tsx` either way, and the check no longer needs it to be.
  - **A third defect was in the tokens, not the rules.** `--select-border` and `--border-focus`
    resolved to the same colour in *both* themes, so "the focused one is brighter" was a claim
    nothing could see — a selected card and a selected-and-focused card differed by one pixel of
    ring width. Selection is one step calmer than focus now. Two tokens naming two roles are
    worth nothing while they hold one value, and only a measurement finds that: the stylesheet
    reads as though they differ.

### Settings, windows, and the picker (ADR-0019 and ADR-0020, decided 2026-08-30)

- ☑ ~~**`settings.json` in the library** (ADR-0019).~~ Built 2026-09-08, when ADR-0036 needed the
  first setting there was. `packages/library/src/settings.ts` is ADR-0019's three rules and nothing
  else: reads tolerate absence, damage, unknown keys and wrong types by falling back per setting;
  writes tolerate failure silently — a library on read-only media must not raise a dialog when
  somebody changes a checkbox — and unknown keys survive a write, for the same reason unknown
  journal ops are skipped rather than dropped. `Library` reads it once on open and holds it, so a
  synchronous path can ask. `dirs.ts`'s doc comment was corrected in the same change.
  - **Moved in on 2026-09-09** (ADR-0039 §7): the sort key, its direction, the shuffle seed, the
    view mode, the icon shape and the zoom — six keys, and the pattern for the rest.
  - **Still to move in**: the folder tree's expansion (below) and the default import mode. Each is
    a field and a call, now that the file exists.
  - The CLI does **not** yet read it — nothing it does has a preference — and there is no
    `roost settings`. When one of the above moves in, the two frontends have to agree (ADR-0005).

### The asset context menu (2026-08-31)

- ☑ ~~**The menu itself, on the selection.**~~ Open, Show in file manager, Copy path, Export…,
  and Move to trash, which was disabled pending ADR-0022 and is live since 2026-09-01.
  `UI_SPEC.md` §3.3 is the design of record.
  Right-clicking an asset already in the selection keeps it; right-clicking one outside makes it
  the selection — the regression test drives both, because the version that called `click()` for
  both would have passed a test that only checked the menu opened.

- ☑ ~~**Export to an external folder.**~~ `exportAssets` in `@roost/library`, over the directory
  chooser that already existed. Files land under the library's name rather than the
  content-addressed one, a collision gets a numbered suffix via `COPYFILE_EXCL` rather than
  check-then-write, and the name is `basename`d — it is user-authored, so `../escaped.png` would
  otherwise have made an export a way to write outside the chosen directory. Pinned by a test.

- ☑ ~~**Move to trash, Restore, Delete permanently, and Empty trash.**~~ Landed 2026-09-01
  (ADR-0022). Inside the Trash the reversible spelling is *replaced* rather than extended, so
  "delete" never means two things in one menu, and which one applies is decided by comparing the
  query on screen against the one the engine sent for the Trash row — the renderer still
  assembles no RQL.

- ☑ ~~**A confirmation dialog.**~~ `UI_SPEC.md` §3 had reserved `Dialog` and a `--danger-` ramp
  and neither had been built. `ConfirmDialog` is an *alert* dialog: no close button, no dismissal
  by clicking outside, focus starting on Cancel. Trashing asks nothing — it is reversible, and a
  dialog there teaches people to dismiss dialogs.

- ☑ ~~**The menu on an open preview**, over the asset on screen rather than over the selection.~~
  Added 2026-08-31 at the user's request. Distinguishing the two rules needs `Enter` rather than a
  double-click, because a double-click's own pointer-down collapses the selection first — the
  version written with `dblClick` passed with the wrong rule wired in.

### Trash (ADR-0022, decided and built 2026-09-01)

- ☑ ~~Migration 0007, the `trash` and `restore` ops, and replay.~~ The rebuild test in
  `organize.test.ts` carries both now, and it earned it: a `trash` that replayed as a no-op
  passes every other assertion in that test.

- ☑ ~~`is:trashed`, and scoping every other query to live assets.~~ Done in the compiler rather
  than threaded through the engine, the CLI, and the renderer — one place cannot forget it.

- ☑ ~~Folder and tag counts stop counting trashed assets.~~ Found while writing the sidebar
  test: a count beside a query has to be the count *of* that query.

- ☑ ~~Re-importing a trashed file restores it.~~ It journals a `restore`, never a second `add`:
  re-adding would rewrite `imported_at` and move the asset to the top of a grid it has been in
  for months.

- ☑ ~~**Nothing in the repository drives a window.**~~ Closed 2026-09-03. Five scripts drive one,
  and they share one harness rather than five copies of it (§M3 above). All five are still run by
  hand and none is in `pnpm verify`, for the reason §M3 gives — they need Electron's binary and a
  session that composites — but four of them **build their own fixture**, so the missing piece is
  a machine, not a library to point them at.

- ☑ ~~**A window check could not run while Roost was open.**~~ Found and fixed 2026-09-05. It read
  as a flake — "no page target after 20s", then a clean pass on the next run — and the cause was
  neither the port nor a race: `main.ts` takes `requestSingleInstanceLock()`, that lock is scoped
  to the user-data directory, and every driven window used the application's own. So a Roost open
  on the desktop made the check's Electron `app.quit()` before it built a window, leaving a
  debugger port with nothing behind it, and raised the developer's window instead. `launch()` now
  passes a `--user-data-dir` of the checks' own. Fixed rather than per-run, so `bench-window.mjs`
  still measures cold start from a warm code cache.

- ☑ ~~**An empty Trash reported a failed search.**~~ It said "Nothing matches this query.",
  which reads as a query that did not work rather than as a trash with nothing in it.
  `UI_SPEC.md` §8 carries the state now.

- ☑ ~~**The inspector vanished on an empty selection, and the grid reflowed behind it.**~~
  Changed 2026-09-01 at the user's request, after Eagle's panel — which is always there. Measured
  first: selecting one asset took the grid from 1040px and four columns to 760px and two, and
  deselecting took it back, so every cell moved twice for every click on the background. The
  panel is drawn always now and carries §8's empty state; the spec's objection to it — that a
  shell of disabled controls looks broken rather than idle — is answered by drawing a state
  rather than controls. `UI_SPEC.md` §3 and §8 changed with it, and `check-trash.mjs` asserts
  the width.
  - **The test that guarded the old behaviour was testing something else.**
    `show({}, undefined)` selected the *default* hash, because a JavaScript default parameter
    applies to an explicit `undefined` — so "renders nothing when nothing is selected" was
    reading the first render before the detail arrived, and would have passed with no
    empty-selection logic at all. Lesson 9 again, from a third direction.

- ☑ ~~**The inspector's scrollbar moved its own content.**~~ Asked about on 2026-09-01 — the
  scrollbar at the window's right edge reads as a page scrollbar because the panel is the
  rightmost pane, and it is really the panel's own. It scrolls because a video reports nine
  derived properties where a PNG reports none. It reserves the gutter now, as the grid already
  did. Measured at a viewport where the video's panel scrolls and the image's does not: the
  panel's fields were 240px wide against 255px, jumping 15px as the selection moved, and they
  hold at 240 now.
  - **`Codec` appeared twice**, once for the video track and once for the audio, with nothing
    saying which was which. Both are qualified now: qualifying only the audio one would have
    moved the ambiguity to a file with a single track rather than removed it.

### A transport of our own (ADR-0024, decided 2026-09-02)

- ☑ ~~**Stage 1 — parity, and the marks move onto the timeline.**~~ Done 2026-09-02.
  `preview/Transport.tsx` over a `<video controls={false}>`: play/pause, a Radix slider as the
  timeline with `aria-valuetext` as a timecode, buffered ranges, elapsed/duration, volume and mute,
  fullscreen on the player's own box, picture-in-picture, and the comment marks on the timeline.
  `<audio>` gets the same component with the element hidden. `UI_SPEC.md` §7 rewritten, §3 and §9
  and §10 updated, ADR-0023 §6 amended, and `scripts/check-transport.mjs` asserts the lot against a
  running window — 26 checks, including the two controls that do not exist outside one.
  - **The way this could have failed quietly was accessibility**, and it is the reason the window
    check asserts the names, the tooltips, the tab stops and the `aria-valuetext` rather than only
    the pixels. The native bar's accessibility is free and invisible, so losing it would have cost
    nothing a test noticed.

- ☑ ~~**Stage 2 — what the native bar withholds.**~~ Done 2026-09-02. Frame stepping at 1 and 10
  frames off the probed `video.fps`, a playback rate of 0.25×–8× in a menu that says why the
  extremes are silent, and an A-B loop with a region drawn along the track. No schema, as the ADR
  said.
  - **The frame counter comes from `requestVideoFrameCallback`**, which reports the frame actually
    presented; arithmetic on `currentTime` reports where we asked to be, and a counter built on
    that lies on every long-GOP file — which is exactly the kind of file frame stepping is for.
  - **The loop's end is caught in the animation-frame sampler**, not on `timeupdate`. The event
    fires about four times a second, so a loop enforced there overshoots by up to a quarter of a
    second — audible on a short one.
  - The transport registers `,` `.` `<` `>` `I` `O` with `playhead` rather than the pane holding
    them: the frame step needs the probed rate and the loop needs two numbers, and both belong to
    the transport. The pane keeps the keys that are operations on the element alone.

- ☑ ~~**Stage 4 — set this frame as the thumbnail.**~~ Done 2026-09-02. Migration 0009 and
  `assets.poster_ms`, a `poster_set` journal op carrying `{hash, at}`, both sizes redrawn from one
  decode, `roost poster` in the CLI, and two rows in the context menu that already wraps the
  preview — drawn only over a video with a player on screen.
  - **The journal records where to look, never the pixels**, which is what keeps invariant 1
    intact: the rebuild test pins a frame and asserts the moment comes back.
  - **The thumbnail's address had to change with it.** `roost://thumb/<hash>@<size>` is served
    `immutable` for a year on the promise that a hash and a size fix the pixels, and this is the
    first thing that ever changed them. The moment rides in the query, the card and the detail
    carry it, and ADR-0008 is amended. It is also the only way an `<img>` already showing the old
    picture asks for a new one — a cache header alone would not have done it.
  - **The redraw is immediate, not queued.** One asset, a quarter of a second, and somebody is
    looking at the cell — and the new address must have bytes behind it the moment the reply lands
    or it would 404 into a cached blank. The queue still reads the same column, so a machine
    without ffmpeg catches up later, and a rebuild takes exactly that path.
  - A different ffmpeg build may land a frame away on a long-GOP file. Said out loud in the ADR
    rather than discovered in a conformance test: the instruction is the durable thing.

### Making files in the library, and editing text (asked for 2026-09-03)

- ☑ ~~**Two empty files are the same asset, and `empty.txt` and `empty.md` cannot both exist.**~~
  **Decided** by ADR-0026 §4 and **built 2026-09-04**: **(a)** below, a draft in the window, with
  Save disabled while it is empty and a line saying why rather than a button that fails when
  pressed. Kept in full because it is the
  one part of the request that could not be served as asked, and the reasoning should not have to
  be reconstructed. Not a bug to be fixed — it is what `assets.hash` being the PRIMARY KEY means, with `ext` an
  ordinary column beside it. Every empty file has one BLAKE3 hash, so "New File" twice yields one
  row, and the second extension has nowhere to live. Three ways out, and only one of them is
  cheap: **(a)** a new file is a *draft in the window*, not a row — it becomes an asset on its
  first save, when it has bytes that make it itself, which is also what makes the extension
  meaningful; **(b)** create it anyway and let dedupe answer, which means the UI has to say "you
  already have this file" about a file the user just asked for, twice; **(c)** make identity
  `(hash, ext)`, which is an edit to a binding spec, breaks a library moving between
  implementations, and is not worth an empty file. **(a) is what ADR-0026 took**, because it
  decides the same question editing does.

- ☑ ~~**Paste is four gestures wearing one name** (ADR-0026 §5).~~ **Stage 3, done 2026-09-04**,
  with **New text file** and **New file…** beside it in the menu over the grid's empty space.
  The clipboard is read in main and parsed by `apps/desktop/main/src/clipboard.ts` — pure
  functions with their own tests, which is what let two real defects be found before anybody hit
  them: GNOME's `x-special/gnome-copied-files` puts `copy` on the first line, and a bare `file://`
  resolves to `/`, which would have made a paste walk the whole filesystem. A **draft** is a name
  and a buffer with no row behind it until the first save (`asset:create`, `createAsset`), and
  saving an empty one is refused. **New file became a dialog on 2026-09-04 and lost its contents
  field on 2026-09-05**: it asks for the name and nothing else. An empty file is created, and the
  cost is reported rather than prevented — the library holds **one** empty file however many are
  made, because every empty file has the same hash, and an external editor cannot fill one in
  afterwards either, since originals are immutable and addressed by their content. **No new CLI
  verb**: pasting is `roost import` under another
  name and a named draft is `roost import` plus `roost rename`, so ADR-0005 is satisfied by verbs
  that already exist. **Original note, kept for the reasoning:** The clipboard is read in **main**, not
  the renderer — the renderer has no ambient authority (invariant 11) — and what comes back is one
  of: file URIs from a file manager (`text/uri-list`, and GNOME's `x-special/gnome-copied-files`),
  which is an ordinary import of those paths in the library's default mode; raw image bytes from a
  screenshot tool, which is an import with **no filename**, and `orig_name` is `NOT NULL`, so the
  name is invented and the invention needs to be written down rather than chosen in a hurry; or
  text, which is the same path as New Text File. A **URL** is the fourth, and it is the one
  exception invariant 7 grants — *explicitly user-initiated* import from a URL. Pasting a link is
  arguably that and arguably not, so Paste must not silently fetch: the menu item says what it
  will do, or it does nothing and a separate **Import from URL…** does.

- ☑ ~~**`text` joins `KINDS`, and the preview reads a text asset.**~~ **Built 2026-09-03 and
  withdrawn 2026-09-04**, at the user's word after using it: an external editor is enough, and
  showing a text file in the pane means owning an editor to go with it. There is no `text` kind,
  no viewer, no editor, and no `asset:save` request. `roost save` keeps the capability in the CLI.
  **The sniffing work is gone with it**, and the two notes below are kept because they are the
  reasons it was shaped that way and would be the reasons again if it ever came back.

  *Original entry:* Done 2026-09-03 — **ADR-0026 stage 1**, which needed no
  schema change and is what makes a subtitle readable at all. `text` is in `KINDS` and in
  `ASSET_KINDS`, sniffed as a **negative test** (no NUL, no stray C0 control, no DEL) placed after
  every signature including SVG's, with an extension allowlist for the serving path. The preview
  reads the bytes over `roost://original/<hash>` as a **2 MB range** — a library holds anything,
  and a hundred-megabyte log decoded into one string on the thread drawing the window is a frozen
  window — decodes them itself, names the encoding, and says when it is showing only the start.
  Read-only, because a save is stage 2. `UI_SPEC.md` §7 carries it.
  - **The truncated window changed the decoder's shape**, and a test found it rather than a
    reviewer. `TextDecoder`'s `stream: true` holds back a character cut in half at the end of a
    range — necessary, or a range read would send a good UTF-8 file down the legacy path on
    nothing but where the read stopped. On a *complete* file that same tolerance is wrong: a
    trailing byte that opens a sequence and never closes it is exactly how Windows-1252 announces
    itself, and holding it back reads `Café` as `Caf` and calls it UTF-8. The caller says which it
    has.
  - **Two tests were changed rather than made to pass.** `sniff("abc")` was `unknown` and is now
    `text`; a three-byte file that is printable *is* text. The case they were really guarding —
    a short file with no signature — is now spelled with a NUL in it, which is what makes it
    binary.
  - **It can be fooled, and cheaply.** A headerless binary whose first bytes happen to be printable
    previews as text rather than offering **Open externally**. Every binary format Roost knows is
    claimed by a signature before the negative test is reached, so the exposure is formats nothing
    here recognises — and the cost is a preview, not a wrong thumbnail or a wrong media type.

- ☑ ~~**Encoding is not a detail, and getting it wrong corrupts on save.**~~ Detected and named as
  of stage 1: a byte-order mark is believed, valid UTF-8 is read as UTF-8, and anything else is
  Windows-1252 and labelled *detected*. **The writing half is stage 2's and this is still the line
  that governs it** — reading a CP1252 subtitle as UTF-8 gives mojibake, and *writing it back* as
  UTF-8 makes the mojibake permanent in a new asset. Convert deliberately, never silently.

- ☑ ~~**The editor is a `<textarea>` first.**~~ **Stage 2, done 2026-09-03; the editor withdrawn
  2026-09-04.** Everything below the window stands — migration 0010, the `supersede` op,
  `saveEdit`, `is:superseded`, `roost save` — and the migration could not have been withdrawn
  anyway: a library at schema v10 refuses a build that knows only v9. *Original entry:* Migration 0010, the
  `supersede` op, `saveEdit` with its carry-over, `is:superseded`, `roost save`, the
  `asset:save` request, and the editor itself — a textarea in the reader's own box, so pressing
  **Edit** moves nothing but the words becoming typeable. `Escape` abandons the edit before it
  closes the preview; `Ctrl+S` saves. **No dependency**: a code editor component is a large
  package for a feature whose first two users are a `.txt` note and a subtitle file, and if
  syntax highlighting is ever wanted that is a measured decision with a bundle number attached,
  the way ADR-0024 §*How stage 1 was built* did it.
  - **The migration took 0010, not 0011.** ADR-0025 had named 0010 for subtitles, but the number
    goes to whatever is built: the runner applies only versions higher than the library's, so a
    reserved gap is a migration that can never run. Subtitles take 0011.
  - **Half the scope loses the partial indexes**, and `repo.test.ts` now says so out loud. The
    five grid indexes are partial on `trashed_at IS NULL AND superseded_by IS NULL`; a query
    carrying only the first term scans. That is why the predicate is written in exactly one
    place — a table in `@roost/search`'s compiler, mirrored by `MATCH_LIVE` — and why the test
    asserts the failure rather than only the success.
  - **A comment is copied to the new version, not moved.** The old version is still a row somebody
    can open and keeps its own, so the copies are new rows whose `created_at` is the save. Said
    here because it is a cost, not an oversight.

- ☑ ~~**A referenced asset cannot be edited in place.**~~ Read-only as of stage 2, with the reason
  on screen rather than a missing button — along with three more refusals that are each a rule and
  not a preference: a **truncated** read (saving a partial view over a whole file is the one way
  this could destroy bytes), a **trashed** asset (superseding it would make editing a way of
  undeleting), and an **older version** (a save would branch a chain meant to be a line).

### The view menu (ADR-0018, decided 2026-08-30)

Accepted on 2026-08-30, and the work splits in three. Only the first is one sitting.

- ☑ ~~**The menu itself: Icons, Compact, Details, and Zoom.**~~ Built 2026-08-30 on Radix.
  `Ctrl+1..3` select the views from anywhere in the window, guarded so a keystroke meant for a
  text field is never eaten. Details needed no engine work, as costed. Two things learned while
  building it, both now in `UI_SPEC.md` §6: **Compact wraps vertically**, not sideways as a file
  manager does, because two scroll axes in one window is jarring and the culling, prefetch and
  roving ring are all written against `y`; and the **details header sits outside the scroller**,
  because cells are positioned from `y = 0` and a sticky row would cover the first of them.
  - **Radix hides the rest of the page from the accessibility tree while a menu is open.** A
    test that reads the grid after clicking a menu item has to close the menu first. Worth
    knowing before the next menu is written.
  - The zoom controls are real `DropdownMenu.Item`s under `asChild`: a bare `<button>` inside
    the content is reachable by pointer and by nothing else, which §10 forbids.
  - ☑ ~~**Seen in a real window** on 2026-08-30, and the precedent held: it found three defects
    no renderer test could.~~ The grid laid out against `clientWidth`, which **includes the
    scroller's own padding**, so every view was one gutter too wide and the rightmost column ran
    under the scrollbar with its edge cut off. In Details that clipped the date; in Icons it
    clipped a thumbnail, which reads as a crop rather than a bug. The header's `em` tracks
    resolved against `--text-sm` while a row's resolved against `--text-base`, so the columns
    drifted apart left to right — 24px by the last one. And the header, sitting outside the
    scroller, was never narrowed by the reserved scrollbar strip. Fixed together: the tracks are
    `px` and declared once, the grid measures the content box, and it writes the reserved strip
    to the frame as a custom property. Measured after: zero drift across all six columns.

- ☑ ~~**Sort By.**~~ **Built 2026-09-09** (ADR-0039), with migration 0014 and a bench run per key.
  Six orders — added, created, name, size, rating, random — one index each except the last, which
  cannot have one. Two things this note predicted were wrong in the same direction: an index *per
  filter* is not needed for the unfiltered grid (four indexes, not twenty; the filtered case is
  10.5 ms and recorded rather than fixed), and the mixed-order trap was **removed** rather than
  worked around — every tie-break now follows its key, so one index serves both directions and the
  resume is two index seeks. What it did not predict is the measurement that mattered most: written
  as one predicate, a resume walks the whole run of rows sharing a key, which is 5.8 ms at page 500
  of a rating-sorted library against 0.06 ms as two seeks.

- ☑ ~~**Group By.**~~ **Withdrawn 2026-09-09** at the user's word (ADR-0039 §8): never built, and a
  menu item that has never done anything is one nobody should read twice. If it is ever wanted it
  is an ADR of its own, not a disabled row waiting.

- ☑ ~~**The chosen view, the zoom target, and the sort want to be per-library settings.**~~ **Built
  2026-09-09** (ADR-0039 §7), the icon shape with them: six keys in `settings.json`, each falling
  back on its own. The view and the zoom stay the window's vocabulary — a `gridView` this build
  does not know draws as Icons and a `gridZoom` off the steps snaps to the nearest — because an
  engine that knew what "compact" is would hold a copy of the interface. One consequence: the grid
  asks for its first page *after* the preferences arrive, so `assets:page` is the last request on
  opening a library rather than one of the first.

### Format breadth (M4) — done 2026-08-29

- ☑ ~~The derive queue, its migration, and a runner that survives a crash.~~ Migration 0006
  (`DATA_MODEL.md` §2.5). Import queues in the transaction that writes the rows; the engine works
  the queue from the moment a library opens.

- ☑ ~~Video and audio, PDF, SVG, fonts, and RAW.~~ Four backends behind one dispatcher, and the
  acceptance criterion is two tests rather than a claim.

### Deferred by design

- ☑ ~~**Comments exist below the window and not in it**~~ (ADR-0023, 2026-09-02). Both halves
  landed the same day. The storage half was proven through a real rebuild — the index was deleted
  outright and all three comments came back, the edited one at its new moment. The window half is
  three contract requests, the three cases in the engine host, `Comments` in the inspector
  (`UI_SPEC.md` §3.5), and the marker strip under the player (§7).
  - **Comments ride on `asset:detail` rather than a request of their own.** The inspector and the
    preview both already read the detail, and both re-read it on every announced change — so a
    fourth request would have been a second round trip for each and two ideas of when the list is
    stale. It cost the preview a `generation` prop, which it needed anyway: the inspector sits
    beside it and edits the same asset, so without it the strip was right only until somebody used
    the panel next to it.
  - **There is no IPC handler in main.** Main forwards everything it does not answer itself, and a
    comment needs no window — so `ANSWERED_HERE` is untouched and the three cases live in the
    engine host, where "validate → call service → return" already is.
  - **The seek crosses subtrees through a store, not a prop.** `preview/playhead.ts` holds the
    media element on screen; the inspector's list and the strip both reach it. Threading a ref up
    through `App` and back down would give every component on the way a prop about a feature it
    has nothing to do with — the same argument §6 makes about the selection, for a much smaller
    thing.
  - ☑ ~~**Seen in a real window**~~ the same day, and the precedent held for the sixth time: it
    found a defect no component test had. **The strip's duration was seeded into state from the
    first detail read**, so a preview opened before the derive pass had probed the file held
    `null` for as long as it stayed open — and `loadedmetadata` never fires to correct that when
    the element itself will not load, which is exactly what the first fixture accidentally
    produced. Derived from the prop now, with a regression test that fails against the old shape.
    Fifteen checks: tick placement along a real timeline, the centring, the paint, the strip
    matching the picture's width, both fitting the pane, two seeks of a real decoder, and a
    comment written in the panel appearing on the strip beside it.
  - ☑ ~~**That script is not landed either.**~~ It landed the next day as
    `scripts/check-transport.mjs`, and on 2026-09-03 it moved onto the shared harness with the
    other four. What it asserted about the comment strip is now asserted about the marks on the
    timeline, which is where they went.

### The window's own scrollbar (2026-09-10)

- ☑ ~~**The status bar's failure count stood half a pixel out of the bar.**~~ It is the one line
  in the status bar that is a `button`, so it took `--control-height` from the element rule, and
  the bar's content box is that height *minus its own top border*: 28px in 27px, centred, which
  put 0.5px below the window and made Chromium draw a scrollbar for the viewport — a second bar
  down the right edge, outside the inspector's. `height: auto`, like the `span` beside it.

- ☑ ~~**`html` is clipped, so the viewport cannot scroll at all.**~~ Every scroller here is a
  named region sized to its frame; the window scrolling is always a defect, never a view. The
  clip hides the symptom and `check-failures.mjs` asserts on `scrollHeight`, which still counts
  what overflows, so the cause stays visible (`UI_SPEC.md` §2.5).

### Showing and hiding the side panes (ADR-0028 §6, asked for 2026-09-13)

- ☑ ~~**With the sidebar hidden and a file open, the `☰` is on screen nowhere.** The preview
  replaces the content head with its own bar (`UI_SPEC.md` §7), and the button lives in whichever
  of the two heads is drawn — so while both are away the menu is reachable only by `Escape` or
  **Close**, which give the grid and the button back, or by `F9`. Not a dead end, and not
  addressed: putting the `☰` in the preview's bar would be a fourth place it can appear.~~ Closed
  the same day, 2026-09-13, by the user finding it in a real window and saying so with a
  screenshot. It is the fourth place, and the reasoning above was wrong about what that costs:
  the rule was never "at most three heads", it is **one button in whichever head is on screen** —
  and `check-panes.mjs` asserts the count rather than the list. The pane takes a `menu` prop
  instead of building one, because it is the same element, and the pane **takes focus back** when
  the button arrives or leaves: bringing the sidebar back from that menu unmounts the element
  Radix handed focus to, and focus on `<body>` is `Escape` and the arrow keys dead.

- ☑ ~~**Neither pane can be resized.** `UI_SPEC.md` §1 has promised 220–420px and 280–480px with a
  drag since M3; the widths are still the two fixed numbers in `app.css`. Hiding one is the whole
  of what the user can do about width today, which is the coarsest possible version of this.~~ Done
  the same day, 2026-09-13, on the user asking whether it would be complicated. It was not: the
  grid has watched its own box with a `ResizeObserver` since M3, so no layout code was needed —
  the width is a custom property on the row the columns sit in, written straight to the DOM while
  the pointer is down and sent to the engine once, at the end. `PaneResizer` is a `separator` and
  so takes the arrow keys; a double-click resets. Two settings keys, bounded in the engine as well
  as in the window. Two things it taught: `setPointerCapture` throws for a synthetic pointer
  (`Grid.tsx` already knew, and the listeners are on the window so the gesture survives either
  way), and a gesture must continue from **what is drawn** rather than from the prop, which is a
  round trip behind while a commit is in flight — found as a flake in `check-panes.mjs` before any
  person could have hit it.
