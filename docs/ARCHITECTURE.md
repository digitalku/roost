# Roost — Architecture

Status: **Draft v1** · Last updated: 2026-08-24

This document describes the Electron/TypeScript implementation. It is a design, not a
description: almost nothing here is built yet. Where a section records a fact carried over from
the Rust implementation at `../roost-old` — a measurement, a bug it found, a shape that already
proved right — it says so. Everything else is a plan, and the milestone that will build it is
named.

---

## 1. Shape of the system

Electron gives us processes, not threads, as the primary unit of isolation. The split below is
the whole architecture in one picture:

```
┌──────────────────────────────────────────────────────────────────────┐
│  renderer  (Chromium, sandboxed)                                      │
│  React views · virtualized grid · selection store · no Node access    │
└──────────────▲──────────────────────────────┬────────────────────────┘
               │ window.roost (typed)          │  <img src="roost://…">
┌──────────────┴──────────────────────────────┼────────────────────────┐
│  preload  — contextBridge, one surface, no  │  logic                 │
└──────────────▲──────────────────────────────┼────────────────────────┘
               │ ipcRenderer.invoke            │
┌──────────────┴──────────────────────────────▼────────────────────────┐
│  main  — windows, menus, dialogs, `roost://` protocol, IPC routing    │
│         no business logic; one read-only DB handle, for bytes only    │
└──────────────▲───────────────────────────────────────────────────────┘
               │ MessagePort, structured clone
┌──────────────┴───────────────────────────────────────────────────────┐
│  engine  (utilityProcess) — owns the Library. Same API the CLI uses.  │
│    ├── @roost/search   RQL → WHERE fragment, params bound             │
│    ├── @roost/media    decode, thumbnails, EXIF, phash, color         │
│    └── @roost/core     model·db·storage·journal·platform·log          │
│                        (everything STORAGE_SPEC.md governs)           │
│    └── worker pool     hashing, replay parsing — CPU-bound JS only    │
└──────────────────────────────────────────────────────────────────────┘
```

**Rule:** the main process contains no business logic. Every IPC handler is
`validate → forward to engine → return`. If a handler body exceeds ~20 lines, the logic belongs
in `@roost/library`. This is what keeps the CLI honest and a future non-Electron frontend
possible.

Two things deliberately do **not** follow the arrows. Thumbnails and originals reach the
renderer as ordinary URLs over the `roost://` protocol, served by main straight from the store
(§4.3) — image bytes never enter a JSON message. And the engine's worker pool is an internal
detail of the engine; nothing outside it knows the pool exists.

## 2. Workspace layout

```
roost/
├── package.json               # workspace root: scripts only, no dependencies of its own
├── pnpm-workspace.yaml
├── tsconfig.base.json         # strict settings every package extends
├── biome.json
├── CLAUDE.md
├── docs/
├── packages/
│   ├── core/                  # domain types + SQLite + storage + journal — what the spec governs
│   │   ├── migrations/        # numbered SQL, exactly where STORAGE_SPEC.md places them
│   │   └── src/{model,db,storage,journal,platform,log}
│   ├── media/                 # format probing, decode, thumbnails, metadata, hashes
│   ├── search/                # RQL grammar, parser, filter compiler
│   ├── library/               # orchestration: Library handle, import, edit, search, thumbnails, doctor
│   ├── contract/              # IPC message shapes and their validators — no runtime dependencies
│   └── cli/                   # `roost` binary — headless driver over library
└── apps/
    └── desktop/
        ├── main/              # Electron main: windows, menus, protocol, IPC routing
        ├── preload/           # contextBridge surface, and nothing else
        ├── engine/            # utilityProcess entry point — hosts one Library
        └── renderer/          # React 19 + TypeScript + Vite
```

**Directory names are unprefixed; package names are scoped.** `packages/core/package.json`
declares `"name": "@roost/core"`, and so on, with `@roost/cli` producing a binary called
`roost`. Directory names are local, package names are global identifiers.

Dependency direction is strictly downward:
`core ← {media, search} ← library ← {cli, engine}`.
`@roost/media` and `@roost/search` are siblings — neither knows the other exists, and both see
only `@roost/core`. `@roost/core` must never depend on another workspace package. Cycles are a
build error and a design error.

`@roost/contract` sits outside that chain. It is imported by `main`, `preload`, `renderer`, and
`engine`, and it depends on nothing — not on `@roost/core`, not on Node built-ins, not on the
DOM. It holds message shapes and their validators, so it must be loadable in a sandboxed
renderer and in a Node process alike. Anything that cannot be structured-cloned does not belong
in it.

**The renderer's dependency list is checked, not trusted.** A lint rule forbids `@roost/core`,
`@roost/library`, `electron`, and every Node built-in in `apps/desktop/renderer`. Import
discipline is the whole of invariant 11 in practice, and it is one careless auto-import away
from being lost.

## 3. Package responsibilities

### 3.1 `@roost/core` (`packages/core`)
Owns everything `STORAGE_SPEC.md` governs, so that the spec maps to exactly one package and a
reviewer has one place to check compliance. Six modules:

- `model` — domain vocabulary: `ContentHash`, `Kind`, `StorageMode`, `LinkMethod`, and the
  `RoostError` hierarchy. Pure, no I/O, trivially testable. A `ContentHash` is a branded string
  validated at construction, not a bare `string` — the whole system keys on it, and a
  lowercase-hex invariant that lives only in a comment is an invariant that is already broken.
- `db` — SQLite through `better-sqlite3`. Migration runner over `packages/core/migrations/`,
  `repo` for statements and `query` for the vocabulary a compiled search is expressed in.
  **All SQL is built and executed here**, with the single exception named in §3.4. The API is
  synchronous, because `better-sqlite3` is: it is a blocking, in-process library, and wrapping
  it in promises would buy an async veneer over the same blocking call. §4.1 is what makes that
  safe.
- `storage` — the `Storage` interface and its two implementations (§4.4). The only code in the
  workspace permitted to turn a hash into a path.
- `journal` — append-only JSONL writer, monthly rotation, and the replay engine.
- `platform` — everything OS-specific, behind one door (§6): XDG directories, reflink
  capability probing, file-manager reveal, single-instance lock, trash.
- `log` — a structured logger with pluggable sinks. Packages emit; the CLI and the engine
  install the sinks.

### 3.2 Write discipline
**One writer, by construction.** The engine process is single-threaded for database work, and
it is the only process that opens the database for writing. `SQLITE_BUSY` therefore cannot
happen between Roost's own connections — the case that remains is a second Roost instance on
the same library, which the single-instance lock (§6) is for.

Readers are free: WAL allows concurrent readers, and the main process opens exactly one
**read-only** connection for the `roost://` protocol (§4.3). That connection is the only place
outside the engine that touches SQLite at all, it is created by a `ThumbnailReader` factory in
`@roost/core`, and it may not be given a write statement.

### 3.3 `@roost/media` (`packages/media`)
Everything that touches file bytes:
- format detection (magic bytes first, extension as hint only)
- decode + downscale to the two thumbnail sizes the spec names, 256 and 512, WebP q80
- metadata extraction (EXIF, dimensions, duration, page count, font names)
- BLAKE3 content hashing, streamed, including the >50 MB partial scheme
- perceptual hashes and dominant colour → CIELAB (**M5**; the package owns them by charter)

Heavy or optional backends are runtime-probed, never hard dependencies: `ffmpeg`/`ffprobe` for
video, poppler or a bundled PDF renderer for PDF, raw decoders. If a backend is absent, the
asset still imports — it gets a placeholder thumbnail and a `capability_missing` note, never an
error.

`sharp` is the decode and encode path (ADR-0009). Its async API runs on libuv's threadpool, so
image work does not occupy the engine's event loop; `UV_THREADPOOL_SIZE` is raised to the core
count at engine start, because the default of four is a silent ceiling on import throughput.

### 3.4 `@roost/search` (`packages/search`)
RQL grammar → AST → a `WHERE` fragment with bound parameters. Zero string interpolation of user
input: the only text this package writes into SQL is text it chose itself, from a fixed set.
Property-tested parser. Folder paths are expanded to ids by a resolver the caller supplies,
which keeps recursive CTEs out of every compiled query and lets the package be tested without a
database. Similarity ranking — Hamming distance over phash, ΔE over LAB colours — belongs here
too, and arrives with **M5** alongside the hashes it ranks.

The statement around the fragment — projection, `ORDER BY`, the keyset predicate, `LIMIT` —
belongs to `@roost/core`'s search repository, so invariant 3 keeps meaning what it says.

### 3.5 `@roost/library` (`packages/library`)
The application service layer and the only public API worth calling:
- `Library.open(path)` / `create`, gated on `library.json`'s `roost_library_version`
- **Import pipeline** (§5)
- **Mutation service** (`edit`) — every user-authored change: tags, tag groups, folders, smart
  folders, ratings, notes, favourites, names. Journals before it indexes, and shares its index
  path with replay so an edit and its replay cannot diverge
- **Search façade** (`search`) — supplies `@roost/search` with a folder resolver, compiles,
  pages, counts
- **Thumbnails** (`thumbnails`) — the backfill pass, and lazy generation on first request
- **Integrity** (`doctor`) — checks over objects, index, and FTS; optional re-hash
- Replay and rebuild (`STORAGE_SPEC.md`), and `fixture` for synthetic libraries
- The **job runner**: a bounded, persisted queue with priorities and backpressure (**M4**)
- The **watcher**: debounced filesystem events feeding the queue (**M5**)
- The **event emitter** for progress and change notification, which the engine forwards to the
  renderer (§4.2)

### 3.6 `@roost/contract` (`packages/contract`)
The IPC surface as data: one union of request types, one union of event types, and a validator
per member. Both sides import it, so there is nothing to generate and nothing to drift — this
is the one genuine simplification the language change buys, and ADR-0007 is where it is argued.

It is also the trust boundary. A message arriving in the engine is validated against the
contract before it reaches a service, because a compromised renderer is exactly the threat the
sandbox exists for and TypeScript types are gone by then.

### 3.7 `@roost/cli` (`packages/cli`)
`roost` binary. Exercises every engine capability without a GUI:
`init`, `import`, `stats`, `show`, `tag`, `folder`, `smart`, `rate`, `note`, `favorite`,
`rename`, `remove`, `query`, `thumb`, `rebuild`, `doctor`, `fixture`. ADR-0005 makes it a
first-class frontend, so the GUI may not grow a capability the CLI lacks. Doubles as the
integration-test harness and works in headless containers where no window can open — which is
also how the engine gets tested without Electron.

## 4. Key mechanisms

### 4.1 Process and concurrency model

**M1 builds the engine as a library; M3 puts it in a process.** The split matters because it is
the one thing this architecture does differently from the Rust original, and the reason is
`better-sqlite3`: it blocks the thread it runs on.

| Where | Runs | Must never |
| --- | --- | --- |
| main | window and menu events, dialogs, `roost://` responses | block — a stalled main is a stalled window |
| renderer | React, virtualization | touch Node, or hold more than a screen of rows |
| engine (`utilityProcess`) | the whole `@roost/library` API, SQLite, journal writes | be shared with anything latency-sensitive |
| engine worker pool (`worker_threads`) | streamed hashing, journal replay parsing | touch the database |
| libuv threadpool | `sharp` decode/encode, `fs` | be left at the default size of 4 |

A synchronous transaction that takes 40 ms is a bug in a UI thread and merely a queue in the
engine. That is the whole justification for the extra process, and ADR-0006 is where the
alternative — engine in main, database work in worker threads — is weighed against it.

Backpressure is mandatory: the job queue is bounded and persisted, so a 100k-file import
survives a crash and resumes. **M4** — there is no `jobs` table yet, and adding one takes a
numbered migration. It needs no journal `op`: queued work is derived, not user-authored, so
invariant 9 does not reach it and losing the queue costs time rather than data. Until then a
crashed import is resumed by running the import again, which the content hash makes idempotent.

### 4.2 IPC contract
Types are **shared, not generated**. `@roost/contract` declares the request union, the response
type for each member, and the event union; `preload` exposes a single typed
`window.roost` object over `contextBridge`; `main` routes each request to the engine's
`MessagePort`; the engine validates and dispatches. ADR-0007 carries the argument, including
why the Rust project's generated-bindings rule does not translate.

Events (engine → renderer): `import:progress`, `job:progress`, `library:changed`,
`asset:updated`, `thumbnail:ready`. They travel the same port and are re-emitted by main to the
window; the renderer subscribes through the same typed surface.

Three rules the contract enforces rather than documents:
- **Every payload is validated at the receiving end.** Types vanish at runtime; the sandbox is
  only worth having if the process behind it distrusts what comes through.
- **Nothing that cannot be structured-cloned may appear in a message.** No class instances, no
  functions, no `Date` where a unix integer will do.
- **No bytes.** See §4.3. A `Uint8Array` in a contract type is a review failure.

### 4.3 Serving bytes — the `roost://` protocol
Registered in main with `protocol.handle`, which takes a `Request` and returns a `Response`.
Two routes:

- `roost://thumb/<hash>@256` and `@512` — the WebP BLOB, read through the main process's single
  read-only connection (§3.2) and returned as a `Response` with a one-year immutable cache
  header. A content-addressed URL's bytes cannot change, so the cache is free correctness.
- `roost://original/<hash>` — the asset's own bytes: from `originals/` for a managed asset, from
  the recorded path for a referenced one. Returned as a **stream**, with byte-range support, so
  a 4 GB video costs a chunk rather than its size.

This is where Electron is straightforwardly better than what it replaces. `roost-old` had to
cap whole-file responses at 64 MB and hand-roll 8 MB range replies, because Tauri's scheme
responder takes a whole buffer and has no streaming form (its ADR-0007). `protocol.handle`
accepts a `ReadableStream`, so the ceiling and the chunking machinery both disappear. ADR-0008
records that, and the one thing it costs: main now opens a database handle, which is a
deliberate exception to §3.2 taken because the alternative is bytes through IPC.

A missing thumbnail answers 404 with a short `Cache-Control`, not a bare 404. The grid learns
that a thumbnail is absent by asking for it — which is right, and avoids a `has_thumbnail`
column duplicating what the object store already answers — but `roost-old` found that scrolling
back over a folder of videos re-asks every time.

### 4.4 The `Storage` interface — the seam between the index and the bytes

```ts
export interface Storage {
  readonly mode: StorageMode;
  /** Places bytes and reports which link method succeeded. Never moves,
   *  modifies, or deletes the caller's file. Idempotent. */
  put(src: string, hash: ContentHash, ext: string): Promise<Placed>;
  locate(hash: ContentHash, ext: string): string;
  remove(hash: ContentHash, ext: string): Promise<void>;
  /** Walks the shard tree lazily. Powers rebuild verification, so it must not
   *  require the database to be present or correct. */
  iterAll(): AsyncIterable<StoredFile>;
}

export interface Placed {
  path: string;
  linkMethod: LinkMethod | null;   // null in referenced mode
  alreadyPresent: boolean;
}
```

Two implementations, deliberately asymmetric because the modes are:

- `ManagedStorage` — `originals/<2-hex>/<hash>.<ext>`, placing via reflink → hardlink → copy
  into a hidden temp name in the destination directory, then an atomic rename. A torn file must
  never appear at a real content address.
- `ReferencedStorage` — writes nothing, ever. `remove` is a no-op, `iterAll` is empty, and
  `locate` **throws by design**: a referenced asset's path is user-chosen, lives in
  `assets.ref_path`, and cannot be derived from a hash. Stubbing it to guess would be worse
  than failing.

**No code outside a `Storage` implementation may construct a path from a hash.** Shard
derivation lives in exactly one private function; callers reach it only through `locate`.

Reflink needed a second look that the Rust original did not, because Node exposes no `FICLONE`
ioctl. `fs.constants.COPYFILE_FICLONE` looks like one and is not — it is a hint that silently
falls back to a full copy and reports success either way, so it cannot decide what `link_method`
to record, and `link_method` goes in the journal.

**`COPYFILE_FICLONE_FORCE` can**, which is what ADR-0012 settles: it refuses rather than falling
back — measured at `EXDEV` across filesystems and `ENOTSUP` on a same-filesystem non-CoW target —
so success means it genuinely cloned. No native addon. A refusal is the ordinary answer on ext4
and moves to the next rung; it is not a failure and is not logged as one.

`put` deliberately does not `chmod` the placed file. Under a hardlink it is also the *user's*
file, so tightening permissions would reach into their directory.

### 4.5 Rebuild
`roost rebuild` deletes `index.db` and replays `journal/*.jsonl` in chronological order, oldest
month first, unknown ops skipped with a warning, torn trailing lines skipped with a warning.
FTS rows are rebuilt as part of replay, since they derive from state the journal carries.

Thumbnails do not come back with them: they derive from bytes, not from records, and
regenerating a million of them is a long job that should not be hidden inside a command the
user ran for a different reason. `rebuild` reports how many it discarded and says to run
`roost thumb`; the desktop app refills them in the background instead, where there is an idle
loop and a progress bar to do it honestly.

The spec mandates a test that deletes `index.db`, replays, and asserts equivalence with the
original database. It runs in CI on every commit. The guarantee "the DB is disposable" decays
into a lie unless it is tested continuously, and invariant 1 is the easiest one to leak as the
project grows.

**A second conformance test is specific to this repository:** a small library fixture,
committed, that was written by the Rust implementation. Opening it, replaying it, and hashing
the result must produce the same database this implementation would have written. Format
compatibility is a promise in `CONCEPT.md` §7; without that test it is a hope.

### 4.6 Performance strategy
- Grid virtualization: render only visible cells plus a small overscan.
- Thumbnails sized to device pixels; never ship a 4000px JPEG to the renderer.
- Query pagination is keyset-based on `(imported_at DESC, hash)`, never `OFFSET`.
  `idx_assets_imported` covers exactly that pair, so paging depth costs nothing.
- Filter indexes carry the sort key. `roost-old` measured 18.9 ms for `ext:png` against 0.51 ms
  once `(imported_at DESC, hash)` was inside the filter index — a 37× difference on the most
  ordinary query in the app. Migrations 0005 is carried over for exactly this reason
  (`DATA_MODEL.md` §2.4).
- Counts are estimated for huge result sets; exact counts only on demand.
- Import batches database writes (one transaction per ~500 assets) and defers FTS insert to
  batch end.
- Everything measured, at two scales: `roost fixture` builds a reproducible library and the CLI
  measures end to end, while micro-benchmarks measure the parts finely enough to see a query
  plan change. `roost-old`'s end-to-end timing once read a 2.5× climb in paging cost as noise
  for a day; the micro-benchmark found it as a clean straight line the first time it ran.
- Results, and what each measurement revealed, live in `docs/BENCHMARKS.md`. The Rust numbers
  are the baseline this implementation is measured against, not a target it is excused from.

## 5. Import pipeline

```
discover → probe → hash → dedupe → place bytes → journal → index → enqueue derived work
                                                                          │
                                    thumbnail ─ metadata ─ phash ─ colors ┘  (parallel)
```

1. **discover** — walk paths as an async iterator, applying ignore rules (`.git`, hidden, size
   caps). Never materialise a million paths into an array.
2. **probe** — magic bytes → `Kind`; reject unsupported early with a reason.
3. **hash** — BLAKE3, streamed, full below 50 MB, otherwise the partial scheme from the spec
   with `is_partial_hash = 1`. Runs in the worker pool.
4. **dedupe** — the hash *is* the identity, so a matching row means the asset already exists.
   Merge folder and tag intent onto the existing asset; do not create a second row. A duplicate
   decided by a *partial* hash is verified byte for byte against the stored bytes before
   merging, and refused if they differ — `STORAGE_SPEC.md` §Partial-hash collisions is the
   authority, and explains why a size check can never catch this.
5. **place** — `Storage.put`. Managed mode tries reflink → hardlink → copy and records
   `link_method`. Referenced mode writes nothing and stores `ref_path`.
6. **journal** — append the `add` record. **Journal before index, always.** A row in `index.db`
   with no journal line is data loss on the next rebuild.
7. **index** — one transaction per batch (~500 assets), FTS insert deferred to batch end.
8. **derive** — thumbnails and metadata queued at low priority; the UI shows placeholders and
   upgrades live via `thumbnail:ready`.

## 6. Cross-platform strategy (Linux now, others later)

Linux is the only target we build, test, and package in this cycle. Electron runs elsewhere,
which is a *smaller* excuse to be careless than Tauri was, not a bigger one: the toolkit
compiling on macOS does not mean the trash implementation, the reveal-in-file-manager call, or
the reflink probe do anything sensible there.

- All OS-specific behaviour lives in `@roost/core`'s `platform` module: XDG
  config/data/state/cache directories, file-manager reveal, reflink capability probing, trash,
  and a single-instance lock. Electron's `app.getPath` is *not* used for library-adjacent
  paths — it has its own opinions, and the XDG layout is what a Linux user expects.
- The single-instance lock is keyed by a hash of the library's canonical path and lives in
  `state_dir()/locks`, never inside the library: `STORAGE_SPEC.md` fixes the library layout at
  four entries, a pid is meaningless on another machine, and a read-only library must still
  open. The desktop app takes it when it opens a library; `roost rebuild` takes it too, being
  the one CLI command that rewrites a library whole. Ordinary reads and edits do not — two
  `roost tag` runs at once are a normal thing to want, and WAL is built for it.
- Non-Linux targets throw `UnsupportedPlatformError` from the platform module rather than
  guessing at a directory layout nobody has designed for. A port is then a deliberate act.
- No `process.platform` checks sprinkled through business logic — only inside `platform`.
- Paths are never assumed to be UTF-8-clean, case-insensitive, or `/`-separated. Node hands
  filenames back as strings with lone surrogates on Linux; anything that round-trips a path
  through a database and back must survive that.

### Where logs live

Not in the library. `STORAGE_SPEC.md` publishes the library layout and is binding: a library
holds `originals/`, `index.db`, `journal/`, and `library.json`, and nothing else. Logs go to
`$XDG_STATE_HOME/roost/logs`. Two destinations, different jobs: the terminal carries warnings
and errors so the person running a command sees what went wrong; the file carries structured
JSON at debug level so a problem reported days later can still be investigated.

## 7. Technology choices (summary; rationale in `docs/adr/`)

| Layer | Choice | Note |
| --- | --- | --- |
| Shell | Electron | Chromium renderer, Node engine, one language end to end (ADR-0001) |
| Language | TypeScript 7, ESM | strict, `erasableSyntaxOnly`, no `any`; targets Node 22, which is *not* Electron's Node — see ADR-0011 |
| DB | `better-sqlite3` + FTS5 | synchronous by design; WAL; derived cache (ADR-0003, ADR-0009) |
| Images | `sharp` (libvips) | decode and WebP q80 thumbnails at 256 and 512 (ADR-0009) |
| Hashing | native BLAKE3 binding, streamed | content identity; a perceptual hasher arrives with M5 |
| Reflink | `fs.copyFile` with `COPYFILE_FICLONE_FORCE` | Refuses rather than falling back, so `link_method` stays truthful; no addon (ADR-0012) |
| Frontend | React 19 + TypeScript + Vite | see `docs/UI_SPEC.md` (ADR-0002) |
| Virtualization | `@tanstack/react-virtual` | grid and list |
| IPC types | `@roost/contract`, shared | nothing generated, nothing to drift (ADR-0007) |
| Lint/format | Biome | one tool, and fast enough to run on every save |
| Testing | Vitest | plus a property-tested RQL parser and tests that read the docs |
| Packaging | electron-builder | AppImage, Flatpak, deb, rpm — **M6** |

## 8. Non-negotiable invariants

Violating any of these is a bug, regardless of what it enables:

0. **`docs/STORAGE_SPEC.md` is binding** and outranks this document. Its eight invariants and
   its Forbidden Patterns list govern storage, schema, import, and rebuild. Deviation requires
   explicit user approval.
1. The index is derivable from the journal plus `originals/`. Always. Any state that exists
   only in `index.db` is a bug.
2. No path is constructed from a hash outside a `Storage` implementation.
3. Every SQL statement is built and executed in `@roost/core`'s `db` module. The one exception
   is the `WHERE` fragment `@roost/search` compiles an RQL query into (§3.4), which arrives with
   its values bound rather than interpolated.
4. No business logic in `apps/desktop/main`.
5. No user input reaching SQL unparameterized.
6. Originals are never modified in place. Referenced-mode files are opened read-only, and
   nothing is ever written into user directories.
7. No network calls at runtime, except explicit user-initiated "import from URL".
8. `@roost/core` depends on no other workspace package.
9. Every user-authored mutation is journalled before it touches `index.db`.
10. The renderer is sandboxed, context-isolated, and reaches the engine only through the
    preload's typed surface.
11. Image bytes never travel through IPC, and are never base64-encoded.
