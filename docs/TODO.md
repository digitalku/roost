# Roost — TODO

Everything known to be outstanding, in priority order. `ROADMAP.md` holds the milestone plan;
this file holds the working list, including the small things that surface during implementation
and would otherwise be forgotten.

Last reviewed: 2026-08-24, the session that created this repository.

Legend: 🔴 blocks other work · 🟡 do before the milestone it names · 🟢 whenever

---

## 1. Needs a decision from the user

**Nothing blocking.** The five questions the language change forced were settled on 2026-08-24,
before any code was written against them — ADR-0006 through ADR-0010, all Accepted. What they
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
- 🟡 **The per-platform native-module CI job is deferred to M1**, where the four modules it
  guards actually arrive. A job that builds nothing and reports success is worse than an absent
  one. `ROADMAP.md` M0 records the deviation; the CI file carries the reason.
- 🟢 **`ELECTRON_SKIP_BINARY_DOWNLOAD=1` is set in CI** and must be removed at M3, the first
  milestone that starts Electron. Until then it saves ~150 MB per run for a binary nothing runs.

### Engine (M1)
- 🟡 **Check `better-sqlite3` and `sharp` the way the hashing binding was checked**: load each
  under system Node *and* under Electron, and see whether the same installed binary serves both.
  `@napi-rs/blake-hash` does, because Node-API is ABI-stable — which means an Electron bump may
  touch only our own reflink addon rather than all four modules (ADR-0009's amendment). Verified
  for one; assumed for none.
- 🟡 **The per-platform native CI job now has something to guard.** `@roost/media` has its first
  native dependency, so the job deferred from M0 should land with the next one rather than at the
  end of M1.
- 🟡 **`@roost/library` must not acquire `electron` in its dependency graph**, directly or
  transitively. A lint rule or a dependency-graph assertion belongs with the first real service,
  since the CLI is what proves the layering and the CLI is written in this milestone.
- 🔴 **The reflink addon needs a test that measures allocation, not bytes.** Clone a file and
  compare the filesystem's reported allocated size before and after. A reflink that quietly
  became a full copy passes any test that only checks the two files match — which is exactly how
  `COPYFILE_FICLONE` fools people, and the reason ADR-0010 exists. This machine is on Btrfs, so
  the test can be written the same day as the addon.
- ☑ ~~**A digest fixture from the Rust implementation.**~~ Done 2026-08-24, and it earned its
  keep immediately: flipping the size prefix to big-endian produces a different, entirely
  self-consistent set of digests, and only the cross-implementation expectations catch it. Six
  fixtures, both sides of the 50 MiB boundary, generator committed at
  `packages/media/src/testing/hash-fixtures.ts`.
- 🔴 **A fixture library written by `roost-old`**, committed, for the cross-implementation test.
  Small enough to commit; it needs a managed asset, a referenced asset, a partial-hash asset,
  tags, groups, folders, a smart folder, and at least one op from the post-v1 set.
- 🟡 Decide how integer columns are read. `better-sqlite3` returns `bigint` only for values that
  do not fit a double, so a column is `number` until one day it is not (`DATA_MODEL.md` §4).
- 🟡 Journal `fsync` policy: per batch during import, bounded interval otherwise. The journal is
  the source of truth, so a write that reaches the database but not the journal is data loss.
- 🟢 Streamed hashing must not read whole files. Assets are routinely gigabytes.

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
