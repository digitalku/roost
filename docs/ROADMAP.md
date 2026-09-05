# Roost — Roadmap

Status: **Draft v1** · Last updated: 2026-08-26 · M0, M1, and M2 accepted

Milestones are sequential and each ends in something demonstrable. A milestone is done only
when its acceptance criteria pass — not when the code exists.

Legend: ☐ not started · ◐ in progress · ☑ done

This repository starts at M0. The Rust implementation at `../roost-old` reached M3, and its
milestones are the same shape on purpose: it is the reference for *what* each stage has to
prove, and its `BENCHMARKS.md` is the number each stage has to match. Nothing here is inherited
as done — an implementation in another language is not this one working.

---

## M0 — Foundation ☑

Goal: an empty but correct skeleton that builds, tests, and lints clean.

- ☑ pnpm workspace with the packages from `ARCHITECTURE.md` §2:
  `packages/{core,media,search,library,contract,cli}`, scoped `@roost/*`
- ☑ `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and `erasableSyntaxOnly`; project
  references wired so `tsc -b` typechecks the workspace in dependency order in one pass
- ☑ Biome configured, and a lint rule that forbids Node built-ins, `electron`, and every engine
  package inside `apps/desktop/renderer` — **verified by writing a file that violates it and
  watching the rule fire**, then deleting the file, rather than by reading the config
- ☑ Vitest configured at the root
- ☑ `@roost/core`'s `model`: `ContentHash` (branded, validated, with `shardOf()`), `Kind`,
  `StorageMode`, `LinkMethod`, and the `RoostError` hierarchy with its wire format
- ☑ The CSS token check, in place **before** the first component
- ☑ CI: typecheck, lint, CSS tokens, and tests on Linux
- ☑ Dev environment documented and verified (`docs/SETUP.md`)
- ☑ `.gitignore`, `LICENSE`, `README.md`
- ☑ Git repository initialised

**Accepts when:** `pnpm verify` — typecheck, lint, the CSS token check, and the tests — passes
on a clean clone, and CI is green. **Met 2026-08-24:** 31 tests green, `tsc -b` clean under
TypeScript 7.0.2, `biome ci` clean.

### Two deliberate deviations, recorded rather than quietly taken

**The per-platform native-module build job is deferred to M1.** M0 has no native dependency, so
the job would have built nothing and reported success — which is worse than absent, because a
green vacuous job reads as coverage. It lands with the modules it exists to guard (ADR-0009),
and the CI file carries a comment saying so.

**Vitest runs from one root config with a glob, not per-package projects.** Per-package projects
buy an environment per package, and every package here is `node`. The first one that is not —
the renderer, needing a DOM environment — is what will introduce projects, in M3.

### What building it actually taught

- **Electron 43.4.1 bundles Node 24.18.1, not 22.** Chromium 150.0.7871.224, ABI 148. Several
  documents had asserted that matching Electron's Node was the reason to target 22; that
  rationale was wrong and is now corrected. The conclusion survives — 22 is the *system* LTS
  and the lower of the two runtimes hosting `packages/` — but for the reason ADR-0011 §5 gives,
  not the one that was written down.
- **`@roost/contract` gets no `@types/node`**, which turns "this package must load in a
  sandboxed renderer" from a review comment into a compile error.
- **TypeScript 7 does not discover `@types/node` through pnpm's symlinked package directories**
  the way earlier versions did. Every Node-hosted package declares `"types": ["node"]`
  explicitly, which is better documentation anyway.

## M1 — Engine core ☑

Goal: a headless CLI that can build and query a real library. **No GUI yet.**
This milestone is deliberately GUI-free — it proves the engine independently and works in
containers where no window can open.

- ☑ `@roost/core` `db`: migrations 0001–0005 carried over verbatim (`DATA_MODEL.md` port note,
  SQL byte-identical, only Rust path references in the comments adapted), forward-only migration
  runner, one connection by construction rather than by mutex, and the repository — guarded by an
  **`index.db` written by the Rust implementation**, which opens here at v5 with no migration and
  answers every statement this build knows how to ask
- ☑ `@roost/core` `journal`: append-only writer, monthly rotation, `fsync` policy, replay engine
  with skip-unknown-op and torn-line handling — guarded by a **journal written by the Rust
  implementation carrying all 22 operations**, which every record must re-serialise to byte for
  byte
- ☑ `@roost/core` `storage`: the `Storage` interface, `ManagedStorage` (reflink → hardlink →
  copy, atomic temp+rename) and `ReferencedStorage` — with a fragment of a **Rust-written
  object store committed as a fixture**, walked and re-derived path by path
- ☑ `@roost/core` `platform`: XDG directories, reflink probing, reveal, single-instance lock —
  whose key derivation is pinned against **three lock files `roost-old` actually left on this
  machine**, so the two builds lock each other out of a library rather than both believing they
  are alone
- ☑ `@roost/core` `log`: structured logger, scopes, bound fields, sinks installed by the
  binaries — and nothing written at all until one is
- ☑ Streamed BLAKE3 including the >50 MB partial scheme and `is_partial_hash`, byte-verified
  against digests taken from the Rust implementation — and the verification itself checked, by
  flipping the size prefix to big-endian and watching the two partial-hash cases fail
- ☑ `@roost/media`: magic-byte probing over 21 formats with the extension as a hint only,
  header-only dimensions, and WebP q80 thumbnails at 256/512 as BLOBs — plus the synthetic
  gradient generator `roost fixture` needs. **ADR-0013 came out of it**: `sharp`'s prebuilt
  binary segfaults inside Electron on Linux, which the CLI does not hit and M3 would have
  discovered the hard way
- ☑ Import pipeline: discover → hash → dedupe → place → probe → journal → index, with a
  streaming walk, batch-level deduplication, and the partial-hash collision refused rather than
  merged. Journal before index has a test: the append is stubbed to fail and the index is
  asserted empty
- ☑ `@roost/library`: `Library` create/open/rebuild, manifest, import, thumbnails
- ☑ `@roost/cli`: `init`, `import`, `stats`, `rebuild`, `thumb`, `fixture` — library resolution
  the way `git` does it, results on stdout and everything else on stderr, and exit code 2 for a
  command line that cannot be acted on against 1 for a command that tried
- ☑ **Rebuild equivalence test** mandated by the spec, wired into CI: replaying the Rust build's
  22-operation journal lands the same state, and a library imported here rebuilds to an identical
  index with thumbnails correctly discarded
- ☑ **Cross-implementation test**, and in both directions. Committed fixtures prove this build
  reads the Rust one's object store, journal, and index. `packages/library/tests/interop.test.ts`
  proves the reverse where `../roost-old` is built: it writes a library here, and the Rust binary
  reads the same counts out of it, **replays its journal into a matching index**, and reports
  nothing wrong from `doctor`. The fixture generator writes byte-identical corpora too
- ☑ First benchmark run recorded in `docs/BENCHMARKS.md`: **6,883 files/sec** on the Rust
  build's own 20k fixture, against that build's 18,805 on the same corpus — 23x the stated floor,
  and 2.7x off a baseline whose cause is measured rather than assumed

**Accepted 2026-08-25.** 10,000 images imported and reported, 6,500 thumbnail BLOBs in
`index.db` and no loose files, exactly 256 shard directories at one level, a re-import that
imported nothing, and a rebuild that landed on the same 9,722 assets. Import throughput is
recorded in `BENCHMARKS.md` with the explanation the criterion asked for: 2.7x off the Rust
baseline, and the cause measured rather than assumed — six times the CPU per file, not threads.

## M2 — Query and organize ☑

- ☑ `@roost/search`: RQL grammar, lexer, recursive-descent parser, SQL compiler, and the
  property test `DATA_MODEL.md` §3 asks for — ~11,500 generated inputs, each of which must
  either parse or raise a positioned error, and whose compiled SQL must never contain a
  character the user typed
- ☑ Query-corpus test, taken from the Rust implementation's own parser tests **before** a line
  of this parser was written, so the grammar is reproduced rather than reinvented
- ☑ FTS5 wiring through the single write path — landed with the index in M1, since replay needs
  it; M2 is where it is exercised, and a rename now proves the row is rewritten rather than
  patched
- ☑ Tags with groups, folders, ratings, notes, favourites, in `@roost/library`'s `edit` service
- ☑ Smart folders (saved RQL), parsed at save time and evaluated on read
- ☑ Journal op coverage for every user-authored mutation (invariant 9) — all 22 ops, pinned by a
  test that applies one of each and rebuilds to an identical index
- ☑ `roost doctor`: orphaned objects, index rows with no bytes, moved referenced originals,
  stale FTS rows, `--deep` re-hash, `--reclaim` with the safety rule that reclaim refuses when
  the index and the object store disagree. Two checks the Rust build does not have: files in
  `journal/` that replay will skip, and which `sharp` and `libvips` are loaded
- ☑ CLI: `query`, `smart`, `tag`, `folder`, `rate`, `note`, `favorite` (retired, ADR-0029), `rename`, `remove`,
  `show`, `doctor`
- ☑ Search benchmark recorded — `docs/BENCHMARKS.md`, 2026-08-26

**Accepts when:** the spec's rebuild test still passes with the full op set, unknown ops are
skipped with a warning rather than failing replay, and search p95 is under 100 ms on a
100k-asset fixture.

**Accepted 2026-08-26.** 95,001 assets, every M2 edit applied: `roost rebuild` replayed 201,003
records in 5.1 s and landed on the same counts with every tag, rating, favourite, and folder
membership intact; `roost doctor` found nothing wrong, shallow and deep; search p95 is 32 ms at
its worst and 0.2 ms typical. The Rust binary read the same library, replayed its journal into a
matching index, and agreed with this build on nine RQL queries.

## M3 — Desktop shell ☑

Goal: the first GUI, built to `docs/UI_SPEC.md`. It is a new design; it must not be slow.

- ☑ Electron app: main, preload, renderer, and the engine `utilityProcess` (ADR-0006)
- ◐ `@roost/contract` and the typed `window.roost` surface (ADR-0007); validation on the
  receiving end, both directions — the machinery and the library lifecycle are in; members
  arrive with the features that need them
- ☑ Sandbox hardening verified: `contextIsolation`, `nodeIntegration: false`, `sandbox: true`,
  CSP, navigation and `window.open` denied — asserted as values by
  `apps/desktop/main/src/security.test.ts`, and asserted against a **running window** by
  `node scripts/check-sandbox.mjs`, which reads the policy Electron actually served
- ☑ `roost://` protocol: `thumb/<hash>@256|512` from the read-only connection,
  `original/<hash>` streamed with range support (ADR-0008). Ranges are asserted by test but
  have not yet been exercised by a `<video>` — there is no real video fixture until M4
- ☑ Library picker and creator; single-instance lock taken on open. A library is a folder
  called `<Name>.roost` (ADR-0014)
- ☑ Virtualized grid: masonry and uniform, keyset paging, the cell contract from `UI_SPEC.md` §6.
  The list view and the zoom control arrived with ADR-0018; marquee selection on 2026-09-01.
  Hover-in-the-store is in `TODO.md`
- ☑ Sidebar: places, folders with subtree counts, smart folders, grouped tags — each row
  carrying the RQL that selects it. Collapsing, drag-to-reparent, and the library switcher are
  in `TODO.md`
- ☑ Inspector: preview, metadata, tags, rating, favourite (retired, ADR-0029), note, all editable, every edit
  reading the record back rather than trusting what it sent. Proven through the window and then
  through a `roost rebuild`: every edit the GUI made survived deleting the index
- ☑ Preview pane: image, video, audio, external fallback; arrow keys move selection with it.
  Zoom-to-1:1 and drag-to-pan are in `TODO.md`; PDF page-through and font specimens are M4
- ◐ Search field with RQL validation, autocomplete, and the positioned parse error — validation,
  the caret, the 250ms idle, and the match count are in; autocomplete, chips, and "save as smart
  folder" are in `TODO.md`
- ☑ Import by drag & drop and by dialog, with live progress in the status bar. Thumbnails are
  generated in the same run, unlike the CLI's two commands, because the grid an import produces
  is otherwise a screen of placeholders. Referenced mode and per-run tags are in `TODO.md`
- ☑ CSS token check wired into the build **before the first component**
- ☑ Frontend test harness — the thing `roost-old` never had, and the reason a transparent panel
  shipped. In place before the first component; the grid, the preview, and the inspector got
  their tests as they arrived. **Both halves are there from 2026-09-03**: the component tests in
  `vitest`, and `scripts/lib/` for the claims a component test cannot make — layout, the cascade,
  a real pointer, and a gesture. Five scripts drive a window on it
- ☑ Scroll benchmark mode: frame percentiles, refusing to report when the window is not
  composited. `node scripts/bench-window.mjs <LIBRARY>`
- ☑ The grid's layout, its selection paint, and its marquee held to `UI_SPEC.md` §6 in a real
  window. `node scripts/check-grid.mjs`, which refuses on the same ground the benchmark does
- ☑ Cold-start measurement from process launch to interactive grid — the same script, because
  the two share a window and neither is worth a second launch

**Accepts when:** a 100k-asset library opens in under 1.5s and scrolls at 60fps, both measured
rather than eyeballed, and the sandbox assertions pass.

**Accepted 2026-08-28.** On 100,000 assets: cold start **763–874 ms** against the 1,500 ms
budget, and **96–114 fps** on a 120 Hz display with the median frame never leaving 8.3 ms —
`docs/BENCHMARKS.md` has the runs and what they revealed. The sandbox now passes sixteen checks
against a running window, verified by weakening three settings and watching four of them fail.

What M3 does **not** include is written down rather than left to be discovered: the list view,
the zoom control, marquee selection, autocomplete, chips, sidebar collapsing and
drag-to-reparent, the library switcher, and 1:1 zoom in the preview are all in `TODO.md` §M3
with the reason each one waited. Three have since arrived: the list view and the zoom control
with ADR-0018, and marquee selection on 2026-09-01.

## M4 — Format breadth ☑

- ☑ Video: thumbnail + duration via an ffmpeg probe (optional, graceful absence)
- ☑ Audio: waveform + duration
- ☑ PDF: first-page thumbnail, page count, in-app page-through
- ☑ SVG rendering, GIF and animated WebP preview
- ☑ Fonts: specimen rendering, family and style metadata
- ☑ RAW photos via embedded JPEG preview
- ☑ Capability probe surfaced in the UI ("install ffmpeg for video previews")
- ☑ The bounded, persisted job queue and its migration (`ARCHITECTURE.md` §4.1)

**Accepts when:** a mixed folder of every listed format imports with correct thumbnails and
metadata, and the same folder imports cleanly on a system with no ffmpeg or PDF backend.

**Both halves are tests.** `packages/library/tests/formats.test.ts` imports one of everything and
checks the thumbnail and the metadata each backend is responsible for;
`packages/cli/tests/no-ffmpeg.test.ts` runs the built CLI as a subprocess whose `ROOST_FFMPEG`
points at nothing, and asserts the video imports whole, the image still draws, and the queue says
which tool is missing. The second is the half that would otherwise never run: every machine this
is developed on has ffmpeg.

**What it cost to learn** (`BENCHMARKS.md`, 2026-08-29): a 12-megapixel JPEG thumbnails two and a
half times faster than a 2-megapixel PNG, because libvips shrinks a JPEG during its DCT pass;
video and audio are two orders of magnitude slower than everything else and all of it is process
start; and `UV_THREADPOOL_SIZE` — which `ARCHITECTURE.md` had claimed the engine raised since M1 —
cannot be raised by the process that wants it at all.

**Deferred out of M4**, with the reason each one waited, in `TODO.md`: CR3 and RAF (neither is a
TIFF container), animated thumbnails, a PDF text layer, and EXIF beyond dimensions.

## Asked for directly, outside the milestone order

M5 and M6 are deferred at the user's request (below), so a feature they ask for lands when they
ask for it rather than waiting for a milestone nobody has planned yet. What has arrived that way
is listed here, so the order stays visible instead of becoming folklore.

- ☑ **Trash** — 2026-09-01, ADR-0022. Also listed under M6, which is where the Trash place was
  first promised
- ☑ **Marquee selection** — 2026-09-01, the last of `UI_SPEC.md` §6's grid gestures
- ☑ **Comments that carry a moment** — ADR-0023, accepted 2026-09-02 and built the same day.
  Migration 0008, three journal ops, the library API, `roost comment`, the three contract
  requests, the inspector's list, and the marker strip under the player. What is **not** done is
  seeing it in a real window, which is the fifth thing now waiting on `check-grid.mjs`
- ☐ **Making files in the library, and editing text** — asked for 2026-09-03. ADR-0026,
  **Accepted** the same day, because an edit in a content-addressed store is a new asset rather
  than a write. Four stages, **two of them done that day**. Stage 1: `text` is a kind, sniffed as
  a negative test after every signature, and the preview reads a text asset itself — a 2 MB range
  over `roost://original/`, decoded in the renderer, with the encoding named. Stage 2: migration
  0010, the `supersede` op, `saveEdit` with everything user-authored carried across as journal
  lines, `is:superseded` as the second scope rule, `roost save`, and the editor — with four
  refusals said out loud rather than shown as a missing button. Stage 3, **done 2026-09-04**: the menu over the grid's empty space — Paste
  (four gestures, and a link is never fetched) and New file…, which opens a dialog asking for the
  name and nothing else, with the clipboard parsed in main. **Stage 1 and stage 2's editor were
  withdrawn the same day** at the user's word — an external editor is enough — so there is no
  `text` kind, no viewer and no editor; `roost save` keeps replacing an asset's contents from the
  CLI. **Stage 4 is not
  started**: *Import from URL…*, invariant 7's one exception written out explicitly. One question
  opened on the way and blocks nothing yet: *Duplicate into library to edit* cannot mean
  duplicate, because identical bytes are one asset (`TODO.md` §3)
- ☐ **Subtitles** — ADR-0025, **Accepted** 2026-09-03, **stage 1 built 2026-09-05**: the `.srt` is
  an ordinary asset, the attachment is a journal line, Eagle's convention survives only as an
  import-time heuristic, and a track is served as WebVTT because `<track>` accepts nothing else.
  Stages 2 and 3 — embedded tracks, and cues in the index — are not started. It came from the user
  asking how Roost should do what Eagle does with an `.srt` dropped beside a video
- ☐ **A video transport of our own** — ADR-0024, **Accepted** 2026-09-02, from the user asking why
  Eagle's player feels part of the application and ours does not. Four stages: parity plus the
  comment marks moved onto the timeline, then frame stepping and speed and A-B loop, then
  hover-scrub previews (still a decision of its own), then **set this frame as the thumbnail**,
  which the user asked for directly. **Stages 1, 2 and 4 done 2026-09-02**: `controls` is off,
  the bar is ours, the marks are on the timeline, frame stepping runs off the probed rate with a
  counter from `requestVideoFrameCallback`, and a frame can be pinned as the thumbnail —
  migration 0009, a `poster_set` op, `roost poster`, and two rows in the context menu.
  `scripts/check-transport.mjs` holds the lot to `UI_SPEC.md` §10 in a real window — 35 checks.
  Stage 3 is a decision of its own

## M5 — Discovery features ☐

- ☐ Dominant colour extraction → CIELAB, colour filter UI
- ☐ Perceptual hashes → near-duplicate detection and "find similar"
- ☐ Duplicate review UI (side-by-side, keep/discard)
- ☐ Watched folders with auto-import
- ☐ Version stacking
- ☐ Timeline view

## M6 — Polish and shipping ☐

- ☐ Command palette and the full, rebindable shortcut map
- ☐ Preferences: theme, density, default import mode, watched roots
- ☑ ~~Trash~~ — landed 2026-09-01 with ADR-0022, ahead of this milestone, because the asset
  context menu needed `Delete` to mean something. **Retention is not coming**: the ADR refuses a
  timer outright. Undo for edits other than deletion is still M6
- ☐ Undo for destructive actions other than deletion
- ☐ Export/backup a selection with metadata
- ☐ Packaging: AppImage, Flatpak, .rpm, .deb, with native modules bundled;
  `.desktop` and MIME registration
- ☐ First-run onboarding and a sample library
- ☐ Documentation: user guide, and the library format spec published for other implementers

**Accepts when:** a clean Fedora and a clean Ubuntu VM install the package and complete the
import → organize → find loop with no terminal use.

## M7 — Beyond (not scheduled)

Browser extension · on-device ML auto-tagging · OCR search · plugin API · macOS and Windows
support · library merge · on-image annotation.

---

## Decision status

**Nothing open, as of 2026-09-03.** Two were decided that day, both on the day they were
proposed, and the second had its first stage built the same afternoon. **ADR-0026 — an edit is
a new asset** came from the user asking for Paste and New File on the grid's empty space and
for text assets to be edited inside Roost; editing changes the bytes that *are* the identity,
so a save is an import plus a `supersede`, everything hanging off the old asset travels to the
new one, a referenced asset stays read-only because invariant 6 does not bend, and New File is
a draft until it has bytes — an empty file being representable exactly once per library, which
is the one part of the request that could not be served as asked and is said so in the ADR
rather than quietly narrowed. **ADR-0025** — subtitles. It came from the user asking how Roost
should do what Eagle does with an `.srt` dropped beside a video, and the answer could not be
Eagle's, whose mechanism is a folder per asset. Here the convention survives as an import-time
heuristic and the attachment becomes a journal line. It blocks nothing and nothing is built
against it. Before it, ADR-0024 — a video transport of our own — was accepted the same day it
was proposed, after the user asked what media player Eagle uses and the answer turned out to be
"the same one, with the controls turned off". It was accepted with a measurement owed rather
than done — four player libraries against invariant 7, the bundle budget, and whether a mark
can go on their timeline without a fork — and stage 1 was then built ahead of it, at the user's
asking, over the slider primitive this repository already depends on. That question decided
*how*, never whether, and it is deferred rather than closed: `TODO.md` §3 keeps it, now with a
real baseline to beat. Before it, ADR-0023 — comments that carry a moment — was accepted the
day after it was proposed. The five questions the language change forced were settled together,
before any code was written against them — which is the cheapest moment they could have been
settled, and the reason M0 can start without working around an unknown.

| Question | Outcome | Record |
| --- | --- | --- |
| Process model | The engine runs in its own `utilityProcess`. `@roost/library` stays a set of calls; the engine wraps it, the CLI calls it directly | ADR-0006 |
| IPC contract | A shared `@roost/contract` package. The rule replacing "never hand-write IPC types" is that every message is validated at the receiving end | ADR-0007 |
| Serving bytes | `roost://` through `protocol.handle`, streamed, with range support and no size ceiling. Main opens one read-only database handle to do it | ADR-0008 |
| Native dependencies | `better-sqlite3`, `sharp`, native BLAKE3 | ADR-0009 |
| Reflink | No addon. `COPYFILE_FICLONE_FORCE` refuses rather than falling back — `EXDEV` across filesystems, `ENOTSUP` on a non-CoW one — so `link_method` stays truthful with what Node already has | ADR-0012, superseding ADR-0010 |
| Electron version | Track the stable line. Exact pin in the manifest, deliberate bumps, never outside the supported three majors | ADR-0011 |

**M4 opened with three more, decided together on 2026-08-29** — one per format family Roost could
not draw, all settled before any of them was written against:

| Question | Outcome | Record |
| --- | --- | --- |
| SVG and font specimens | resvg compiled to WebAssembly, which has no filesystem and no sockets to follow a reference with; fontkit reads the font and supplies the outlines a specimen is drawn from | ADR-0015 |
| PDF | pdfium compiled to WebAssembly. One instance per process, and a page is single-use — `render()` closes it | ADR-0016 |
| Video and audio | The system's `ffmpeg` and `ffprobe`, probed once per session. Bundling stays open for M6, where packaging is decided | ADR-0017 |

**One more on 2026-08-30, from using the window rather than from planning it:**

| Question | Outcome | Record |
| --- | --- | --- |
| The view control | A menu in the file manager idiom — Icons, Compact, Details, Zoom, Sort By, Group By — replacing the masonry/uniform toggle. Masonry becomes a checkbox under Icons rather than a peer view or a deletion: it is the only layout that does not crop | ADR-0018 |

**And one on 2026-09-01, the last one that was open:**

| Question | Outcome | Record |
| --- | --- | --- |
| What `Delete` means | Trash, and trash is a `trashed_at` column (migration 0007) with `trash` and `restore` journal ops. A trashed asset keeps everything and stops matching every query but `is:trashed`. **Nothing is ever emptied on a timer** — permanent removal is `remove`, which is what "Empty trash" and "Delete permanently" send | ADR-0022 |

| Where settings live | `settings.json` inside `<Name>.roost`, which is the default; `stateDir()` and `configDir()` hold only what cannot live in a library — the recent list that finds one, window geometry, and the theme the picker is drawn in | ADR-0019 |
| Windows | Several windows onto one library. Several libraries at once is refused for now, and the work it would need is named | ADR-0020 |

| UI primitives | `radix-ui` 1.6.7, measured against three alternatives. Native `Menu.popup()` was recommended first, on the user's request for the OS's own menus, and reversed by finding that Electron draws its own menu on Linux — the only platform v1 ships | ADR-0021 |

**And two on 2026-09-03, both from asking what Eagle does and finding that its answer does not fit a content-addressed store:**

| Question | Outcome | Record |
| --- | --- | --- |
| Subtitles | The `.srt` is an ordinary content-addressed asset and the attachment is a journal line (`subtitle_attach`), so Eagle's "drop it in the folder" survives only as an import-time heuristic. An attached track leaves the grid and comes back with `is:subtitle`; cues in the index make `said:"…"` a search that answers with a moment | ADR-0025 |
| What an edit is | A save is an import plus `supersede { from, to }`, everything user-authored carried across, `superseded_by` a column. A referenced asset is read-only. New File is a draft until it has bytes, because every empty file has one hash | ADR-0026 |

**M5 and M6 are deferred**, at the user's request on 2026-08-30: feature work first, and both
milestones get planned once the feature set has settled. Nothing below them is cancelled; the
order is.

Settled by the user's own choice of stack, and recorded rather than argued: the application
shell (ADR-0001), the frontend framework (ADR-0002), and the library format, which is carried
over unchanged (ADR-0003, ADR-0004). The CLI stays a first-class frontend (ADR-0005).

**Two consequences land in M0 and M1 rather than M6**, because they are now known:
- There are **three** native modules, all with upstream prebuilt binaries. A fourth was proposed
  for reflink and then measured away (ADR-0012), which removes what ADR-0009 had called the
  dependency most likely to need a compiler on a user's machine.
- The engine is a process, so M1's `@roost/library` must run in a plain Node process with no
  Electron import anywhere in its dependency graph. The CLI is the test that this held.

New architectural questions get an ADR and a user decision before being marked Accepted, never
a silent guess.
