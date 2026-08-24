# Roost — TODO

Everything known to be outstanding, in priority order. `ROADMAP.md` holds the milestone plan;
this file holds the working list, including the small things that surface during implementation
and would otherwise be forgotten.

Last reviewed: 2026-08-24, the session that created this repository.

Legend: 🔴 blocks other work · 🟡 do before the milestone it names · 🟢 whenever

---

## 1. Needs a decision from the user

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

- 🟡 **Unstyled component primitives.** `UI_SPEC.md` §3 builds every component in-repo on top of
  unstyled primitives for menus, dialogs, tooltips, and sliders. Which library — Radix, Ark,
  Base UI, or hand-rolled — is open. The constraint is invariant 7: no runtime network, no
  bundled webfont, nothing that ships its own design opinions. Needed by M3, not M0.

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

- 🟡 **Get a real video into the container before M3 claims playback works.** `roost-old` closed
  M3 with video playback **unverified against an actual file** — the range machinery was
  unit-tested and no `.mp4` that decodes was ever played, because that container had no ffmpeg.
  This one does: `ffmpeg -f lavfi -i testsrc=size=1280x720:rate=30 -t 10 sample.mp4` is the whole
  fixture. Do not let the same gap ship twice.
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
- 🟢 **A journal file not named `YYYY-MM.jsonl` is invisible to replay.** That is correct — the
  name is how replay orders months — but it is silent, and a backup tool or a curious user
  renaming `2026-08.jsonl` loses a month without any complaint. `roost doctor` should report
  unexpected files in `journal/`. Found while writing the journal fixture, which failed for
  exactly this reason before it was named properly.
- 🔴 **The importer records the *last* extension component, lowercased, without the dot.**
  Verified against the Rust implementation, which stores `b.tar.gz` as `<hash>.gz` and a file
  with no extension as a bare `<hash>` with no trailing dot. Getting this wrong puts one asset
  at two addresses across the two implementations, and the object store cannot catch it —
  storage is handed the extension, it does not choose it. The fixture at
  `packages/core/src/storage/__fixtures__/rust-written-library` pins the layout; nothing yet
  pins the *choice*, and that belongs with the import pipeline.
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
- 🔴 **A fixture library written by `roost-old`**, committed, for the cross-implementation test.
  Small enough to commit; it needs a managed asset, a referenced asset, a partial-hash asset,
  tags, groups, folders, a smart folder, and at least one op from the post-v1 set.
- ☑ ~~Decide how integer columns are read.~~ Settled 2026-08-24, and the premise was wrong:
  `better-sqlite3` does **not** return `bigint` past 2^53, it silently rounds. `DATA_MODEL.md` §4
  carries the measurement and the decision — read `number`, and rely on no column in this schema
  being able to approach the boundary.
- 🟡 Journal `fsync` policy: per batch during import, bounded interval otherwise. The journal is
  the source of truth, so a write that reaches the database but not the journal is data loss.
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
- 🟢 **The M2 organize reads are deliberately absent from `Repo`**: the folder tree, tag counts,
  tag-group listing, `find_folder_by_path`, and the `folder_is_within` cycle guard. Every `apply*`
  is here, because replay needs all 22 operations in M1; the reads that only a sidebar uses arrive
  with the sidebar.

- 🔴 **ADR-0013 is Proposed and needs a decision before M3.** `sharp`'s prebuilt binary cannot
  run inside Electron on Linux. The recommendation is to build it from source against the
  platform's libvips there and keep the prebuilt elsewhere, with the WASM build as a documented
  6x-slower fallback. Nothing in M1 is blocked — the CLI runs on the system's Node, where the
  prebuilt is both correct and fastest.
- 🟡 **`roost doctor` should report which sharp build is loaded.** "Thumbnails are slow" and
  "thumbnails crash the engine" have the same cause and no other symptom.
- 🟢 **BMP has no thumbnail here.** libvips 8.18.3 has no BMP loader; the Rust build's `image`
  crate did. A `.bmp` still imports and still carries tags. Pinned by a test so it stays a
  decision.
- 🟡 **SVG is deliberately not rendered**, and that costs a real feature: an SVG icon set is a
  plausible library and every asset in it would be blank in the grid. The reason is measured —
  librsvg follows external references, so an imported SVG can read files off disk through the
  thumbnailer, and the same path reaches remote URLs (invariant 7). M4 should rasterise SVG
  somewhere that cannot reach the filesystem, and until then the renderer can still preview one
  with its own engine.

### Search and organize (M2)
- 🟡 Extract the query corpus from `roost-old`'s parser tests before starting, so the grammar is
  reproduced rather than reinvented. A smart folder stores its query text; a query this
  implementation cannot parse is a folder the user loses.
- 🟢 `doctor --reclaim` must refuse when the index and the object store disagree. Reclaiming is
  permanent, and a broken index makes every object look unreferenced. A *missing referenced
  original* is deliberately not one of those disagreements — it means the user moved their own
  file, and counting it would block reclaiming forever.

### Shell and UI (M3)
- 🔴 The frontend test harness goes in **before** the components, not after. `roost-old` shipped
  M3 with nothing exercising the preview, the context menu, or the dialogs, and the bug that
  found the gap was invisible to TypeScript and to every test that existed.
- 🟡 Sandbox assertions as tests, not as configuration reviewed once.
- 🟡 A short `Cache-Control` on the thumbnail 404. The grid learns a thumbnail is absent by
  asking, which is right; `roost-old` measured it re-asking on every scroll back over a folder
  of videos.
- 🟡 Window state — size, position, last library — has nowhere to live until there is an
  application config (`~/.config/roost/`). Recent libraries and the default import mode need the
  same place.
- 🟢 The app icon. `roost-old` shipped a flat generated square and never replaced it.

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
8. **A test can pass because the code is right, or because the fixture is too small to tell.**
   Found three times in one session, each by deliberately breaking the thing the test guarded:
   dropping the keyset tie-break changed nothing (the index supplies that order anyway),
   `PRAGMA foreign_keys = OFF` changed nothing (`better-sqlite3` sets it on regardless), and an
   unanchored `/@cursorTs/` matched `@cursorTs2` and counted the broken version as correct.
   Writing the test is half the work; breaking the code to watch it fail is the other half.
