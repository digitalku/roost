# Roost — TODO

Everything known to be outstanding, in priority order. `ROADMAP.md` holds the milestone plan;
this file holds the working list, including the small things that surface during implementation
and would otherwise be forgotten.

Last reviewed: 2026-09-03. M5 and M6 are deferred at the user's request — feature work first,
and those two milestones get planned once the feature set has settled.

Legend: 🔴 blocks other work · 🟡 do before the milestone it names · 🟢 whenever

---

## 1. Needs a decision from the user

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

- ☑ ~~**ADR-0029 — favourite is retired.**~~ **Accepted 2026-09-05** and built the same day, on
  the user seeing the two controls side by side: *"sudah ada star, kalau memang disukai tinggal
  saya bintang 5"*. A favourite is a rating with one value and no scale. Everything that authors
  one is gone — the inspector control, the Favorites place, `asset:favorite`, `setFavorite`,
  `roost favorite`, and `F`. **`is_favorite`, `favorite_set` and `is:favorite` stay**: the index is
  rebuilt from the journal, so a build that did not understand the op could not open a library that
  has one, and a smart folder saying `is:favorite` must still parse (`DATA_MODEL.md` §3). The CLI
  still prints the state where it exists, and only there.

**Nothing blocking.** ADR-0025 through ADR-0029 were all accepted on the day they were proposed. The
five questions the language change forced were settled on 2026-08-24, before any code was
written against them — ADR-0006 through ADR-0012, all Accepted. What they decided is in
`ROADMAP.md` §Decision status; what they now *oblige* is in §3 below.

Electron version policy was settled the same day: **track the stable line**, exact pin,
deliberate bumps, never outside the supported three majors (ADR-0011). M0 pins whatever is
stable at scaffold time — **43.4.1** as of 2026-08-24 — and records the Chromium and Node
versions that came with it.

Still open, and none of it blocks M0:

- 🟡 **The two path edits in `STORAGE_SPEC.md`.** The spec is binding, and this repository
  changed exactly two strings in it: `crates/core/migrations/` → `packages/core/migrations/`,
  and the journal op source file's path. Both name where *code* lives, not what a *library*
  contains, so nothing about the format moved. Flagged here rather than assumed, because a
  binding document does not get edited quietly. See the port note at the top of the spec.

- 🟡 **Nothing follows the system's colour scheme.** `index.html` pins
  `data-theme="dark"` and no code reads `prefers-color-scheme`. Found on 2026-08-30 while
  costing native menus, where it would have been a blocker — a native menu follows the GTK theme,
  so a light desktop would have shown a light menu over a permanently dark window. The menus
  became ours instead (ADR-0021), so it is no longer blocking, but it is still wrong. A theme
  setting has a home now: per-library in `settings.json`, with the application default in
  `configDir()` because the picker is drawn before any library is open (ADR-0019).

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

- 🟢 **Licence and copyright.** `roost-old` is MIT, copyright Digitalku. Assumed the same here
  and written into `LICENSE`; say if this repository should differ.

- 🟢 **What happens to `../roost-old`.** It stays as the reference implementation and the source
  of the cross-implementation test fixture. If it is meant to be archived instead, the fixture
  has to be generated and committed here first.

## 2. Blocked on the environment

**Nothing.** Probed and then resolved on 2026-08-24.

| Tool | State | Matters for |
| --- | --- | --- |
| Node 22.23.1, pnpm 11.22.0, git 2.55.0 | ✅ | everything |
| gcc 16.1.1, **g++ 16.2.1**, make, **cmake 4.3.0**, pkg-config, Python 3.14 | ✅ | building a native module from source when no prebuild matches Electron's ABI |
| **ffmpeg / ffprobe 8.1.2** | ✅ | M4 video thumbnails, and verifying playback against a real file |
| **gh 2.97.0** | ✅ | reading CI results from here |
| cargo 1.97.1 | ✅ | running `roost-old` to generate the cross-implementation fixture |
| sqlite3 3.51.2 | ✅ | inspecting `index.db` and `EXPLAIN QUERY PLAN` by hand |
| Electron's runtime libraries (NSS, GTK 3, X11, xkbcommon, drm, gbm, ALSA, at-spi, CUPS, Pango, Cairo, libsecret) | ✅ all present | M3 can open a window |
| Display passthrough | ✅ Wayland + XWayland | M3 |
| Filesystem | ✅ Btrfs | reflink is testable here |

Two things that are no longer blocked, but are still easy to get wrong:

- ☑ ~~**Video playback is still unverified against a real `<video>` element.**~~ Closed
  2026-09-02 while checking the comment strip: a 20-second H.264 clip played in a real window,
  reported its duration, and seeked twice on demand — served the whole way over
  `roost://original`, which also exercises ADR-0008's range support for the first time.
  - 🟡 **`ffmpeg`'s default encoder for `.mp4` here is MPEG-4 Part 2, and Chromium will not play
    it.** The first fixture produced `video.codec: mpeg4`, the element reported error 4
    (`SRC_NOT_SUPPORTED`), and it read exactly like a broken protocol handler — the content type
    was right, the bytes were right, and the codec was the whole of it. This build also has no
    `libx264`; `-c:v libopenh264` is the spelling that works. Any future fixture meant to be
    *played* has to say so explicitly.
- 🟡 **Electron will use XWayland unless told not to.** The session is Wayland and both sockets
  are visible in the container, so `pnpm dev` passes `--ozone-platform-hint=auto`. Without it the
  window is blurry on a HiDPI screen and fractional scaling is wrong, which reads as a rendering
  bug and is not one.

## 3. To build — the working list

Ordered by milestone. Items here are additional detail to `ROADMAP.md`, not a second copy of it.

### Foundation (M0) — done 2026-08-24
- ☑ ~~The renderer import-restriction lint rule.~~ In place, and **verified by violating it**: a
  throwaway file importing `node:fs` and `@roost/core` was written, watched to fail, and deleted.
  Reading the config would not have proved anything.
- ☑ ~~The CSS token check.~~ In place before the first component, with unit tests and an
  end-to-end check in both directions. Comments are stripped before the scan, or the comment
  explaining the bug would report itself.
- ☑ ~~An `.editorconfig`.~~
- 🟡 **The per-platform native-module CI job is deferred to M1**, where the modules it
  guards actually arrive. A job that builds nothing and reports success is worse than an absent
  one. `ROADMAP.md` M0 records the deviation; the CI file carries the reason.
- 🟢 **`ELECTRON_SKIP_BINARY_DOWNLOAD=1` is set in CI** and must be removed at M3, the first
  milestone that starts Electron. Until then it saves ~150 MB per run for a binary nothing runs.

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
- 🟡 **`@roost/library` must not acquire `electron` in its dependency graph**, directly or
  transitively. A lint rule or a dependency-graph assertion belongs with the first real service,
  since the CLI is what proves the layering and the CLI is written in this milestone.
- 🟡 **The reflink test asserts the contract, not the allocation.** It cannot compare bytes — a
  fallback copy produces identical bytes — and it cannot measure allocation on this container
  either: `filefrag`, `compsize`, and `btrfs` are not installed, `du` counts shared extents once
  per file, and Btrfs free-space accounting is too lazy to read a 512 MiB delta out of `statfs`.
  What it asserts is that `COPYFILE_FICLONE_FORCE` reports `reflink` where the filesystem
  supports it and **refuses** where it does not. Both sides are reachable here: the repository is
  on Btrfs and `/tmp` is tmpfs (ADR-0012).
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
- 🟢 **`roost fixture --real-images` is slow enough to notice**: 10,000 images at 1200x800 took
  247 s, against 0.13 s for 2,000 files of random bytes. It is encoder-bound and the encoder is
  the one the thumbnail path uses, so this is honest work rather than waste — but a `--jobs` flag
  would make a 100k benchmark corpus practical.
- 🟢 **Superseded:** the CLI reporting sizes in MB. The Rust CLI prints `445.3 MB` where a naive
  `bytes / 1e6` prints `467.0 MB` for the same library. Neither is wrong and they do not
  disagree — 445.3 MiB *is* 467.0 MB — but two implementations describing one library must not
  look like they disagree about its size.
- 🟢 **The import pipeline is CPU-bound on one thread**, not on the filesystem. Measured: six
  times the Rust build's CPU per file, and flat past four files in flight. If that ever needs to
  improve, the lever is moving hashing and probing to worker threads, not a larger queue or a
  wider `UV_THREADPOOL_SIZE`. See `BENCHMARKS.md`.
- 🟢 Streamed hashing must not read whole files. Assets are routinely gigabytes.

- 🟡 **Packaging must carry `packages/core/migrations/`.** The migration runner reads the
  `.sql` files at run time, relative to the module, so that the files stay the single source of
  truth the conformance test compares against. That is free in dev and in the CLI; an Electron
  bundle has to be told to include them. M6, but written down here because the failure is "the
  app cannot open any library" and the cause is invisible in the source.
- 🟢 **`ThumbnailReader`, the read-only handle in main, is not written yet.** `ARCHITECTURE.md`
  §3.2 specifies it and M3 is the first milestone with a protocol handler to use it, so it is
  deliberately absent rather than scaffolded. When it lands it takes `readonly: true` and the
  same `configure` pragmas.
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
- 🟡 **Linux packaging carries libvips and must not carry GLib** (ADR-0013). M6. Bundling GLib
  recreates the exact collision this decision avoids. Flatpak gets this right from its runtime;
  an AppImage or `.deb` has to be checked rather than assumed.
- ☑ ~~**`roost doctor` should report which sharp build is loaded.**~~ It prints the `sharp` and
  `libvips` versions on every run, shallow or deep, and since 2026-08-27 the word that the
  versions cannot carry: `source`, `prebuilt`, or `unknown`, read from the loaded shared objects.
- 🟢 **BMP has no thumbnail here.** libvips 8.18.3 has no BMP loader; the Rust build's `image`
  crate did. A `.bmp` still imports and still carries tags. Pinned by a test so it stays a
  decision.
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
- 🟡 **Error positions are string indices here, not byte offsets.** The Rust parser reports
  bytes; a caret in a text input is measured in UTF-16 code units, and a byte offset would point
  at the wrong character from the first non-ASCII character onward. `DATA_MODEL.md` §3 says
  "byte offset" and should be reworded when the search field lands in M3.
- ☑ ~~`doctor --reclaim` must refuse when the index and the object store disagree.~~ It does, and
  both halves of the rule have a test: a missing object blocks the reclaim, and a moved
  *referenced* original does not — that one says the user moved their own file, and counting it
  would block reclaiming forever, since no rebuild returns a file someone meant to delete.

- 🟡 **Notes are not searchable at all, and `CONCEPT.md` §5.1 lists them as an M.** The parity
  line is "full-text over name, tags, **notes**, folder names"; `assets_fts` is
  `(hash, orig_name, tags)`, and RQL has no `note:` either — so a note is a field a person can
  write and then never find again. Found on 2026-09-01 while drafting ADR-0023, which refuses to
  give comments a search path before notes have one: a library where the comments are findable
  and the notes are not is worse than one where neither is. The fix is one FTS column and one
  trigger, and folder names are the other half of the same line.
- 🟡 **Free text that matches almost everything costs 22 ms at 95k assets**, against 0.16 ms for
  a selective term. `assets_fts MATCH ?` is compiled as `a.rowid IN (SELECT rowid ...)`, and the
  subquery materialises every matching rowid before the ordering and the limit apply. Nothing to
  fix at this size — see `BENCHMARKS.md` — but the shape of the fix is pushing the limit into the
  FTS side, and 1M assets is where it may start to matter.
- 🟢 **A query that matches nothing is the worst case, not the best**: proving an empty answer
  means walking every row. Worth saying in the UI eventually, because "searching for something
  that is not there is slow" will otherwise be reported as a bug.
- 🟢 **A query beginning with `-` reads as a flag** to `parseArgs` and to clap alike, so
  `roost query -- '-tag:wip'` is the spelling. The help says so; a search *field* in M3 has no
  such problem and should not inherit the workaround.
- 🟡 **Smart folders have no parent in the CLI.** `createSmartFolder` takes one and the schema
  holds one, but `roost smart create` always passes `null`. The sidebar in M3 is the first thing
  that can show a tree, and it is where the flag should arrive.

### Shell and UI (M3)
- 🟡 **The dev CSP allows `'unsafe-inline'` for scripts and the packaged one does not.**
  React Fast Refresh injects an inline preamble and Vite has no way to serve it as a file; with
  the strict policy the window loads and then reports "can't detect preamble", which reads as a
  plugin bug and is the CSP doing its job. `'unsafe-eval'` is refused in both. The price is that
  an inline script would work in `pnpm dev` and fail in the packaged app — React emits none, so
  it is theoretical, but "works in dev" is the shape of bug this project keeps finding, so the
  packaged build has to be run before anything ships.
- 🟡 **Nothing in CI launches a window yet.** Five scripts now drive a real window —
  `check-sandbox`, `check-trash`, `check-transport`, `check-grid`, and `bench-window` — and all
  five are run by hand. They are not in `pnpm verify` because they need Electron's binary and a
  session that composites, which is also what `ELECTRON_SKIP_BINARY_DOWNLOAD` in CI is waiting
  for. Four of the five now **build their own fixture**, so the job needs nothing but a machine
  that draws a window. The scripts exist; the job does not.
  - **They all share `scripts/lib/`** since 2026-09-03: `window.mjs` (spawn, attach, evaluate,
    settle, real pointer and key input, a screenshot, a frame-rate probe), `checks.mjs` (the
    ledger), and `fixtures.mjs` (a scratch library, real images, a playable clip). Adding a sixth
    check is now a page expression and a claim rather than a fifth copy of the plumbing.
- 🟡 **`check-grid.mjs` has not yet completed a run in a composited window.** Written and driven
  on 2026-09-03: fifteen of its claims were seen to pass, and then the session's compositor
  stopped drawing new windows, at which point the script correctly refused rather than reporting
  the layout and the marquee as broken (§4 lesson 18). The two defects the first run found were in
  the script, not in the grid — a card read while `Ctrl+A` was still in force, and cells taken in
  DOM order rather than visual order — and both are fixed. **It needs one clean run on a desktop
  session with the window visible** before it can be called a guard.
- 🟢 **The grid's first layout is measured before the inspector has claimed its width**, and only
  a `ResizeObserver` delivery corrects it. Seen while writing the check above: at mount the
  scroller is the full width of the frame, so `measure()` records a container about 240px too
  wide, and the columns are laid out against it until the panel appears and the observer fires.
  It is right within a frame in any window that is being drawn, so it is a fragility rather than a
  bug — but it is the reason an uncomposited window shows cells running off the right edge.
- 🟢 **Log files are never pruned.** One file per UTC day under `logDir()`, written
  synchronously, growing forever. A retention rule belongs with M6's packaging, not before it.
- ☑ ~~The frontend test harness goes in **before** the components, not after.~~ In place with
  the first screen it covers: `vitest` with two projects so only the renderer gets a DOM, a fake
  `window.roost` installed at the same seam the real one occupies, and thirteen tests driving the
  picker and the creator the way a person does. Verified by breaking three things and watching
  the right tests fail.
- 🟡 **A native dialog cannot be clicked by a script.** The folder chooser is answered by the
  fake bridge in a component test, and the twenty lines in main that open it are covered by
  nothing. That is the remaining gap in this flow, and an Electron end-to-end driver is what
  would close it.
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
- 🟡 Window state — size, position, last library — has nowhere to live until there is an
  application config (`~/.config/roost/`). Recent libraries and the default import mode need the
  same place.
- 🟡 **The grid landed without four things `UI_SPEC.md` §6 describes**, and each is a decision
  rather than an omission to discover later:
  - **The list view and the zoom control** are both now part of ADR-0018 below, which gave them
    the place in the interface they were missing. Neither was built for the same reason: a
    two-button toggle had nowhere to put them.
  - ☑ ~~**Marquee selection.**~~ Landed 2026-09-01. `tilesIn` reuses the culling's binary search
    per column, so a sweep costs the columns it crosses rather than the result set; the store
    gained one operation (`sweep`), applied once per frame and only when the swept set actually
    changed. It takes what it touches, adds under `Ctrl`, scrolls from the edge, and clears on
    release rather than on press (`UI_SPEC.md` §6). Driven in a real window the same day: twelve
    checks over CDP, including the autoscroll, the marquee's computed paint, and a press on the
    scrollbar strip — none of which happy-dom can see. **Landed 2026-09-03** in
    `scripts/check-grid.mjs`, on the shared harness.
  - **Hover in the store.** Hover is CSS-only, which is right until something outside the cell
    has to know what is under the pointer — the inspector's preview-on-hover is the first thing
    that will.
- ☑ ~~**A folder name containing `/` made its own path ambiguous.**~~ Found on 2026-08-27 by
  driving the real window: a top-level folder literally named `Design/Icons` and an `Icons`
  inside `Design` both compile to `folder:"Design/Icons"`, so the sidebar highlighted the wrong
  row and neither folder was reliably addressable from the CLI. Rejected now where a name is
  *authored* — replay still accepts one, because a library written before the rule must still
  rebuild.
- 🟡 **The sidebar draws what it is given and nothing more.** What `UI_SPEC.md` §4 describes and
  it does not do yet:
  - **Collapsing.** Folder branches and tag groups are always expanded. A library with two
    hundred tags is a very long pane.
  - **Drag to reorder and re-parent** a folder. `moveFolder` exists and refuses a cycle; what is
    missing is the drag.
  - **Ctrl-click to add a term** (§4.2). Clicking replaces the query; compounding needs the
    search field, because the compound query has to be visible and editable to be honest.
  - **The library switcher** at the top, and with it "Open library…" from inside an open
    library. It needs the recent-libraries list, which needs the application config that window
    state is also waiting for.
  - **Smart-folder match counts** (§4.1). Every read would run every saved query; the count
    arrives with the search field's count, which is the thing that makes it cheap enough.
- 🟡 **The search field validates but does not suggest.** What `UI_SPEC.md` §5 still describes:
  - **Autocomplete**: field names first, then values once a field is typed — `tag:` offers tags,
    `folder:` offers folders, `ext:` offers the extensions actually present. The vocabulary is
    `@roost/search`'s (`FLAGS`, `NAME_FIELDS`, `NUMERIC_FIELDS`) and the values are the
    library's, so it is one more request rather than a table in the renderer.
  - **Chips**, as an optional view of the parsed AST. The string stays the source of truth,
    which means the engine has to hand back the AST as well as a verdict.
  - **Save as smart folder** from the field, which is where a saved query naturally comes from.
  - **Ctrl-click a sidebar row to add a term** (§4.2). It belongs here rather than in the
    sidebar: the compound query has to be visible and editable in the field to be honest, and
    joining two queries with an implicit `AND` is grammar work that belongs in `@roost/search`.
- 🟡 **The window imports in managed mode with no tags, and cannot say otherwise.** The request
  carries both — the CLI has had `--mode` and `--tag` since M1 — and what is missing is where to
  put them: the mode belongs in a preference (the application config that window state is also
  waiting for) and the tags in an import dialog that does not exist yet.
- 🟡 **A filtered grid does not re-page when an edit changes what matches.** The window keeps
  two counters: a library `generation`, which throws the grid's pages away, and a `revision`,
  which every derived read follows. Without the split, one keystroke in the note field would
  re-page the grid from row one and throw the scroll position away — but the cost is that
  tagging the asset under `is:untagged` leaves it on screen until the query is re-applied. The
  fix is a targeted update (drop the row, keep the scroll), not a reload. A **changed asset
  count** does re-page, because "the library went from empty to twelve" is a visibly wrong grid
  rather than a stale one.
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
- 🟡 **The preview fits the pane and stops there.** `UI_SPEC.md` §7 also asks for click-to-toggle
  1:1 and drag-to-pan on an image, which is the difference between looking at a photograph and
  checking one. It needs a transform and a gesture, not a new request.
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
- 🟢 **The grid's frame budget is asserted by construction, not measured.** The re-render count
  is a test, and the layout is a binary search per column; neither is a frame percentile. The
  scroll benchmark mode is what turns this into a number, and it is still an M3 item.
- 🟢 The app icon. `roost-old` shipped a flat generated square and never replaced it.

### Settings, windows, and the picker (ADR-0019 and ADR-0020, decided 2026-08-30)

- ☑ ~~**The recent-libraries list, and with it the first application state file.**~~ Done
  2026-08-30: `stateDir()/recent.json`, written atomically, tolerant of absence and damage, with
  pinning and forgetting. `UI_SPEC.md` §3.1 is the design of record. **It has not been seen in a
  real window** — an Electron instance from an earlier session held the single-instance lock, so
  every attempt to drive a fresh one exited immediately, which is `main.ts:65` working exactly as
  written. The component and the wiring have tests; the pixels are unverified.
  - 🟢 **The CLI does not record into it.** Deliberate but not obviously right: `roost init`
    creating a library is a deliberate act and belongs on the list, while `roost query` in a
    script rewriting a state file is not. If it lands, the rule is "init and open record; reads
    do not".
- 🟡 **`settings.json` in the library** (ADR-0019). Reads tolerate absence, damage, unknown keys,
  and wrong types by falling back per setting. Writes tolerate failure silently — a library on
  read-only media must not raise a dialog when somebody changes the zoom. Unknown keys survive a
  write, for the same reason unknown journal ops are skipped rather than dropped.
  - **`dirs.ts`'s doc comment becomes wrong** the moment this lands: it says a library holds
    `originals/`, `index.db`, `journal/`, and `library.json` "and nothing else". Correct it in
    the same change.
  - The CLI reads the same file, so the two frontends do not disagree about how a library is
    configured (ADR-0005).
- 🟡 **`Ctrl+N` — a second window onto the same library** (ADR-0020). `broadcast()` is already
  plural and `createWindow()` already exists; what is missing is the command and per-window
  geometry in `stateDir()`. Switching library moves every window: a window is a view, not a
  session.
- 🟢 **Several libraries at once is refused, not forgotten.** If it is ever wanted, it starts at
  the protocol: `roost://thumb/<hash>@256` names no library, so two open libraries make the URL
  ambiguous. That is an ADR-0008 amendment, several read-only handles in main, and an engine
  story. Written down so the cost is not rediscovered.

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
- 🟡 **Rating, favourite, and tags are not in the menu.** They would need the selection summary
  the inspector already fetches, which is a round trip on every right-click. Worth doing, and
  worth doing after trash rather than instead of it.
- 🟡 **"Open with…" is not "Open".** The user asked for a chooser; `shell.openPath` gives the
  desktop's default. A real chooser has no Electron API and would mean reading `.desktop` files
  and `mimeapps.list` on Linux with nothing shared by the other two platforms — an ADR, not a
  menu item.
- 🟡 **Copy is a path, not a file.** `Ctrl+V` into a file manager does nothing with it. A real
  file copy needs `text/uri-list` and, for Nautilus, `x-special/gnome-copied-files`, which is one
  clipboard format per desktop.
- ☑ ~~**The menu on an open preview**, over the asset on screen rather than over the selection.~~
  Added 2026-08-31 at the user's request. Distinguishing the two rules needs `Enter` rather than a
  double-click, because a double-click's own pointer-down collapses the selection first — the
  version written with `dblClick` passed with the wrong rule wired in.
- 🟡 **Focus returning to what the menu was opened over is a real-window claim.** The fix is
  `onCloseAutoFocus`: Radix hands focus to the trigger, a wrapper with no `tabindex`, so a real
  browser drops it on the body and both the grid's roving ring and the preview's stepping go dead.
  **happy-dom does not model focusability**, so the test written for it passed with the fix and
  with the fix removed — it was deleted rather than kept as false comfort (§4, lesson 9). This is
  the first thing to check in a window.
- 🟡 **`PreviewPane` claims `aria-modal="true"` and is not modal.** The sidebar, the toolbar and
  the inspector all stay rendered and usable beside it, and `UI_SPEC.md` §7 says "into the content
  region" rather than over it. Found while wrapping the pane in the context menu; not changed in
  the same breath because the role is what `PreviewPane.test.tsx` finds the pane by.
- ☑ ~~**Trash, in a real window.**~~ Driven 2026-09-01, and the precedent held for the fourth
  time: it found two defects no test could. `scripts/check-trash.mjs` is what it became — 22
  assertions against a running window, over a library it builds in a temp directory and deletes
  again, so it can never touch one of yours. Verified by breaking the fix and watching three of
  the 22 fail.
  - **Trashing left the selection holding an asset nobody could see.** The status bar said "1
    selected" over a grid with nothing highlighted, the inspector went on editing a trashed
    asset, and the roving ring had nowhere to go. Every action that removes assets from the view
    clears the selection now; exporting, which removes nothing, does not.
  - **The fix for that wiped the status line the action had just written.** The line cleared on
    any selection change, and trashing now *is* a selection change — so no destructive action
    could ever say what it did. The note is stamped with the selection it was written against and
    clears only when the selection moves away from it.
  - 🟢 **The roving ring is left with nothing focused** after a delete, which is consistent with
    clearing the selection any other way but not with what a file manager does. Moving it to the
    next surviving row needs the grid's order at the moment of the delete.
- 🟡 **Not seen in a real window.** An Electron instance opened outside this session held the
  single-instance lock again. Twelve component tests, one at the App level and seven service tests
  cover it; the pixels do not — and this is the second time in two sessions, so it is a workflow
  gap rather than bad luck. What most needs a window: focus after the menu closes, and whether the
  grid and the preview still fill their new wrapper.

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
- 🟡 **The grid re-pages on a trash rather than dropping the row.** `readStats` now compares the
  trashed count as well as the asset count, so trashing does invalidate the pages — but it
  invalidates *all* of them and the scroll position goes with them. That is the same targeted-update
  gap §M3 already carries, now reachable one gesture sooner.
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
- 🟡 **The inspector says nothing about a trashed asset.** `AssetDetail` and the wire both carry
  `trashedAt` and nothing draws it, so an asset opened from Trash looks like any other.
- 🟢 **`doctor` does not mention the trash.** Trashed assets are still rows, so their bytes are
  correctly *not* orphans and `--reclaim` is unaffected — but a library with four hundred
  trashed assets holding gigabytes has no way to learn that except `roost stats`.
- 🟢 **No `Shift+Delete`.** Deleting permanently is reachable from the menu and from `Delete`
  inside the Trash, and a shortcut that skips the trash from anywhere is one keystroke away from
  being the thing this ADR exists to prevent.

### A transport of our own (ADR-0024, decided 2026-09-02)

Four stages. **Stages 1, 2 and 4 are done**; stage 3 is a decision of its own.

- 🟢 **Measure four player libraries**: `media-chrome`, Vidstack, Plyr, video.js. **Not done, and
  no longer blocking**: the user asked for stage 1 ahead of it, and stage 1 was built in-repo over
  the slider primitive this repository already depends on (ADR-0021, already measured against
  invariant 7). It cost 15.8 KB of bundle, which is the baseline any candidate now has to beat.
  Still the way to decide it if stage 2 or 3 wants something a library ships. What to measure, in
  the order that decides it:
  1. **Invariant 7** — does it reach the network at run time, for a font, an icon set, or a ping.
     Four candidates were clean on this in ADR-0021 and the constraint decided nothing there; it
     is still the one that can rule a candidate out outright.
  2. **Whether a mark can go on its timeline** without forking it. This is the whole reason we are
     here, and a library that cannot take one is not a candidate however good it is otherwise.
  3. **The bundle**, against the <1.5s cold start in `CONCEPT.md` §7. The renderer is 361.2 KB
     today, 342 KB before the transport.
  4. **Whether its accessibility is real or claimed** — keyboard-only operation, and a slider that
     is a slider to a screen reader.
  The prior expectation is in-repo, for the reason `UI_SPEC.md` §3 gives about every other
  component here. A prior expectation is not a measurement.
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
- 🟡 **Stage 3 — hover-scrub previews. Still a decision, not yet work.** A storyboard sprite
  generated on first open, not a frame per request: a PDF page is pdfium in WebAssembly and a
  video frame is an ffmpeg process, and a pointer crossing a timeline asks for tens a second.
  `thumbs` is keyed `(hash, size)` and a sprite is not a size, so it needs a table or a
  vocabulary — `DATA_MODEL.md` §2 governs it, and it wants its own ADR.

### Making files in the library, and editing text (asked for 2026-09-03)

Four things asked for together: a context menu on the grid's **empty space**, carrying **Paste**
(which imports what the clipboard holds) and **New File** — an empty file whose extension the user
types, and a text file — plus text assets that Roost displays and **edits itself**, `.srt` included
(ADR-0025).

**All of it meets the same wall, and the wall is invariant 1.** Identity is the content hash, so
"edit this file" cannot mean here what it means in a file manager. Changed bytes are a *different
asset*: a different hash, a different path in `originals/`, a different row. **ADR-0026 decides
what an edit is** — accepted 2026-09-03 — and its stage 1 is built: a `text` kind and a read-only
viewer, which needed no schema at all.

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
- 🟢 **A text asset has no thumbnail**, so it fails its derive job with `unsupported:text` exactly
  as a `.zip` does. Unchanged behaviour — it was `unsupported:unknown` before — but now that text
  is a kind, rendering the first lines into a thumbnail is a thing that could be done, and the
  grid would stop showing a wall of identical extension badges. Not scheduled; written down so it
  is a choice rather than an oversight.

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

- 🟢 **Adopting a referenced asset has no operation, and now nothing asks for one.** Raised as a
  🔴 on 2026-09-03 because ADR-0026 §3 offered *Duplicate into library to edit* beside a read-only
  editor — and that offer could not be honoured: identical bytes are one asset by invariant 1, so
  importing a referenced original in managed mode deduplicates into the row that already exists
  and changes nothing. **The editor was withdrawn on 2026-09-04, and the question went with it**:
  nothing in the window offers the gesture. What remains is smaller and blocks nothing — `roost
  save` refuses a referenced asset, and the only way to change that honestly is an *adopt*
  operation that copies the bytes into `originals/` and changes `storage_mode`, which would be the
  first op to change an existing row's mode and wants its own journal line. Not scheduled; written
  down so the reasoning is not rediscovered.
- 🟡 **Editing a `.srt` will have to move its attachment**, and ADR-0025 already has the pair that
  does it:
  `subtitle_detach` the old hash, `subtitle_attach` the new one, in the same journal batch. Worth
  noting because it is the first evidence that "an edit is a new asset plus a fix-up of what
  pointed at the old one" is a rule the rest of the schema can follow — tags, folders, rating,
  comments and poster **now do travel that way**, in `carryOver`, and a subtitle attachment is the
  one thing that will have to join them when ADR-0025 lands.

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

- 🟡 **Sort By.** Not a menu item — a migration and a bench run per key. The application has one
  order, `imported_at DESC, hash`, and keyset paging plus all four composite indexes in migration
  0005 are built on it. Each key needs its own index *per filter*, its own cursor, and a
  `searchSql` that stops hardcoding one predicate — including the trap the function's own comment
  records: the order is mixed, so a row-value comparison silently skips rows.
- 🟢 **Group By.** Last. A group header can fall across a keyset page boundary, and a count per
  group is a second aggregate query.
- 🟡 **The chosen view, the zoom target, and the sort want to be per-library settings** — a photo
  library and a library of design files want different defaults. Until that lands the menu holds
  its state in memory and forgets it when the window closes.

### Format breadth (M4) — done 2026-08-29

- ☑ ~~The derive queue, its migration, and a runner that survives a crash.~~ Migration 0006
  (`DATA_MODEL.md` §2.5). Import queues in the transaction that writes the rows; the engine works
  the queue from the moment a library opens.
- ☑ ~~Video and audio, PDF, SVG, fonts, and RAW.~~ Four backends behind one dispatcher, and the
  acceptance criterion is two tests rather than a claim.
- 🟡 **CR3 and RAF import without a thumbnail.** Canon's CR3 is an ISO base media file and Fuji's
  RAF is its own container; neither is a TIFF, so the reader that finds an embedded preview in a
  CR2, NEF, ARW, or DNG finds nothing in them. They are recognised — which is what keeps a CR3
  from reaching ffmpeg as a video — and parked as `unsupported:raw`. Both carry a JPEG that could
  be found with a container parser each.
- 🟡 **A RAW's preview is picked by size, not by tag.** The largest self-contained JPEG in the
  file wins. For every camera measured that is the full-size preview, but a file with an unusual
  layout could hand over the wrong image, and the honest fix is reading `NewSubFileType`.
- 🟢 **No EXIF beyond dimensions.** Orientation, capture date, camera, lens, and GPS are all in
  the files already being parsed for RAW previews. `assets.created_at` is the source file's
  mtime, which is a worse answer than the capture date for a photograph.
- 🟢 **A thumbnail is one frame.** An animated GIF or WebP plays in the preview — an `<img>` does
  that by itself — and its cell is a still. Animated cells would be a grid of moving pictures and
  a stored file many times the size; if they arrive, they arrive as a hover behaviour.
- 🟢 **A PDF has no text layer here.** pdfium exposes `getText`, so search over document contents
  is reachable — but FTS over a million pages is a schema decision, not an afternoon.
- 🟢 **Packaging has to carry two `.wasm` files** and, on Linux, still not carry GLib. The
  document and vector backends resolve their WebAssembly from `node_modules` at first use, which
  an asar bundle changes. M6.
- 🟢 **`roost://page` renders in main.** Deliberate, documented, and cheap because the backend is
  WebAssembly — but it is CPU on the window's process, and a fifty-page-per-second scroll through
  a document would be the thing that proves it wrong.

### Deferred by design
- 🟢 **Journal compaction.** The journal grows monotonically. ADR-0003 leaves compaction out of
  v1 deliberately; revisit only with measurements, and only as a new rotated file.
- 🟢 **Partial-to-full hash upgrade.** Specified in `STORAGE_SPEC.md`, never implemented. It
  changes the primary key *and* the on-disk filename, so it must be a journalled operation.
- 🟢 **A referenced original cannot be byte-verified** on a partial-hash duplicate, because
  there is no object store to compare against. It is merged on probability. Reaching it needs
  the asset's `ref_path` at the point the duplicate is decided.
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
- 🟢 **The grid shows no sign that an asset carries comments.** ADR-0023 left it undecided. It
  would be a badge on the cell and one more column in the page query, which is the part that needs
  measuring rather than deciding.
- 🟢 **No keyboard shortcut reaches the comment field.** `T` focuses the tag editor (§9); there is
  no equivalent for a comment, and the natural one — `C` — is worth having only once the shortcut
  map is rebindable in M6.
- 🟢 **A comment can only be at a time, never at a place.** `at_ms` or nothing. A PDF page and a
  rectangle on an image are the two anchors Eagle also supports, in one comment type; both are
  separate decisions and neither is wanted yet (ADR-0023).
- 🟢 **Journal ops still undefined**, for want of a feature that needs them: stacking, watched
  roots, and the hash upgrade above.
- 🟢 **A Windows build is a port of two modules, not of the application** — asked about
  2026-09-05, and written down here so the answer is not re-derived. `ROADMAP.md` M7 keeps
  Windows unscheduled; nothing below is work for now.
  - **The build machine is not the obstacle, and the project does not move to one.** A CI job on
    a Windows runner packages what the Linux checkout builds. Cross-building from Linux under
    wine is the wrong road for this repository, because of the native modules: `sharp` and
    `@napi-rs/blake-hash` both resolve to prebuilt N-API binaries and need no rebuild, but
    `better-sqlite3` is a node-gyp addon bound to Electron's ABI, so it wants either a prebuild
    that matches the pinned Electron or MSVC on the machine that packages. `scripts/probe-native.ts`
    is what answers that, and ADR-0013 already expects the CI matrix to be where it is answered.
  - **Two modules refuse to run there today, deliberately and loudly.** `platform/dirs.ts` is XDG
    only and raises `UnsupportedPlatformError` rather than guessing a directory; `platform/reveal.ts`
    is `dbus-send` and `xdg-open` behind a `requireLinux`. Both are the whole of the port — the
    known-locations branch and the `explorer /select,` equivalent.
  - **What is already right needs no work.** `COPYFILE_FICLONE_FORCE` answers `ENOTSUP` there and
    the ladder in `storage/managed.ts` falls to hardlink and then copy, so `link_method` stays
    truthful (ADR-0012); ffmpeg is absent gracefully (ADR-0017); pdfium and resvg are WebAssembly;
    and the GLib collision ADR-0013 was written for cannot happen where there is no system GLib,
    which is why the prebuilt `sharp` is the right one there.
  - **Two small things would break the install rather than the app.** The unconditional
    `postinstall` running `scripts/build-sharp.mjs` has to skip a platform that wants the
    prebuilt, and `--ozone-platform-hint=auto` in the `start` script is a Linux flag.
  - Packaging targets, signing, and whether ffmpeg is bundled are an ADR of their own when the
    milestone arrives — the same question M6 answers for Linux, asked again.

## 4. Lessons carried over — do not re-learn these

Each of these cost `roost-old` real time. They are written here rather than left in that
repository's session log, because a lesson nobody rereads is a lesson nobody has.

1. **CSS has no undefined-variable error.** A typo'd token silently drops the declaration. Only
   a build-time check catches it, and only a human found the bug it caused.
2. **End-to-end timing hides regressions that micro-benchmarks show as straight lines.** A 2.5×
   climb in paging cost read as noise for a day; the first bench run found it immediately.
3. **A filtered list query will sort its whole match set to produce one screen** unless the sort
   key is inside the filter index. 18.9 ms against 0.51 ms, on the most ordinary query in the
   app. Migration 0005 exists for this and is carried over.
4. **Keyset paging needs a tie-break column.** `imported_at` is not unique — a bulk import
   writes thousands of rows in the same second — and without the tie-break, paging shows an
   asset twice or skips it.
5. **A preview that does not move the selection writes notes onto the wrong asset.**
6. **Partial-hash duplicates cannot be caught by comparing sizes.** The size is hashed as the
   prefix, so equal partial hashes imply equal sizes. Byte-verify instead, and refuse on a
   mismatch rather than merging.
7. **Cross-compiling a project with native dependencies checks the C toolchain, not your code.**
   `roost-old`'s portability job could only ever fail before it reached anything worth checking.
   Build native modules on the platform they target.
8. **An integration test that imports through a package name tests the last build, not the
   code.** `packages/*/tests/**` resolve `@roost/library` to `dist/`, so a `vitest run` after an
   edit and before a `tsc -b` silently exercises the previous build. Five deliberate breakages
   passed that way on 2026-08-25 and proved nothing. `vitest.config.ts` now aliases every
   workspace package to its `src/`. `pnpm verify` typechecks first and would have caught it in
   CI — but a bare `vitest run` is the command anyone reaches for while working.
9. **A test can pass because the code is right, or because the fixture is too small to tell.**
   Found three times in one session, each by deliberately breaking the thing the test guarded:
   dropping the keyset tie-break changed nothing (the index supplies that order anyway),
   `PRAGMA foreign_keys = OFF` changed nothing (`better-sqlite3` sets it on regardless), and an
   unanchored `/@cursorTs/` matched `@cursorTs2` and counted the broken version as correct.
   Writing the test is half the work; breaking the code to watch it fail is the other half.
10. **`tsc -b` is not a typecheck unless it is forced.** Commit `19e4a8e` shipped four type
    errors — a renderer test still passing `mode` to a `Grid` whose props had been replaced —
    and `pnpm verify` reported clean, because the incremental build did not re-check the
    dependents of the file that changed. The tests passed too: React ignores an unknown prop,
    so `view` arrived as `undefined` and the grid fell back to Icons, which is what those tests
    happened to expect. A forced build finds it in 0.78s against 0.37s, so `pnpm typecheck` is
    `tsc -b --force` now and `pnpm build` stays incremental. TypeScript 7.0.2.
11. **A test that waits for text can pass on text that is about to vanish.** `findByText`
    resolves the moment the node appears and then stops watching, so a status line written and
    then wiped one commit later satisfies it. Written that way, the regression test for the
    status line passed with the fix removed — the same shape as lesson 9, reached from a
    different direction. Wait for the *settled* state first, then read synchronously.
12. **A default parameter swallows an explicit `undefined`.** `show({}, undefined)` in
    `Inspector.test.tsx` selected the default hash rather than an empty selection, so a test
    named "renders nothing when nothing is selected" was reading the first render before the
    detail arrived. It would have passed against a component with no empty-selection logic in
    it. A sentinel that means "absent" has to be one the default cannot supply.
13. **`pkill -f` matches the shell running it.** `pkill -f check-trash.mjs` from a shell whose
    own command line contains that string kills the shell, and the symptom is a command that
    produces no output and never returns — which reads as the script hanging. It cost twenty
    minutes here. Match on a pattern the invocation cannot contain.
14. **Measure before naming the cause.** The obvious reason a sequential JavaScript pipeline
    loses to Rust is that the Rust one is parallel. It is not: `/usr/bin/time` put `roost-old`'s
    import at 98% CPU — one core — while this build sat at 199% and still took three times as
    long. The difference is six times the CPU *per file*, not threads. The write-up that assumed
    otherwise was already drafted.
15. **A `useState` initialiser does not follow the prop it was read from.** The comment strip
    seeded its duration from `detail.durationMs` at mount, so a preview opened before the derive
    pass had probed the file never drew a marker — the later read arrived, the prop changed, and
    the state did not. It self-heals whenever the media element loads and reports its own
    duration, which is why every test passed; it does not heal when the element will not load,
    which is how a real window found it. If a value is a function of a prop, derive it.
16. **Subscribe to the element, not to your copy of what the element is doing.** The transport's
    first sampler attached its `seeked` listener only while React believed the media was paused,
    and skipped every sample while `seeking` was set. Both looked careful and both were wrong:
    `currentTime` is the *official playback position*, which a seek sets straight away, so a seek
    in flight already reads as where it is going — and gating a subscription on rendered state
    means the subscription is missing for exactly as long as that state is behind. Attach to the
    element's own events for the element's whole life, and let its `play` and `pause` decide which
    sampler runs. Found in a window as a timecode frozen at the previous moment for the length of
    a seek; the regression test has to set `seeking` by hand, because a decoder in happy-dom never
    takes long enough to show it.
17. **A cache header is a promise, and a feature can turn it into a lie.**
    `roost://thumb/<hash>@<size>` was served `immutable` for a year on the stated ground that a
    hash and a size fix the pixels. Pinning a thumbnail to a chosen frame made that false, and
    nothing would have failed — the old picture would simply have stayed for a year. The fix is
    that the address has to carry everything that decides the bytes, not that the header has to be
    weakened: a new frame is a new address. It is also the only thing that makes an `<img>` already
    holding the old picture ask for a new one; no header does that. Read the caching claims before
    changing what is behind an address.

18. **A window that says it is visible is not necessarily one anything is drawing.**
    `document.visibilityState` reads `"visible"` for an Electron window the compositor has stopped
    drawing — occluded, on an idle output, or on a session that has locked — and in that state
    Chromium delivers no `requestAnimationFrame`, no `ResizeObserver`, no
    `requestVideoFrameCallback` and no `setTimeout` at anything like its stated delay. The grid
    then keeps the width it measured at mount, because its reflow is a `ResizeObserver`, and the
    marquee is never drawn, because it is scheduled on an animation frame. Both read as defects
    and neither is one. Any check that reads a layout or a gesture has to **measure the frame rate
    and refuse**, the way `bench-window.mjs` already did — and it must count frames through a
    global it polls from outside, never a promise the page resolves on a timer, because in that
    state the timer is throttled too and the check simply hangs.
