# Roost — Roadmap

Status: **Draft v1** · Last updated: 2026-08-24

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

## M1 — Engine core ☐

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
- ☐ Import pipeline: discover → probe → hash → dedupe → place → journal → index
- ☐ `@roost/library`: `Library` create/open/rebuild, manifest, import
- ☐ `@roost/cli`: `init`, `import`, `stats`, `rebuild`, `thumb`, `fixture`
- ◐ **Rebuild equivalence test** mandated by the spec, wired into CI — the journal half is in
  (replaying the Rust build's 22-operation journal into an empty index lands the same state,
  derived data aside); the `originals/` half arrives with the import pipeline
- ◐ **Cross-implementation test**: a committed fixture library written by `roost-old` opens,
  replays, and produces the same state here (`ARCHITECTURE.md` §4.5) — index and journal are
  committed and tested; the object store is committed but not yet joined to them, which needs
  the import pipeline
- ☐ First benchmark run recorded in `docs/BENCHMARKS.md`, against the Rust baseline of
  4,900 files/sec at 100k

**Accepts when:** `roost import ~/Pictures` indexes 10k images, `roost stats` reports them,
thumbnail BLOBs are present in `index.db`, `originals/` has 256-or-fewer shard directories, a
re-import is a no-op, and both conformance tests pass. Import throughput is measured and
recorded — if it is far off the Rust baseline, the number goes in `BENCHMARKS.md` with an
explanation, not a shrug.

## M2 — Query and organize ☐

- ☐ `@roost/search`: RQL grammar, parser, SQL compiler, property test
- ☐ Query-corpus test: queries and their expected compiled SQL, taken from the Rust
  implementation's tests
- ☐ FTS5 wiring through the single write path
- ☐ Tags with groups, folders, ratings, notes, favourites
- ☐ Smart folders (saved RQL), validated at save time and evaluated on read
- ☐ Journal op coverage for every user-authored mutation (invariant 9) — the full set from
  `STORAGE_SPEC.md` §Ops added after v1
- ☐ `roost doctor`: orphaned objects, index rows with no bytes, moved referenced originals,
  stale FTS rows, `--deep` re-hash, `--reclaim` with the safety rule that reclaim refuses when
  the index and the object store disagree
- ☐ CLI: `query`, `smart`, `tag`, `folder`, `rate`, `note`, `favorite`, `rename`, `remove`,
  `show`, `doctor`
- ☐ Search benchmark recorded — the Rust baseline is p95 6–30 ms on 95k assets

**Accepts when:** the spec's rebuild test still passes with the full op set, unknown ops are
skipped with a warning rather than failing replay, and search p95 is under 100 ms on a
100k-asset fixture.

## M3 — Desktop shell ☐

Goal: the first GUI, built to `docs/UI_SPEC.md`. It is a new design; it must not be slow.

- ☐ Electron app: main, preload, renderer, and the engine `utilityProcess` (ADR-0006)
- ☐ `@roost/contract` and the typed `window.roost` surface (ADR-0007); validation on the
  receiving end, both directions
- ☐ Sandbox hardening verified: `contextIsolation`, `nodeIntegration: false`, `sandbox: true`,
  CSP, navigation and `window.open` denied, and a test that asserts each one
- ☐ `roost://` protocol: `thumb/<hash>@256|512` from the read-only connection,
  `original/<hash>` streamed with range support (ADR-0008)
- ☐ Library picker and creator; single-instance lock taken on open
- ☐ Virtualized grid: masonry and uniform, keyset paging, the cell contract from `UI_SPEC.md` §6
- ☐ Sidebar: places, folders with subtree counts, smart folders, grouped tags — each row
  carrying the RQL that selects it
- ☐ Inspector: preview, metadata, tags, rating, favourite, note, all editable, every edit
  reading the record back rather than trusting what it sent
- ☐ Preview pane: image, video, audio, external fallback; arrow keys move selection with it
- ☐ Search field with RQL validation, autocomplete, and the positioned parse error
- ☐ Import by drag & drop and by dialog, with live progress in the status bar
- ☐ CSS token check wired into the build **before the first component**
- ☐ Frontend test harness — the thing `roost-old` never had, and the reason a transparent panel
  shipped. Component tests for the grid contract, the preview, and the inspector
- ☐ Scroll benchmark mode: frame percentiles, refusing to report when the window is not
  composited
- ☐ Cold-start measurement from process launch to interactive grid

**Accepts when:** a 100k-asset library opens in under 1.5s and scrolls at 60fps, both measured
rather than eyeballed, and the sandbox assertions pass.

## M4 — Format breadth ☐

- ☐ Video: thumbnail + duration via an ffmpeg probe (optional, graceful absence)
- ☐ Audio: waveform + duration
- ☐ PDF: first-page thumbnail, page count, in-app page-through
- ☐ SVG rendering, GIF and animated WebP preview
- ☐ Fonts: specimen rendering, family and style metadata
- ☐ RAW photos via embedded JPEG preview
- ☐ Capability probe surfaced in the UI ("install ffmpeg for video previews")
- ☐ The bounded, persisted job queue and its migration (`ARCHITECTURE.md` §4.1)

**Accepts when:** a mixed folder of every listed format imports with correct thumbnails and
metadata, and the same folder imports cleanly on a system with no ffmpeg or PDF backend.

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
- ☐ Trash + retention, undo for destructive actions
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

**Nothing open, as of 2026-08-24.** The five questions the language change forced were settled
together, before any code was written against them — which is the cheapest moment they could
have been settled, and the reason M0 can start without working around an unknown.

| Question | Outcome | Record |
| --- | --- | --- |
| Process model | The engine runs in its own `utilityProcess`. `@roost/library` stays a set of calls; the engine wraps it, the CLI calls it directly | ADR-0006 |
| IPC contract | A shared `@roost/contract` package. The rule replacing "never hand-write IPC types" is that every message is validated at the receiving end | ADR-0007 |
| Serving bytes | `roost://` through `protocol.handle`, streamed, with range support and no size ceiling. Main opens one read-only database handle to do it | ADR-0008 |
| Native dependencies | `better-sqlite3`, `sharp`, native BLAKE3 | ADR-0009 |
| Reflink | No addon. `COPYFILE_FICLONE_FORCE` refuses rather than falling back — `EXDEV` across filesystems, `ENOTSUP` on a non-CoW one — so `link_method` stays truthful with what Node already has | ADR-0012, superseding ADR-0010 |
| Electron version | Track the stable line. Exact pin in the manifest, deliberate bumps, never outside the supported three majors | ADR-0011 |

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
