# Roost — TODO

Everything known to be outstanding, in priority order. `ROADMAP.md` holds the milestone plan;
this file holds the working list, including the small things that surface during implementation
and would otherwise be forgotten.

Last reviewed: 2026-09-01. M5 and M6 are deferred at the user's request — feature work first,
and those two milestones get planned once the feature set has settled.

Legend: 🔴 blocks other work · 🟡 do before the milestone it names · 🟢 whenever

---

## 1. Needs a decision from the user

- ☑ ~~**ADR-0022 — what `Delete` means.**~~ Accepted 2026-09-01 and built the same day: trash
  marks the row and keeps everything hanging off it, **nothing is ever emptied on a timer**, and
  permanent removal stays `remove`. Migration 0007, the `trash`/`restore` ops, `is:trashed`,
  the Trash place, `roost trash`, and the window's `Delete` key all landed together.

**Nothing blocking.** The five questions the language change forced were settled on 2026-08-24,
before any code was written against them — ADR-0006 through ADR-0012, all Accepted. What they
decided is in `ROADMAP.md` §Decision status; what they now *oblige* is in §3 below.

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

- 🟡 **Video playback is still unverified against a real `<video>` element.** M4 closed half of
  this: `ffmpeg -f lavfi` fixtures are generated by the tests now, and a video's frame, duration,
  and codec are all asserted against real files. What no test does is *play* one — that needs a
  window, and nothing in CI opens one (below).
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
- 🟡 **Nothing in CI launches a window yet.** `scripts/check-sandbox.mjs` and
  `scripts/bench-window.mjs` both drive a real window and both are run by hand. They are not in
  `pnpm verify` because they need Electron's binary and a session that composites — which is
  also what `ELECTRON_SKIP_BINARY_DOWNLOAD` in CI is waiting for. The scripts exist; the job
  does not.
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
  - **Marquee selection.** Dragging on the background clears the selection today rather than
    sweeping one. The store has every operation it needs; what is missing is the drag.
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
- 🟡 **Video range requests are still unexercised by a `<video>`.** The preview asks for
  `roost://original/<hash>` and the protocol answers ranges down to the byte, tested both ways —
  but the thing they exist for is a player seeking, and there is still no real video fixture in
  the container (§2 above).
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
- 🔴 **Trash has not been seen in a real window either.** Everything below is a component,
  service, or CLI claim: 21 tests over the library, 15 over the menu, and the whole flow driven
  through `roost trash` against a real library on disk — trash, restore, rebuild, empty, and the
  journal lines checked by eye against ADR-0022. What none of that covers is the pixels: the
  Trash row and its count, the menu swapping its last item, the dialog's focus starting on
  Cancel, and whether the grid re-pages when an asset is trashed out from under it. **This is
  now three sessions in a row**, so it is a workflow gap rather than bad luck, and the first
  thing the next session should do is take the single-instance lock and drive it.
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
- 🟢 **Journal ops still undefined**, for want of a feature that needs them: stacking, watched
  roots, and the hash upgrade above.

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
11. **Measure before naming the cause.** The obvious reason a sequential JavaScript pipeline
    loses to Rust is that the Rust one is parallel. It is not: `/usr/bin/time` put `roost-old`'s
    import at 98% CPU — one core — while this build sat at 199% and still took three times as
    long. The difference is six times the CPU *per file*, not threads. The write-up that assumed
    otherwise was already drafted.
