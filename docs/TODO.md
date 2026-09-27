# Roost — TODO

Everything known to be outstanding, in priority order. `ROADMAP.md` holds the milestone plan;
this file holds the working list, including the small things that surface during implementation
and would otherwise be forgotten.

Last reviewed: 2026-09-21. M5 and M6 are deferred at the user's request — feature work first,
and those two milestones get planned once the feature set has settled.

Legend: 🔴 blocks other work · 🟡 do before the milestone it names · 🟢 whenever

**This file holds what is outstanding.** Closed items move to [`todo-done.md`](todo-done.md),
which keeps them verbatim under the same headings — a list read at the start of every session
should cost what is still to do, not what was already done. Tick an item where it stands, and
move it when the section is next touched. An item closed with an open child keeps its place here
until the child is closed too.

---

## 1. Needs a decision from the user

**Nothing blocking.** ADR-0025 through ADR-0034 were all accepted on the day they were
proposed or the morning after. The five questions the language change forced were settled on 2026-08-24, before any
code was written against them — ADR-0006 through ADR-0012, all Accepted. What they decided is in
`ROADMAP.md` §Decision status; what they now *oblige* is in §3 below.

Electron version policy was settled the same day: **track the stable line**, exact pin,
deliberate bumps, never outside the supported three majors (ADR-0011). M0 pins whatever is
stable at scaffold time — **43.4.1** as of 2026-08-24 — and records the Chromium and Node
versions that came with it.

Still open, and none of it blocks M0:

- 🟢 **ADR-0051 was accepted on 2026-09-26**, the day it was proposed: thumbnails move out of
  `index.db` into `thumbs/roost.db`, a SQLite file of their own, attached to the engine's
  connection. The work is in §3, under *Thumbnails in a database of their own*.
- 🟢 **ADR-0053 was accepted on 2026-09-26**: format 1 is not named any more. The user has no such
  library. `LibraryIsFormat1Error` is removed, a version below 2 is `not_a_library`, and
  `FORMAT.md` is revision 2.1.
- 🟢 **ADR-0052 was accepted on 2026-09-26**, the day it was proposed: this repository owns its
  format. `docs/FORMAT.md` and `docs/OPS.md` are revision 2.0 copied home, `conformance/` is at
  the root, and `roost-net` is no longer a compatibility target. Nothing changes on disk until the
  first incompatible change, which must mark the library (ADR-0052 §4).

- 🟢 **ADR-0046 was accepted on 2026-09-21**, the day it was proposed. The format moved to
  **version 2** in
  `../roost-library` on 2026-09-20 and this build now reads version 2 and nothing else: identity
  is a minted id, `originals/` is `files/`, the two storage modes are one, `supersede` is gone,
  and a version 1 library is refused by name. The user asked for both of the choices that were
  theirs to make — **refuse and strip the v1 code** rather than park it, and **engine first**
  until the conformance suite is green — and both are done.

  The one thing left over, a lineage appendix that recorded this implementation as
  **discontinued on 2026-09-17**, is corrected in `docs/FORMAT.md`, now that the document is ours
  (ADR-0052).

- 🟢 **ADR-0045 was never accepted, and ADR-0052 superseded it on 2026-09-26.** Everything its
  audit found stays fixed and tested. The format came back to this repository instead.

  It also closes a 🟡 that stood here from M0: *the two path edits in `STORAGE_SPEC.md`*, both of
  which named where **code** lived rather than what a **library** contained. The standard forbids
  a requirement from naming a path in anybody's source tree, so the question cannot arise again.

- 🟢 **A menu that opens a dialog has to stop Radix taking the focus back.** The close returns
  focus to the trigger **after** the dialog has focused its own field, so the caret sits in a field
  nothing is typing into — with the right value and the right selection, which is what makes it
  hard to see. Found in a running window on 2026-09-05 and fixed in `AddMenu` by deferring
  `onCloseAutoFocus` for the two items that open one. **jsdom focuses nothing to steal**, so no
  component test can guard it, and the same class of bug arrives with the next menu item that opens
  a dialog. `AssetContextMenu` was checked at the same time and does **not** have it.

- 🟡 **A scrolling flex column must say `flex: none` on its children, and three of them did
  not.** Found three times on 2026-09-05, each reported as something else: the toolbar "lost its
  padding" in Icons and not in Details, the preview's bar changed height with the file in it, and
  the inspector's picture disappeared once an asset had three comments. One cause — a flex column
  hands its overflow to its items in proportion to their bases, so the tallest item is squeezed
  hardest, and how tall the *other* items are is what decides how much. It looks like a property
  that depends on unrelated content, which is why none of the three was recognised for what it
  was. **None of the three has a regression test**: jsdom computes no layout, so a test that
  asserted a height would pass whatever the CSS said. The honest home for this is a real window —
  `scripts/check-grid.mjs`'s harness can measure one — and it is worth doing when that script is
  next opened, because the class of bug will recur every time a scrolling column gains a child.

- 🟡 **Nothing follows the system's colour scheme.** `index.html` pins
  `data-theme="dark"` and no code reads `prefers-color-scheme`. Found on 2026-08-30 while
  costing native menus, where it would have been a blocker — a native menu follows the GTK theme,
  so a light desktop would have shown a light menu over a permanently dark window. The menus
  became ours instead (ADR-0021), so it is no longer blocking, but it is still wrong. A theme
  setting has a home now: per-library in `settings.json`, with the application default in
  `configDir()` because the picker is drawn before any library is open (ADR-0019).

- 🟢 **What happens to `../roost-old`.** It wrote format 1, which nothing here reads any more
  (ADR-0046), so it is no longer the source of any fixture — `conformance/` at the root is. What it still is, is the reference implementation with real measurements
  behind it: `../roost-old/docs/BENCHMARKS.md`. Archiving it now costs nothing.

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
  `roost://file`, which also exercises ADR-0008's range support for the first time.
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

- 🟡 **The per-platform native-module CI job is deferred to M1**, where the modules it
  guards actually arrive. A job that builds nothing and reports success is worse than an absent
  one. `ROADMAP.md` M0 records the deviation; the CI file carries the reason.

- 🟢 **`ELECTRON_SKIP_BINARY_DOWNLOAD=1` is set in CI** and must be removed at M3, the first
  milestone that starts Electron. Until then it saves ~150 MB per run for a binary nothing runs.

### Window checks found failing on 2026-09-24

- 🟡 **Two window checks fail on `main`, before and after that day's change.** Found while
  looking for a tag bug that did not reproduce; not investigated. `check-eagle.mjs` fails 3 of
  32 under *A judgement made here survives the next import*: the rated item is not found by name
  (`id=null`), so the rating and note checks after it read nothing. It may be the check rather than
  the importer: the `preserved=3` report beside them passes. `check-folders.mjs` stops after
  *Dragging assets onto a folder* with `never settled: document.querySelectorAll('.cell').length`.
  Both need a first look at whether the script or the window is what changed.

### A zoom per view (ADR-0039 §10) — built 2026-09-25

- 🟢 **`[` and `]` are in the keyboard map and bound to nothing.** `UI_SPEC.md` §9 has listed them
  as *Zoom cells down · up* since M3, and the zoom is reached only through the view menu. Found
  while giving each view its own zoom, and not bound then because nobody asked for it: it is one
  handler in `App.tsx` beside `Ctrl+1..3`, with the same typing guard, calling the menu's `onZoom`.

### Importing an Eagle library (ADR-0032) — built 2026-09-06

- 🟢 **The folder structure itself is to be revisited**, at the user's word on 2026-09-06: *"nanti
  diperbaiki lagi struktur foldernya supaya lebih baik."* Nothing specific is asked for yet, and
  nothing about the Eagle import depends on it — a folder is a folder in both products, subfolders
  included. Written down so the intent is not lost, not as work to start.

- 🟢 **The survey does not report formats with no thumbnail**, though an earlier draft of the ADR
  said it would. Knowing that means probing every file, which is what the import does anyway; a
  survey that costs an import is not a survey. The ADR now says so.

- 🟢 **`--dry-run` opens no Roost library**, so it answers "what is in this Eagle library" before
  there is anywhere to put it. It is the only subcommand of `import` that does not need one.

### HEIC photographs (ADR-0040, 2026-09-10)

- 🟢 **Only the Fedora install line is verified.** `install.ts` names a command per distribution
  from `/etc/os-release`; Fedora's two packages were run on this machine, and the Debian, Arch and
  SUSE lines come from each distribution's package index and have not been. An unrecognised system
  is told what it needs rather than given a command that may not exist. Worth checking one line at
  a time, whenever somebody has the machine to check it on.

- 🟢 **A rendition is made again every time it is asked for.** 0.19 s for a HEIC, `max-age=3600`,
  nothing stored. Caching them in `index.db` would be megabytes each and a derived column for
  `rebuild` to worry about (invariant 1). Revisit if the pane ever feels slow on a slow disk.

- 🟡 **An HEVC video cannot be played in the window, whatever is installed.** Measured on
  2026-09-24 against Electron 43.4.1: `canPlayType` answers `""` for `hvc1` and `hev1`, with and
  without Chromium's VAAPI feature flags, and the binary carries VAAPI decoder delegates for H.264
  and VP9 and **none for H.265** — so no driver a person installs reaches it. The proposal, not yet
  written as an ADR or decided: a rendition streamed from the **system's** ffmpeg through
  `roost://render`, the way HEIC is drawn, with a seek restarting it at `-ss` (the transport is
  ours, ADR-0024). Needs measuring first: what a 4K HEVC clip costs this machine to transcode live.
  Until then the pane **says so** rather than playing the sound under nothing (`UI_SPEC.md` §7.3,
  2026-09-24).

- 🟢 **No HEIC encoding, and no animated HEIF.** Roost reads them and never writes one; a Live
  Photo's video half is a separate file on the phone.

### What could not be drawn (2026-09-10)

- 🟢 **A failure cannot be reached from the grid.** The list names files; it does not select them,
  because there is no term for "has no thumbnail" and inventing one is a grammar change
  (`DATA_MODEL.md` §1). Worth doing if somebody wants to trash or re-import the whole set at once —
  `is:undrawn` is the obvious spelling, and it would have to compile to a `thumbs` anti-join rather
  than to anything about the queue, which is derived state a rebuild empties.

- 🟢 **The test fakes still mint version 1 ids.** `fakeAsset` and `fakeDetail` build sixty-four
  hex digits, which is a content hash, and that is what let `fallbackFromRendition` match only
  hashes for as long as it did (`UI_SPEC.md` §7.1). Twelve characters of Crockford base32 would
  have failed the day version 2 arrived. A wide change — hundreds of assertions spell the id.

- 🟢 **A press on the ☰ once opened nothing, with a paused queue.** Seen once while writing
  `check-pause.mjs` on 2026-09-25, and not seen again in the runs after. The status bar re-reads the
  queue every 1.5 s, and the guess is a press landing on that re-render. The check presses up to
  three times rather than asserting a cause nobody has shown. If a person reports a ☰ that
  sometimes does not open, start here.

### Chrome the pictures have to live with (2026-09-07)

- 🟢 **The sidebar is a tab stop per row, not one per region.** `UI_SPEC.md` §10 asks for one tab
  stop per region with roving focus inside; walking the tab order in a real window on 2026-09-07
  took sixteen stops to reach the grid, eleven of them sidebar rows. Found while checking something
  else, and left alone deliberately — it is a keyboard-navigation change with its own shape, not a
  detail of the ring above.

- 🟢 **The comment rows carry the hover the chips just lost.** `.comment-actions button` and
  `.comment-moment button` override the base button's border and background but not its
  `--control-height` box or its `--space-4` padding, so each is a full control's worth of hover
  around a glyph — the same defect the tag and folder chips were reported for on 2026-09-07 and
  fixed. Left alone until somebody sees it, because the fix is one rule and the risk is guessing at
  a size nobody has looked at.

### Handing a file to another application (ADR-0034, 2026-09-07)

- 🟡 **Dragging out has been tried by hand on KDE Wayland only.** There it works: in the spike, and
  in the real window on 2026-09-25, where the user confirmed it. X11 and a GNOME session are the
  next two to try (ADR-0034 §6.4).

- 🟢 **A native drag shows no count.** The HTML5 drag's ghost says *3*; `startDrag` takes one
  picture. A picture with the count drawn on it would need composing in main.

- 🟢 **Dragging out of the preview pane.** One asset, and no internal drop to compete with.

- 🟢 **Copy image over a video copies nothing.** A frame of a paused video is a picture too, and
  the preview knows which one is on screen. It would want the frame drawn in the renderer and
  handed over as bytes, which invariant 12 forbids, or the engine to ask ffmpeg for the frame at
  that moment. Not asked for; written down so the answer is not rediscovered.

- 🟢 **Copy image off Linux is not measured.** It goes through `writeImage` there, because
  `image/png` is not a format the Windows or macOS clipboard names (ADR-0034 §5.3). Worth a paste
  into Paint the next time a Windows build runs.

- 🟢 **One format, chosen by the desktop.** Electron's clipboard holds exactly one custom format —
  `writeBuffer` clears what was there, measured rather than assumed — and GNOME's file managers read
  `x-special/gnome-copied-files` while everything else reads `text/uri-list`. `XDG_CURRENT_DESKTOP`
  picks. This is the only place in Roost that branches on which desktop is running.

### The folder tree in the sidebar (ADR-0033, 2026-09-06)

- 🟡 **`check-folders.mjs` cannot run to the end here.** Its `Dragging assets onto a folder`
  section fails at `no drag was intercepted; nothing started a drag` — on `main` too, so it is the
  harness or the platform and not the pane. Everything after it therefore goes unchecked on this
  machine, which is why the folder-menu section added on 2026-09-09 was run by trimming the drag
  sections out of a copy. Worth looking at next to ADR-0034 §4, which is about a drag as well.

- 🟡 **A filtered grid still does not drop an asset that stops matching**, except for
  `Ctrl+Delete`, which now drops the rows itself (`paging.drop`). The general case is the note on
  `revision` in `App.tsx`: the grid re-pages only when the library's counts move, so removing a tag
  while looking at `tag:wip` leaves the asset on screen — the same bug, one gesture over. The fix
  is the same shape and wants the window to know what the query is about.

- 🟡 **Expansion does not survive the window.** It belongs in `settings.json` in the library
  (ADR-0019), which since 2026-09-08 **exists** — so this is now a field and a call rather than a
  file to design. Until then every window opens collapsed, which is right for a first look and
  wrong for the fifth.

- 🟡 **Still no reordering.** `sort_order` is unset and unsettable, so siblings are alphabetical and
  a drag *between* two rows means nothing. That is what `sort_order` is for and the one part of this
  that needs a journal op.

- 🟢 **No keyboard on the tree.** Arrow keys do not move between rows and `←`/`→` do not fold a
  branch. The rows are buttons in a list, so `Tab` reaches them and `Enter` picks one, and every
  drag has a menu item behind it (**Move to top level**) except moving a folder *into* another —
  which is a picker rather than a menu item, and is not built.

### The folders an asset is in (2026-09-06)

- 🟢 **The window still cannot create, rename, move, or delete a folder.** Those are the sidebar's,
  and the sidebar draws what it is given (see the item below it): the folder menu offers the tree
  and says *This library has no folders yet* when there is none, which is honest and is a dead end
  until `folder_create` has a door. `roost folder create` is the only way to make one.

- 🟢 **No drag from the grid onto a folder row.** The gesture people reach for first, and it wants
  the sidebar's drag work (reorder and re-parent) rather than a second drop implementation beside
  it.

- 🟢 **A folder's count in the sidebar is a subtree count, and membership is not.** Detaching from
  `Design` leaves an asset that `folder:Design` still finds through `Design/Icons`, which is correct
  and will read as a bug the first time somebody hits it. The chips say exactly what the asset is
  *in*; the sidebar says what the query answers with.

### Running it from a checkout (2026-09-08)

- 🟡 **Nothing tells a user how to sync a library between machines.** `CONCEPT.md` §3 promises Roost
  will not break somebody's Syncthing or Nextcloud, and the two rules that make that true are
  written nowhere: `index.db` has to be excluded from the sync — it is WAL-mode SQLite, and it is
  derived, so invariant 1 means a rebuild replaces it — and the single-instance lock lives under
  `$XDG_STATE_HOME` rather than in the library (deliberately: the binding layout has four entries
  and a lock is not one), so it is **per-machine** and cannot stop two machines opening one synced
  library at once. The journal is append-only, so that collision is a conflicted copy and lost
  lines. A short section in `SETUP.md`. Nobody has hit it — the user's machines keep separate
  libraries — which is exactly why it should be written before somebody does.

- 🟡 **The Start Menu shortcut declares no `AppUserModelID`.** Linux's half of this is deliberate
  and measured — `StartupWMClass=electron`, so the window groups under its own icon — and Windows
  has no equivalent anywhere: `setAppUserModelId` appears nowhere in the tree. Windows derives an
  ID from the target path when a shortcut declares none, and that target is `electron.exe`, so a
  pinned shortcut and the running window are liable to be two taskbar buttons. The fix is
  two-sided — `app.setAppUserModelId()` in main, and `System.AppUserModel.ID` on the `.lnk`, which
  `WScript.Shell` cannot write and `IPropertyStore` can. **Measure it against a real window before
  writing it down**, the way `StartupWMClass` was: an unpackaged Electron has surprised this
  repository on exactly this question once already.

- 🟡 **A launcher goes stale when the checkout moves.** Every path in the desktop entry and in the
  shortcut is absolute, and `pnpm refresh` never touches either, so renaming or moving the
  directory leaves a menu item whose only symptom is that clicking it does nothing. Rewriting the
  launcher at the end of a refresh **when one already exists** is idempotent and closes it; writing
  one that was never asked for is not, so the check is for the file rather than for the platform.

### Engine (M1)

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

- 🟡 **Linux packaging carries libvips and must not carry GLib** (ADR-0013). M6. Bundling GLib
  recreates the exact collision this decision avoids. Flatpak gets this right from its runtime;
  an AppImage or `.deb` has to be checked rather than assumed.

- 🟢 **BMP has no thumbnail here.** libvips 8.18.3 has no BMP loader; the Rust build's `image`
  crate did. A `.bmp` still imports and still carries tags. Pinned by a test so it stays a
  decision.

### Search and organize (M2)

- 🟡 **Error positions are string indices here, not byte offsets.** The Rust parser reports
  bytes; a caret in a text input is measured in UTF-16 code units, and a byte offset would point
  at the wrong character from the first non-ASCII character onward. `DATA_MODEL.md` §3 says
  "byte offset" and should be reworded when the search field lands in M3.

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

- 🟡 **A native dialog cannot be clicked by a script.** The folder chooser is answered by the
  fake bridge in a component test, and the twenty lines in main that open it are covered by
  nothing. That is the remaining gap in this flow, and an Electron end-to-end driver is what
  would close it.

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

- 🟡 **The sidebar draws what it is given and nothing more.** What `UI_SPEC.md` §4 describes and
  it does not do yet:
  - ☑ ~~**Collapsing folder branches.**~~ Done 2026-09-06 (ADR-0033). **Tag groups are still always
    expanded**, and a library with two hundred tags is still a very long pane — the same
    disclosure, one section over.
  - **Drag to reorder and re-parent** a folder. `moveFolder` exists and refuses a cycle; what is
    missing is the drag — and `sort_order`, which nothing writes (ADR-0033 §4).
  - **Ctrl-click to add a term** (§4.2). Clicking replaces the query; compounding needs the
    search field, because the compound query has to be visible and editable to be honest.
  - **The library switcher** at the top, and with it "Open library…" from inside an open
    library. It needs the recent-libraries list, which needs the application config that window
    state is also waiting for.
  - **Smart-folder match counts** (§4.1). Every read would run every saved query; the count
    arrives with the search field's count, which is the thing that makes it cheap enough.

- 🟡 **The search field validates but does not suggest.** It became *legible* on 2026-09-08 — it
  rests at the head of the query and taking the focus puts the caret at its end (`UI_SPEC.md` §5),
  from the user asking how to reach the end of a long folder path without typing it. That answers
  reading a long query, not writing one; the list below is still what would answer writing one.
  What `UI_SPEC.md` §5 still describes:
  - **Autocomplete**: field names first, then values once a field is typed — `tag:` offers tags,
    `folder:` offers folders, `ext:` offers the extensions actually present. The vocabulary is
    `@roost/search`'s (`FLAGS`, `NAME_FIELDS`, `NUMERIC_FIELDS`) and the values are the
    library's, so it is one more request rather than a table in the renderer. The *list* is
    solved: the inspector's tag field (`TagField`, `UI_SPEC.md` §3.7, 2026-09-06) is the same
    highlight-and-Enter listbox, and what it does not have is the one thing this needs — a
    vocabulary the sidebar does not already carry.
  - **Chips**, as an optional view of the parsed AST. The string stays the source of truth,
    which means the engine has to hand back the AST as well as a verdict.
  - **Save as smart folder** from the field, which is where a saved query naturally comes from.
  - **Ctrl-click a sidebar row to add a term** (§4.2). It belongs here rather than in the
    sidebar: the compound query has to be visible and editable in the field to be honest, and
    joining two queries with an implicit `AND` is grammar work that belongs in `@roost/search`.

- 🟡 **The window imports by copying, with no tags, and cannot say otherwise.** The request
  carries both — the CLI has `--take` and `--tag` — and what is missing is where to put them:
  **move or copy** is a per-run choice a person should see (RL-26 requires the report say which
  happened, and the window's report does not), and the tags want an import dialog that does not
  exist yet. Restated 2026-09-21: `--mode managed|referenced` became `--take copy|move` with
  ADR-0046, which changes the question from *where do the bytes live* to *what happens to the
  source*, and makes it more worth asking rather than less.

- 🟢 **`check-filters.mjs`'s facet-menu section is flaky.** Twice in nine runs on 2026-09-08 it
  failed to find a value in an open Tags menu — *"Tags has no olahraga"* once, *"never settled"* on
  `traveling` once — and passed on the next run with nothing changed. Both were in the sections that
  open a facet whose list is long enough to carry a search field. It is a defect in the check or a
  race in the menu, and until it is known which, a red run there means run it again before believing
  it.

- 🟢 **The preview says `aria-modal="true"` and is not modal.** `UI_SPEC.md` §7 keeps the sidebar and
  the inspector live while a file is open, deliberately — both are still about the thing on screen —
  and a click in either now reaches the window (the item above). But `aria-modal` tells a screen
  reader that everything outside the pane is inert, which is then a lie: the two panes it hides are
  the two that still work. Noticed 2026-09-08 while fixing that. It is either the attribute that
  goes or the pane that becomes a real dialog, and the first is the smaller claim.

- 🟢 **Trashing the file that is open leaves the pane drawing it.** The same family as the fix
  above, and left alone deliberately: `onGone` clears the selection, the ring survives, and the pane
  goes on serving a trashed asset over `roost://file/`. Unlike a query, a trash has two
  defensible answers — close the pane, or step to the next asset the way the arrows do — so it is a
  decision rather than a patch. Noticed 2026-09-08.

- 🟢 **A folder is reached by typing its whole path, or by clicking it.** Two ideas were put to the
  user on 2026-09-08 beside the one that was built. **Descending** was answered on 2026-09-13 by
  ADR-0043 instead — the subfolders are drawn in the grid — so what a **breadcrumb over the grid**
  would still add is the *ascent* and the sense of where one is, which `Alt+↑` now does without any
  chrome. It remains a *view of the query* exactly as the filter bar is (ADR-0035), so it still
  needs an ADR and a place in `UI_SPEC.md` §6. And **matching a path from its
  tail**: `folder:"SINTANG/Kelas 12"` finds nothing today, because a multi-segment path has to be
  exact from the root while a bare name matches anywhere (`library/search.ts`). Widening it to a
  suffix would follow the rule already there — the exact path wins, and the fallback can only
  broaden — but it changes what a *saved* smart folder's query means, so it is a decision rather
  than a patch.

- 🟢 **The tag facet has no Untagged row.** Eagle's has one, `is:untagged` is in the grammar, and it
  would sit beside the tags exactly as unrated sits beside the stars (ADR-0035 §7). The pane still
  carries **Untagged** as a place, so nothing is unreachable; what would change is that it could be
  combined with a rating or a type. Not asked for.

- 🟢 **`kind:` is not in the grammar.** The filter bar's Types facet offers extensions, which is
  what the user chose when asked (ADR-0035 §3.4 and §6): `ext:` exists, and Image / Video / Audio /
  Document would be a new term in a grammar frozen by compatibility. Nothing decided in ADR-0035
  would have to move to add it — the facet's values would simply be kinds instead — so this is a
  note rather than a gap.

- 🟡 **A filtered grid does not re-page when an edit changes what matches.** The window keeps
  two counters: a library `generation`, which throws the grid's pages away, and a `revision`,
  which every derived read follows. Without the split, one keystroke in the note field would
  re-page the grid from row one and throw the scroll position away — but the cost is that
  tagging the asset under `is:untagged` leaves it on screen until the query is re-applied. The
  fix is a targeted update (drop the row, keep the scroll), not a reload. A **changed asset
  count** does re-page, because "the library went from empty to twelve" is a visibly wrong grid
  rather than a stale one.

- 🟢 **The grid's frame budget is asserted by construction, not measured.** The re-render count
  is a test, and the layout is a binary search per column; neither is a frame percentile. The
  scroll benchmark mode is what turns this into a number, and it is still an M3 item.

- 🟢 The app icon. `roost-old` shipped a flat generated square and never replaced it.

### Back, forward and up (ADR-0044, asked for and built 2026-09-13)

- 🟡 **The window check that is owed for the tiles owes these three too.** Two of the claims are
  ones no component test reaches: that a **`Backspace` in the search field still deletes a
  character** rather than navigating — the guard is `isTyping`, and happy-dom will agree with
  whatever the code says because no real focus is involved — and that the trail survives the
  preview opening and closing over it. Cheap to add beside the tiles' check rather than as a
  fifteenth script of its own.

- 🟢 **The buttons say where they go and not what is there.** Explorer's Back has a dropdown of
  the last several places, and a long press opens it. Not asked for, and it wants a menu whose
  rows are places rather than queries — which is exactly what the trail holds, so it is a small
  thing to add if somebody ever wants it.

- 🟢 **A place is recorded when the split arrives, not when the query changes.** One round trip
  behind, therefore, and the recorder can only run after the engine has read the query. Nothing
  visible depends on it — the buttons enable a frame later than the grid changes — but it is why
  a test has to `waitFor` the button rather than assert straight after a click.

### Folders in the grid (ADR-0043, asked for and built 2026-09-13)

- 🟢 **The drop outline on a folder tile has no window check.** `check-folder-tiles.mjs`
  (2026-09-25) covers the other two claims in ADR-0043 that only a window can make: a double-click
  opens the folder without landing a preview on it, and the tiles are laid out rather than
  overlaid. The outline is written to the element during a drag rather than rendered, and a
  synthetic drag is what `check-folders.mjs` already fails on (see *Window checks found failing*).

- 🟢 **A tile cannot be dragged, only dropped onto.** Re-parenting a folder by dragging it onto
  another is the tree's gesture (`UI_SPEC.md` §4.3) and `folder:move` is already wired; ADR-0043
  §5 leaves it there rather than requiring it. What the grid refuses is a folder id travelling as
  an asset payload, which is the part that would be a bug.

### Showing and hiding the side panes (ADR-0028 §6, asked for 2026-09-13)


- 🟢 **`settings.json` is safe against one window, not two.** `writeSettings` now chains its
  read-modify-writes per library (ADR-0028 §6.5), which removes the race a single window could lose
  with two keystrokes. Two windows onto one library are two engine processes and two chains: the
  last writer still wins the whole file. Nobody has seen it, and it wants a lock or a merge rather
  than a bigger queue.

### Settings, windows, and the picker (ADR-0019 and ADR-0020, decided 2026-08-30)

- ☑ ~~**The recent-libraries list, and with it the first application state file.**~~ Done
  2026-08-30: `stateDir()/recent.json`, written atomically, tolerant of absence and damage, with
  pinning and forgetting. `UI_SPEC.md` §3.1 is the design of record. **It has not been seen in a
  real window** — an Electron instance from an earlier session held the single-instance lock, so
  every attempt to drive a fresh one exited immediately, which is `main.ts:65` working exactly as
  written. The component and the wiring have tests; the pixels are unverified.
  - ☑ ~~**A row marked Missing could not be clicked.**~~ Fixed 2026-09-10: the mark is a `stat`
    taken when the list was read, and the commonest reason for it is an unplugged drive — so the
    row now asks again, and a failed retry re-reads the list rather than leaving the row looking
    opened. `library_not_found` tells "the path is not there" from "this folder holds no library".
  - 🟢 **Re-read the list when the window regains focus.** A drive plugged in while the picker is
    on screen leaves its rows struck through until something asks again. Offered on 2026-09-10 and
    not taken: the retry covers the case it was for, and this is the tidier half.
  - 🟢 **The CLI does not record into it.** Deliberate but not obviously right: `roost init`
    creating a library is a deliberate act and belongs on the list, while `roost query` in a
    script rewriting a state file is not. If it lands, the rule is "init and open record; reads
    do not".

- ☑ ~~**The player opened at full volume, every time.**~~ Fixed 2026-09-10 (ADR-0024 §9,
  **proposed**): a media element starts at `volume = 1` and the pane makes a new one per asset, so
  the level and the mute now come from `settings.json` and go on in the element's ref callback —
  before an `autoPlay` clip whose bytes are cached can be heard. Held in `preview/sound.ts` rather
  than in the window's state, because a slider drag is a change per pixel.
  - 🟢 **Nothing else uses the store yet.** If a second window-wide media preference appears
    (a remembered playback rate is the obvious candidate, and was not asked for), it belongs there
    rather than in another singleton.

- 🟡 **`Ctrl+N` — a second window onto the same library** (ADR-0020). `broadcast()` is already
  plural and `createWindow()` already exists; what is missing is the command and per-window
  geometry in `stateDir()`. Switching library moves every window: a window is a view, not a
  session.

- 🟢 **Several libraries at once is refused, not forgotten.** If it is ever wanted, it starts at
  the protocol: `roost://thumb/<hash>@256` names no library, so two open libraries make the URL
  ambiguous. That is an ADR-0008 amendment, several read-only handles in main, and an engine
  story. Written down so the cost is not rediscovered.

### The asset context menu (2026-08-31)

- 🟡 **Rating, favourite, and tags are not in the menu.** They would need the selection summary
  the inspector already fetches, which is a round trip on every right-click. Worth doing, and
  worth doing after trash rather than instead of it.

- 🟡 **"Open with…" is not "Open".** The user asked for a chooser; `shell.openPath` gives the
  desktop's default. A real chooser has no Electron API and would mean reading `.desktop` files
  and `mimeapps.list` on Linux with nothing shared by the other two platforms — an ADR, not a
  menu item.

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

- 🟡 **The grid re-pages on a trash rather than dropping the row.** `readStats` now compares the
  trashed count as well as the asset count, so trashing does invalidate the pages — but it
  invalidates *all* of them and the scroll position goes with them. That is the same targeted-update
  gap §M3 already carries, now reachable one gesture sooner.

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

**The wall this met is gone.** Until 2026-09-21 identity was the content hash, so "edit this
file" could not mean here what it means in a file manager: changed bytes were a *different asset*,
a different path, a different row, and ADR-0026 existed to say what that meant. **ADR-0046
removed the premise.** Identity is a minted id (RL-13), a file in `files/` is expected to change
(RL-20), and everything about the bytes is derived rather than journalled (RL-23) — so a save is
an ordinary write, and `supersede`, `superseded_by`, `is:superseded` and `carryOver` are all
gone. What is still true is the 2026-09-04 withdrawal: **no text editor in the window**, because
an external one is enough.

- 🟢 **A text asset has no thumbnail**, so it fails its derive job with `unsupported:text` exactly
  as a `.zip` does. Unchanged behaviour — it was `unsupported:unknown` before — but now that text
  is a kind, rendering the first lines into a thumbnail is a thing that could be done, and the
  grid would stop showing a wall of identical extension badges. Not scheduled; written down so it
  is a choice rather than an oversight.

- 🟢 **Closed 2026-09-21 by ADR-0046: adopting a referenced asset.** There is no referenced
  mode to adopt out of — version 2 has one storage mode (RL-19). The question is gone rather than
  answered, which is worth the line so nobody reopens it.

- 🟢 **Closed 2026-09-21 by ADR-0046: moving a `.srt`'s attachment when it is edited.** It was
  the first evidence that "an edit is a new asset plus a fix-up of everything that pointed at the
  old one" would have to become a rule the whole schema follows. It does not: an edit keeps the
  id, so nothing points anywhere new, and `carryOver` was deleted along with `supersede`.

- 🟢 **Closed 2026-09-21 by ADR-0047: noticing an external save.** The watcher over `files/`,
  the catch-up sweep at open, RL-9b's rename and the `<id>.*` fallback are built and covered by
  `packages/library/tests/workspace.test.ts` and `scripts/check-workspace.mjs`. *Open with…* was
  already there and had been since M3 — the gap was never opening the file, it was everything
  after Save.

- 🔴 **Watched roots are still journalled and inert.** `watch_add` and `watch_remove` replay into
  `watched_roots` and conform, and **nothing acts on them**: no CLI command writes one, no UI
  offers one, and no daemon imports from one. The registry says plainly that nothing has to —
  *"an implementation that catches up when the library opens is conforming"* — so this is a
  feature rather than a gap in conformance. It carries one design question ADR-0047 §5 declined
  to answer badly: **what happens to a file in a watched root that fails to import.** Held back
  deliberately on 2026-09-21, at the user's choosing: engine first, to a green suite.

- 🟢 **A rename in the window does not rename the file on disk.** RL-9b is implemented in the
  direction that matters — the file's *type* changing — but `asset_rename` deliberately touches
  nothing under `files/` (RL-9: the name a person gave lives in the journal, the file is named by
  its id). Written down because "rename-on-disk" reads like something that is missing and is not.

### Format breadth (M4) — done 2026-08-29

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

### The derive queue under load (2026-09-23)

Measured when the user asked whether *Deriving… N to go* slows everything down
(`BENCHMARKS.md`, 2026-09-23). Built that day: one claim per free worker instead of a batch,
what is on screen first (`derive:wanted`, sent by main on a thumbnail miss), and the queue's
claim and counts made cheap at a million. What is still open:

- 🟡 **A video or an audio file costs the engine's event loop two synchronous spawns**, ~5.5 ms
  each. p99 of a grid page is 17–27 ms while sixteen clips derive, against ~1.5 ms idle. The
  lever is spawning from a worker thread, whose loop can block without the engine noticing; an
  environment snapshot was measured and saves 0.4 ms of the 5.5, so it was not done.
- 🟢 **BLAKE3 runs on the engine thread**: 564 ms per 1.2 GB, in 256 KB slices. Throughput
  rather than a stall, so it does not show in the page latency — but it is the next thing a
  worker thread would take.
- 🟡 **Two open-time passes, measured at 100k on 2026-09-24** (`BENCHMARKS.md`). The watcher
  that was costing 1.4 s of every open is fixed (ADR-0047 §10); these two remain.
  `enqueueMissing` is **~200 ms before the reply**, on every open, in a library where nothing
  has a thumbnail — every row reaches the `ON CONFLICT` of a job already queued. That is about
  2 s at a million. It would be cheaper to skip assets that already have a job, or to run it
  after the first page has gone out. `catchUp` is **7 s** at 100k and not awaited (worst loop
  gap 7 ms), but it runs alongside the first pages the window asks for.
- 🟡 **Import measured 270 files/sec on 2026-09-24** — 100,000 fixture files in 6 min 15 s,
  below `CONCEPT.md` §7's floor of 300 and far below the 2,178/sec recorded before format 2.
  Found while building a library to measure opening, not investigated. The report's own stages
  (indexing 4.8 s, walking 0.8 s) add up to a fraction of the wall time, so the time is going
  somewhere they do not count.
- 🟢 **`check-derive-order.mjs` is not in `pnpm verify`**, like every other window check. It is
  also the only one that needs a threadpool of one to be meaningful, and says why.

### Thumbnails in a database of their own (ADR-0051, 2026-09-26)

- [x] `thumbs/roost.db`, attached as `pictures` by the engine and by main's read-only reader;
  migration 0002 copies the pictures across and drops them from `index.db`, then `VACUUM main`
  once. `sources` records what each asset's pictures were drawn from.
- [x] A rebuild keeps the pictures, and the derive after it keeps every one whose file is unchanged:
  `kept` in `DeriveReport`, `roost thumb` and `roost rebuild` say so. 4.93 s → 0.20 s on 1,000
  photographs (`BENCHMARKS.md`).
- [x] The cleaner: `applyRemove` takes the pictures, `prunePictures` runs after every fold and from
  Reclaim space, which then hands the pages back with `incremental_vacuum`.
- 🟢 **`doctor` does not report orphaned pictures, or the pages Reclaim space would return.** They
  are pruned after every fold and by `--reclaim`, so nothing accumulates, but the report's
  *reclaimable* figure counts `files/` alone and undersells what the button will free.
- 🟢 **No window check covers a rebuild.** None could before either, because the window has no
  rebuild gesture. What ADR-0051 changes is visible only as a grid that stays drawn after
  `roost rebuild`, and `import.test.ts` asserts that at the engine.

### Moving assets between libraries (ADR-0054, 2026-09-27)

- [x] `transfer.ts` in `@roost/library`: copy into the target, journal there, attach subtitles, then
  remove from the source for a move. Folders by path, duplicates merged by ADR-0032 §8's rule,
  tracks that also caption a video staying behind are copied. 15 tests in
  `tests/transfer.test.ts`, including a re-run after an interrupted move and a rebuild of the
  target.
- [x] `assets:transfer` in the contract and the engine, **Move to library ›** and **Copy to
  library ›** in the grid's context menu (`UI_SPEC.md` §3.3), `roost move` and `roost copy`.
- [x] **A long transfer has a progress bar, and × stops it** (ADR-0054 §3.9, asked for and built
  2026-09-27). Bytes, not assets: a counted copy in `FileStore.put` and `onBytes` in `hashFile`.
  The user chose that a stop keeps what arrived. `Ctrl+C` does the same in the CLI.
- 🟢 **A transfer reads each file twice**, once to hash it and once to copy it. On a spinning
  source disk that is most of the time a large move takes. Hashing while copying would halve it,
  at the price of a wasted write when the target turns out to have the file already. That trade
  wants measuring on a hard disk first (`BENCHMARKS.md`, 2026-09-27).
- 🟢 **The large-file turn (64 MiB) is a guess.** It is reasoned from how a hard disk seeks rather
  than measured. Worth a run with a few multi-gigabyte files onto a real hard disk.
- 🟢 **The target draws its thumbnails again.** They are in the source's `thumbs/roost.db`, keyed
  by the old id, and a transfer could copy them across with their `sources` row. Today the target's
  derive queue redraws them the next time it is opened.
- 🟢 **No window check drives a transfer.** It needs two libraries in the recent list and a
  submenu opened over CDP. The component tests cover the menu against the fake engine, and
  `serve.test.ts` the request against a real one.

### The library format

- 🟢 **An open folds the whole journal, not the part it has not seen.** The mark `index.db` keeps
  is the byte length of each month file, so the records past it could be read alone — the journal
  is append-only, and a fold that seeks to an offset and reads forward would turn a stale-cache
  open from *rebuild time* into *the size of what changed*. Correctness is there and this is not;
  it matters the first time somebody keeps a million-asset library on a drive two implementations
  share. ADR-0045 §6.

- 🟢 **Every existing library folds once**, on its first open after ADR-0045, because no `index.db`
  yet carries a mark. Thumbnails survive it — the fold does not empty the index — but a large
  library will open slowly exactly once. Nothing to do; written down so the next person to see it
  does not go looking for a bug. **Moot as of 2026-09-21**: no library that predates ADR-0046
  opens here at all.

- 🟢 **The reserved-names rule forbids what SQLite always writes.** RL-3 forbids unlisted names in
  the library root, while SQLite in WAL mode always writes `index.db-wal` and `index.db-shm`
  beside `index.db`. They are plainly part of the cache the format puts outside itself, and the
  requirement does not say so. **Ours to fix since ADR-0052**, as a document revision (2.1) in
  `docs/FORMAT.md`. The other finding that stood here, a `.gitattributes` that protected nothing, is
  closed: this repository's own now exempts `conformance/`.

- 🟢 **Two questions the format leaves open, and what this build does about them.**
  `FORMAT.md` §11.1 — *does removing an asset delete its file?* — is open; this build **deletes**,
  as ADR-0031 decided, and version 2 raises the stakes because an orphan in `files/` is now
  something RL-11 and RL-12 both have opinions about. §11.4 — *does a tag with no assets
  survive?* — is open too; this build **keeps** it. Since ADR-0052 both **can** be settled here, as
  a document revision. That is a choice worth making deliberately, not a chore.

- 🟢 **The portable-`referenced` question went away.** It was open in version 1's §11.1 and this
  implementation was forbidden from inventing source roots while it was. Version 2 has one
  storage mode, so there is nothing to make portable.

### Deferred by design

- 🟢 **Journal compaction.** The journal grows monotonically. ADR-0003 leaves compaction out of
  v1 deliberately; revisit only with measurements, and only as a new rotated file.

- 🟢 **Closed 2026-09-21 by ADR-0046: the partial-to-full hash upgrade, and byte-verifying a
  referenced duplicate.** Both were consequences of the hash being the primary key. It is not,
  there is no partial scheme, and there is no referenced mode — three entries collapse into
  nothing to do.

- 🟢 **Version history is undefined in the format** (`SPEC.md` §11.2) and `versions/` is reserved
  against the day it is not. Editing in place leaves no record that an edit happened (RL-23), so
  a history would need an operation, and **nothing here may invent one**. Written down because
  losing the previous bytes is the obvious cost of the workspace model and somebody will ask.

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
  - **Partly overtaken on 2026-09-11**, when the work moved to a Windows machine and
    `pnpm verify` was made to pass there: 91 files, 1234 tests, 23 skipped. **ADR-0041** ports
    `platform/dirs.ts` to the known folders and is *proposed*, not accepted. Two claims below did
    not survive contact. `reveal.ts` has **no runtime caller at all** — `asset:reveal` and
    `asset:openExternally` are answered in main by Electron's `shell`, which is portable, and the
    CLI never calls it — so the port is one module and a dead one. And `build-sharp.mjs` already
    skips a non-Linux platform; only the `start` script's Linux flag was real, and `dev.mjs` now
    passes it on Linux alone. What the port still has no answer for is below.
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
    `FileStore` falls to a plain copy, so the placement reported is the placement that happened
    (ADR-0012); ffmpeg is absent gracefully (ADR-0017); pdfium and resvg are WebAssembly;
    and the GLib collision ADR-0013 was written for cannot happen where there is no system GLib,
    which is why the prebuilt `sharp` is the right one there.
  - **Two small things would break the install rather than the app.** The unconditional
    `postinstall` running `scripts/build-sharp.mjs` has to skip a platform that wants the
    prebuilt, and `--ozone-platform-hint=auto` in the `start` script is a Linux flag.
  - Packaging targets, signing, and whether ffmpeg is bundled are an ADR of their own when the
    milestone arrives — the same question M6 answers for Linux, asked again.

- 🔴 **The `roost-old`-written `index.db` fixture is gone, and nothing here can rebuild it.**
  `packages/core/src/db/__fixtures__/rust-written-index/index.db` was destroyed on 2026-09-12 by
  the `node_modules` deletion described in `SETUP.md` §1, and it was never recoverable from git:
  `.gitignore` carried a blanket `index.db` rule, so the one `index.db` in this repository that is
  *evidence* had been untracked all along. The rule now has an exception for exactly that path, and
  `cross-implementation.test.ts` says what is missing instead of reporting a bare ENOENT — but the
  two tests in it fail until the file comes back. **It cannot be regenerated here by construction**:
  its whole claim is that a file this build did not write opens without migration at
  `schema_version` 5 (see the fixture's README). It has to come from `../roost-old`, or from a
  backup of this checkout. Everything it guards — that migrations 0001–0005 are the same
  migrations, that no column has been renamed out from under a library written by the Rust build —
  is unguarded until then.

- 🟢 **Closed 2026-09-21 by ADR-0047: libvips keeping the file it read mapped.** Raised as a 🟡
  on 2026-09-11, when it was a test-cleanup annoyance; under version 2 it was **RL-21 failing**,
  which is the requirement the whole workspace rests on. `sharp.cache({ files: 0 })` is set once
  at `decoder.ts`'s module load, measured first as `CLAUDE.md` §8 requires: 1463 ms against
  1478 ms over 120 files, which is noise, because the derive path reads each file once and never
  again (`BENCHMARKS.md`). It also fixed `derive.test.ts`'s animated GIF, which had been the one
  failing test in the suite on Windows. The knob is `sharp.cache({ files: 0 })`, which is a performance
  change and therefore wants a measurement rather than a guess (`CLAUDE.md` §8). Invisible on Linux.

- 🟡 **`roost import` says nothing when a path it was given does not exist.** Measured 2026-09-13:
  `roost import C:\definitely\not\here` prints *"Imported 0 of 0 files scanned"* and exits **0**,
  for a file and a directory alike. `discover()` skipping a source it cannot read is deliberate and
  right — one unreadable directory in a list of ten must not lose the other nine — but nothing
  above it tells the person that the path they typed was that source. The fix belongs at the top of
  the import rather than in the walk: stat the named sources first, name the ones that are not
  there, and exit **2** when none of them is, which is what that code means (`SETUP.md` §3). It is
  easy to meet by accident, because `pnpm --filter @roost/cli start -- import assets/brand`
  resolves the relative path against `packages/cli` rather than the directory it was typed in.

- ☑ ~~**ADR-0042's implementation is not in the working tree.**~~ Found missing 2026-09-13 — the
  ADR and `scripts/check-install.mjs` were here and nothing they described was, which session 69
  records as built and passing 9 checks, making it a loss rather than a plan — and **rebuilt the
  same day** from the ADR and from what the check script asserts: `installer.ts`, `InstallOffer`,
  `adoptUserPath()`, `capability:install` through the contract, the engine and the renderer, and
  `installable` on the wire. Its open child is below.
- 🟡 **`scripts/check-install.mjs` has still never been run.** Not on Linux, where the rebuild was
  not done, and not here: its fixture encodes a clip with a **real** ffmpeg before hiding it from
  the engine, and this machine has none — which is the thing the button exists to install. So the
  offer is covered by unit tests and by the ADR, and the round trip it is really about — renderer
  to main's allowlist to the engine to a spawned process and back — is asserted nowhere yet. Run it
  on a machine that has ffmpeg, which is also the only machine where its one click is a refusal
  rather than an install.

- 🟡 **`pnpm install` fails on Windows unless build scripts are skipped.** `allowBuilds` in
  `pnpm-workspace.yaml` makes pnpm run an implicit `node-gyp rebuild` for `better-sqlite3` — which
  ships `prebuilds/` for every platform and sets `"gypfile": false` precisely to stop that, so on
  Windows it demands Python and MSVC to build a binary it already has. `--ignore-scripts` is the
  workaround in use, and `scripts/refresh.mjs` passes it there so that a machine which only uses
  Roost never meets this — at the cost of also skipping Electron's `postinstall`, which that
  script then runs itself. **Removing the entry would fix the install everywhere and change which
  binary Linux loads**, from a source build to the shipped prebuild, which is exactly the class of
  silent substitution ADR-0013 exists about. Not a decision to take on one platform's evidence.

- 🟢 **`pnpm` has to be on `PATH` for `pnpm verify` to work**, because the script calls `pnpm`
  four times. Running it through `corepack pnpm` without `corepack enable` gets past every direct
  command and fails inside `verify` with *"'pnpm' is not recognized"*, which reads as a repository
  problem and is not one. `corepack enable` needs an administrator shell on Windows.

### The window's own scrollbar (2026-09-10)

- 🟡 **A larger overflow in the reporter's own library is unexplained.** Their two screenshots
  put the viewport's thumb at ~81% and ~53% of its track, which is ~220px and ~700px of overflow
  — far more than the button's half pixel, and invisible: the region below the frame is bare
  `--bg`. Not reproduced here. Every interaction that leaves something behind was driven against
  that library and against fixtures — menus, dialogs, the preview, a drag, the tag suggestions,
  resizing — and the frame stayed exact. The library is on a removable drive that was unmounted
  before it could be measured again. Clipping means it can no longer be *seen*; it has still not
  been *found*, so the next sighting wants the culprit read off `check-failures.mjs`'s expression
  in a live window.

### Flakes

- 🟡 **`check-grid.mjs` and `check-folders.mjs` fail on their synthetic drags on Windows.**
  Seen 2026-09-21 after the format-2 port: the marquee section reports no sweep and the folder
  check reports *"no drag was intercepted"*, while every other window check passes — sandbox,
  trash, journal-notice, about, failures, panes and filters are all green. Probes driven through
  the same harness proved click selection, the fills and the drop targets all work in a real
  window, so the failure looks to be in the **synthetic pointer sequence CDP dispatches** rather
  than in the grid, and nothing in the port touched drag handling. It wants either a Linux run to
  confirm the platform split or a reworked gesture in `scripts/lib/`; until then a red run there
  means checking it by hand before believing it.

  **The Linux run happened on 2026-09-22, and it does not confirm a platform split.** Both scripts
  still fail, and neither fails where it did on Windows. `check-folders.mjs` gets **through** the
  whole *Dragging assets onto a folder* section — the ghost's size, the add from `All assets`, the
  folder's count — and stops later, where clicking the `Aardvark` row should leave one cell in the
  grid (line 694). `check-grid.mjs` gets past the keyboard ring and stops in `clearSelection`,
  which clicks the scroller's own padding at `grid.top + 3` and waits for the selection to empty.
  So the synthetic pointer sequence is **not** the common cause: the drags work here. That leaves
  two separate failures rather than one, both ahead of where Windows stopped, and neither
  diagnosed — this run was a bystander to `pnpm start` work rather than an attempt to fix them.

- 🟡 **`check-workspace.mjs` flaked on a first-ever cold start.** Seen once on 2026-09-22, on the
  first Electron start in a fresh container: it timed out waiting for the thumbnail's address to
  change after an external save, which it allows 15 s for (60 attempts × 250 ms). The next run
  passed all ten with nothing changed in between, and its log has the save noticed and worked
  inside a second — `file changed under an asset`, then a derive pass reporting `derived: 1,
  thumbnails: 1`. The comment above that settle calls its window *"generous on a busy machine"*;
  a first start, with every code cache cold and libvips loading for the first time, is the case it
  is not generous enough for.

- 🟢 **Fixed 2026-09-21: `derive.test.ts`'s animated GIF failing with `EBUSY` on Windows.** The
  test was never touched; `sharp.cache({ files: 0 })` was (ADR-0047 §4), and the suite went green.
  Worth keeping as a line because the failure had been recorded twice as "pre-existing, unrelated"
  and was in fact the first symptom of a requirement this build was breaking.

## 4. Lessons carried over — do not re-learn these

Each of these cost `roost-old` real time. They are written here rather than left in that
repository's session log, because a lesson nobody rereads is a lesson nobody has.

1. **CSS has no undefined-variable error.** A typo'd token silently drops the declaration. Only
   a build-time check catches it, and only a human found the bug it caused.
2. **End-to-end timing hides regressions that micro-benchmarks show as straight lines.** A 2.5×
   climb in paging cost read as noise for a day; the first bench run found it immediately.
3. **A filtered list query will sort its whole match set to produce one screen** unless the sort
   key is inside the filter index. 18.9 ms against 0.51 ms, on the most ordinary query in the
   app. The baseline schema's filter indexes carry the sort key for this reason.
4. **Keyset paging needs a tie-break column.** `imported_at` is not unique — a bulk import
   writes thousands of rows in the same second — and without the tie-break, paging shows an
   asset twice or skips it.
5. **A preview that does not move the selection writes notes onto the wrong asset.**
6. **A fact derived from the bytes must never reach the journal.** Version 1 journalled size,
   dimensions and link method, and none of them could survive a file being edited in place — the
   journal is append-only, so a fact written into it that later changes is a fact the rebuild
   will get wrong forever. RL-23 forbids it; the reason is worth keeping without the rule.
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
