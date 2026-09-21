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
│                    (everything the library format governs)            │
│    └── worker pool     hashing, replay parsing — CPU-bound JS only    │
└──────────────────────────────────────────────────────────────────────┘
```

**Rule:** the main process contains no business logic. Every IPC handler is
`validate → forward to engine → return`. If a handler body exceeds ~20 lines, the logic belongs
in `@roost/library`. This is what keeps the CLI honest and a future non-Electron frontend
possible.

Two things deliberately do **not** follow the arrows. Thumbnails and asset files reach the
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
│   │   ├── migrations/        # numbered SQL; DATA_MODEL.md §2 publishes each one
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
Owns everything the library format governs, so that the standard maps to exactly one package and a
reviewer has one place to check compliance. Six modules:

- `model` — domain vocabulary: `AssetId`, `Kind`, `Take`, `Placement`, and the `RoostError`
  hierarchy. Pure, no I/O, trivially testable. An `AssetId` is a branded string validated at
  construction, not a bare `string` — the whole system keys on it, and twelve characters of
  Crockford base32 (RL-13) is an invariant that would already be broken if it lived only in a
  comment. `mintAssetId` is here too, because minting is vocabulary before it is storage.
- `db` — SQLite through `better-sqlite3`. Migration runner over `packages/core/migrations/`,
  `repo` for statements and `query` for the vocabulary a compiled search is expressed in.
  **All SQL is built and executed here**, with the single exception named in §3.4. The API is
  synchronous, because `better-sqlite3` is: it is a blocking, in-process library, and wrapping
  it in promises would buy an async veneer over the same blocking call. §4.1 is what makes that
  safe.
- `storage` — the `Storage` interface and the one implementation there is (§4.4). The only
  code in the workspace permitted to turn an **id** into a path.
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
outside the engine that touches SQLite at all. It is `ReadOnlyIndex` in `@roost/core` — ADR-0008
proposed the name `ThumbnailReader`, and it answers where an asset's file is as well, because
`roost://file/<id>` needs the same connection and a second one would be a second
exception. It exposes three lookups and no way to write, and SQLite refuses a write on it
regardless, which is what a test asserts rather than the flag that asks for it.

### 3.3 `@roost/media` (`packages/media`)
Everything that touches file bytes:
- format detection (magic bytes first, extension as hint only)
- decode + downscale to the two thumbnail sizes the spec names, 256 and 512, WebP q80
- metadata extraction (EXIF, dimensions, duration, page count, font names)
- BLAKE3 content hashing, streamed over the whole file. **Derived, never identity** (RL-18):
  version 1's partial scheme existed so that a 4 GB video could be *identified* without reading
  it, and identity no longer comes from the bytes
- perceptual hashes and dominant colour → CIELAB (**M5**; the package owns them by charter)

**Four backends since M4, behind one dispatcher** (`derive.ts`), each answering with the same
two things — thumbnails and metadata — so that adding a format is a case in one `switch`:

| Backend | Draws | Ships with Roost |
| --- | --- | --- |
| `sharp` | JPEG, PNG, WebP, GIF, TIFF, AVIF, and a RAW's embedded preview | yes (ADR-0009) |
| resvg in WebAssembly | SVG, and the font specimens composed from glyph outlines | yes (ADR-0015) |
| pdfium in WebAssembly | PDF pages and page counts | yes (ADR-0016) |
| the system's `ffmpeg` | video frames and durations, audio waveforms | **no** (ADR-0017) |

Only the last is optional, and its absence is a **capability** the UI reports rather than an
error: the asset still imports, and the queue parks the work with a reason until the tool exists
(`DATA_MODEL.md` §2.5). The two WebAssembly backends are the answer to a security question, not
a packaging one — a module with no filesystem cannot follow a reference out of an SVG or a PDF.

`sharp` is the decode and encode path (ADR-0009), imported in exactly one module — `decoder.ts` —
so that replacing it is a contained change rather than a survey. Its async API runs on libuv's
threadpool, so image work does not occupy the engine's event loop.

**That pool cannot be widened by the process that wants it**, which this section claimed for
three milestones and M4 measured: libuv reads `UV_THREADPOOL_SIZE` once and creates the pool on
first use, and module loading has already used it before an entry point runs. Setting it inside
the process measured 181 thumbnails/sec against 205 for the plain default — noise around no
effect. Setting it for a process that has not started yet reaches 252–327, so **main forks the
engine with it set** (`threadPoolEnv` in `@roost/core`), and `roost doctor` reports what the
current process actually got.

**That is about `sharp` specifically**, and not a general setting. Image work does real CPU work
on those threads; a `stat` or a `rename` does not, and widening the pool for the import
pipeline's filesystem calls measured as no gain up to 16 in flight and a loss at 32. See
`BENCHMARKS.md`.

**Where it can run is not "everywhere" (ADR-0013).** The prebuilt `sharp` bundles its own GLib;
the Electron binary on Linux links the system's; two type registries in one process make the
first decode segfault. The CLI is unaffected — it runs on the system's Node — and the Linux
build of the app has to supply libvips itself. `scripts/probe-native.ts` decodes and encodes
rather than calling `require`, because loading is exactly the part that succeeds.

**BMP is still recognised and not drawn**: libvips has no loader for it, and nothing else here
does either. SVG was the second such format until M4; what changed is not librsvg — measured
again on 2.62.3, it still reads a neighbouring file whenever it is handed a path — but where the
rasterising happens (ADR-0015).

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
- **Integrity** (`doctor`) — checks over files, index and FTS: an id with no file (RL-25), an
  id with two (RL-12), a file no id claims, and a name that is not an id at all (RL-11). A file
  whose bytes have moved on is **not damage** (RL-20) — it is work for the derive queue
- Replay and rebuild (RL-35 to RL-41), and `fixture` for synthetic libraries
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
survives a crash and resumes. **Landed in M4** as migration 0006 (`DATA_MODEL.md` §2.5). It
carries no journal `op`: queued work is derived, not user-authored, so invariant 9 does not reach
it and losing the queue costs time rather than data — a sweep re-queues whatever has no
thumbnail. A `running` row describes a process, so the runner returns them to the queue when it
starts.

### 4.2 IPC contract
Types are **shared, not generated**. `@roost/contract` declares the request union, the response
type for each member, and the event union; `preload` exposes a single typed
`window.roost` object over `contextBridge`; `main` routes each request to the engine's
`MessagePort`; the engine validates and dispatches. ADR-0007 carries the argument, including
why the Rust project's generated-bindings rule does not translate.

Events (engine → renderer): `import:progress`, `job:progress`, `library:changed`,
`asset:updated`, `thumbnail:ready`. They travel the same port and are re-emitted by main to the
window; the renderer subscribes through the same typed surface.

**Two requests are answered by main itself**: `dialog:openLibrary` and
`dialog:chooseLocation`. A dialog belongs to a window and the engine has none, so they cannot
be forwarded. They stay requests rather than becoming a second channel, because the renderer
having exactly one way to ask for anything is worth more than main holding no handlers at all
(ADR-0014).

Three rules the contract enforces rather than documents:
- **Every payload is validated at the receiving end.** Types vanish at runtime; the sandbox is
  only worth having if the process behind it distrusts what comes through.
- **Nothing that cannot be structured-cloned may appear in a message.** No class instances, no
  functions, no `Date` where a unix integer will do.
- **No bytes.** See §4.3. A `Uint8Array` in a contract type is a review failure.

### 4.3 Serving bytes — the `roost://` protocol
Registered in main with `protocol.handle`, which takes a `Request` and returns a `Response`.
Two routes:

- `roost://thumb/<id>@256` and `@512` — the WebP BLOB, read through the main process's single
  read-only connection (§3.2). A pinned frame goes in the query string, so a changed poster is a
  changed address (ADR-0024). **The bytes behind an id may change** (RL-20), so the cache header
  is not `immutable` the way version 1's content-addressed one could be: the derive that notices
  an edited file is what makes the cell redraw.
- `roost://file/<id>` — the asset's own bytes, from `files/` and nowhere else (RL-19). Returned
  as a **stream**, with byte-range support, so a 4 GB video costs a chunk rather than its size.
  The size is read from the file rather than from the index, because a range answered against a
  stale size hands a player the wrong bytes.
- `roost://page/<id>/<index>@<width>` (**M4**) — one page of a document, rendered on demand and
  cached like a thumbnail, since the id, the page, and the width fix the pixels. Neither a
  stored thumbnail nor the file itself: page-through needs a picture per page, and a library that
  stored one per page would be storing a rendering nobody asked for. The width is a fixed set for
  the same reason the thumbnail sizes are.

Rendering a page in main is a deliberate exception of the same kind as the database handle below,
and it is affordable for two reasons: the backend is WebAssembly rather than a native decoder,
and it is imported lazily, so a window that never opens a document never loads it. The bitmap is
encoded by a 60-line PNG writer over `node:zlib` (`@roost/media/png`) — main must not load
`sharp`, and an uncompressed bitmap would be three megabytes a page.

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
  /** The only way an id becomes a path. */
  locate(id: AssetId, ext: string): string;
  /** Places a file, moving or copying it as `take` says (RL-26). The result is
   *  an independent file: a reflink is one, a hardlink is not. */
  put(src: string, id: AssetId, ext: string, take: Take): Promise<Placed>;
  /** Writes bytes over an asset's file. An ordinary edit (RL-20), journalled
   *  by nothing (RL-23). */
  writeBytes(bytes: Uint8Array, id: AssetId, ext: string): Promise<string>;
  remove(id: AssetId, ext: string): Promise<void>;
  /** Every file an id has. One usually; two is RL-12's case; none is RL-25's. */
  findFiles(id: AssetId): Promise<readonly StoredFile[]>;
  /** Walks the shard tree lazily. Powers rebuild verification, so it must not
   *  require the database to be present or correct. */
  iterAll(): AsyncIterable<StoredFile>;
  /** Paths whose names are not ids — a lock file an editor left (RL-11). */
  iterUnrecognised(): AsyncIterable<string>;
}

export interface Placed {
  path: string;
  take: Take;           // what happened to the source, which RL-26 requires be told
  placement: Placement; // rename | reflink | copy — for the log, never journalled
}
```

**One implementation**, because version 2 has one storage mode (RL-19). `FileStore` writes
`files/<2-char>/<id>.<ext>`: a move within one filesystem is a rename, and everything else goes
through a copy-on-write clone or a full copy into a hidden temp name in the destination
directory, then an atomic rename.

**There is no hardlink rung**, and that is RL-26 rather than a preference: a shared inode would
mean editing the file inside the library edits the user's file outside it, which is precisely
what a workspace must not do. `storage.test.ts` asserts it on the inode rather than on the code.

**Nothing in the store is immutable.** The bytes may change at any time, by any application,
without the library being told (RL-20), and no method may assume the file it placed is the file
it will read back. Nor may anything hold a file open in a way that stops another application
writing, renaming or deleting it (RL-21) — the failure that prevents is Word saying *"the file
is in use"* about a file the user opened from Roost, with the preview pane as the culprit.

**No code outside a `Storage` implementation may construct a path from an id.** Shard
derivation lives in exactly one function; callers reach it only through `locate`.

Reflink needed a second look that the Rust original did not, because Node exposes no `FICLONE`
ioctl. `fs.constants.COPYFILE_FICLONE` looks like one and is not — it is a hint that silently
falls back to a full copy and reports success either way, so it could never say which placement
actually happened.

**`COPYFILE_FICLONE_FORCE` can**, which is what ADR-0012 settles: it refuses rather than falling
back — measured at `EXDEV` across filesystems and `ENOTSUP` on a same-filesystem non-CoW target —
so success means it genuinely cloned. No native addon. A refusal is the ordinary answer on ext4
and moves to the next rung; it is not a failure and is not logged as one.

`put` deliberately does not `chmod` the placed file: a copy inherits what the source had, and
inventing a stricter mode would surprise anybody who set one.

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

**The second conformance test is the standard's own** (RL-52): `conformance/library.roost`, a
journal written by hand in another repository, replayed here and compared against the state
`expected.json` publishes. Version 1 also carried a fixture written by `roost-old`; that
obligation is retired with the format (RL-6a), and the fixture went with it.

### 4.6 Performance strategy
- Grid virtualization: render only visible cells plus a small overscan.
- Thumbnails sized to device pixels; never ship a 4000px JPEG to the renderer.
- Query pagination is keyset-based on `(imported_at DESC, id DESC)`, never `OFFSET`.
  `idx_assets_imported` covers exactly that pair, so paging depth costs nothing.
- Filter indexes carry the sort key. `roost-old` measured 18.9 ms for `ext:png` against 0.51 ms
  once the sort key was inside the filter index — a 37× difference on the most ordinary query in
  the app (`DATA_MODEL.md` §2.0).
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
discover → hash → duplicate check → mint id → place bytes → probe → journal → index → derive
                                                                                        │
                                    thumbnail ─ metadata ─ phash ─ colors ┘  (parallel)
```

1. **discover** — walk paths as an async iterator, applying ignore rules (`.git`, hidden, size
   caps). Never materialise a million paths into an array.
2. **hash** — BLAKE3, streamed over the whole file. Derived data (RL-18), not an address.
3. **duplicate check** — a **decision**, not a consequence. Identity is an id, so a second copy
   of the same bytes *could* be a second asset; this build skips it and reports it instead,
   because re-importing a directory is the ordinary way to produce duplicates (ADR-0046 §5).
4. **mint** — `mintAssetId`, checked against the library **and** the uncommitted batch (RL-15).
5. **place** — `Storage.put`, moving or copying as the run was told, and recording which
   happened so the report can say so (RL-26).
6. **probe** — magic bytes and a header read, for the dimensions a grid lays a cell out with.
   Derived (RL-22), so it goes to the index and never to the journal.
7. **journal** — append the `add`: an id, an extension, a name without its extension (RL-33),
   and the source file's date. **Journal before index, always.** A row in `index.db` with no
   journal line is data loss on the next rebuild.
8. **index** — one transaction per batch (~500 assets), carrying the rows, what was measured,
   and the derive jobs together. FTS insert deferred to batch end.
9. **derive** — thumbnails and metadata queued **in the same transaction as the rows** (M4), so
   an asset and the intent to derive it are committed together. The queue is claimed by a runner
   in the engine, which emits `job:progress`; the UI shows placeholders and re-reads when a run
   finishes. Work nobody can do — a format with no backend, a tool that is not installed — is
   parked with a reason rather than retried, which is what makes a backfill sweep converge.

## 6. Cross-platform strategy (Linux now, others later)

Linux is the only target we build, test, and package in this cycle. Electron runs elsewhere,
which is a *smaller* excuse to be careless than Tauri was, not a bigger one: the toolkit
compiling on macOS does not mean the trash implementation, the reveal-in-file-manager call, or
the reflink probe do anything sensible there.

- All OS-specific behaviour lives in `@roost/core`'s `platform` module: the
  config/data/state/cache directories, file-manager reveal, reflink capability probing, trash,
  and a single-instance lock. Those directories are XDG on Linux and the two known folders on
  Windows — `%APPDATA%\roost\{config,data}` for what may roam between a user's machines and
  `%LOCALAPPDATA%\roost\{state,cache}` for what must not (ADR-0041). Electron's `app.getPath`
  is *not* used for library-adjacent paths — it has its own opinions, and each platform's own
  layout is what its users expect.
- The single-instance lock is keyed by a digest of the library's canonical path and lives in
  `state_dir()/locks`, never inside the library: RL-4 makes the library root a reserved namespace
  at four entries, a pid is meaningless on another machine, and a read-only library must still
  open. The desktop app takes it when it opens a library; `roost rebuild` takes it too, being
  the one CLI command that rewrites a library whole. Ordinary reads and edits do not — two
  `roost tag` runs at once are a normal thing to want, and WAL is built for it.
- **macOS** throws `UnsupportedPlatformError` from the platform module rather than guessing at
  a directory layout nobody has designed for. A port is a deliberate act, and Windows has had one
  since ADR-0041 — a machine the work is done on rather than a target that is packaged, which is
  why it resolves directories instead of refusing.
- No `process.platform` checks sprinkled through business logic — only inside `platform`.
- Paths are never assumed to be UTF-8-clean, case-insensitive, or `/`-separated. Node hands
  filenames back as strings with lone surrogates on Linux; anything that round-trips a path
  through a database and back must survive that.

### Where logs live

Not in the library. RL-4 makes the library root a reserved namespace: a library
holds `files/`, `index.db`, `journal/`, and `library.json`, and nothing else. Logs go to
`$XDG_STATE_HOME/roost/logs`, and to `%LOCALAPPDATA%\roost\state\logs` on Windows. Two
destinations, different jobs: the terminal carries warnings and errors so the person running a
command sees what went wrong; the file carries structured JSON at debug level so a problem
reported days later can still be investigated.

## 7. Technology choices (summary; rationale in `docs/adr/`)

| Layer | Choice | Note |
| --- | --- | --- |
| Shell | Electron | Chromium renderer, Node engine, one language end to end (ADR-0001) |
| Language | TypeScript 7, ESM | strict, `erasableSyntaxOnly`, no `any`; targets Node 22, which is *not* Electron's Node — see ADR-0011 |
| DB | `better-sqlite3` + FTS5 | synchronous by design; WAL; derived cache (ADR-0003, ADR-0009) |
| Images | `sharp` (libvips) | decode and WebP q80 thumbnails at 256 and 512 (ADR-0009) |
| Hashing | native BLAKE3 binding, streamed | a **derived** attribute (RL-18), not an address; a perceptual hasher arrives with M5 |
| Reflink | `fs.copyFile` with `COPYFILE_FICLONE_FORCE` | Refuses rather than falling back, so the placement reported is the placement that happened; no addon (ADR-0012) |
| Frontend | React 19 + TypeScript + Vite | see `docs/UI_SPEC.md` (ADR-0002) |
| Virtualization | `@tanstack/react-virtual` | grid and list |
| IPC types | `@roost/contract`, shared | nothing generated, nothing to drift (ADR-0007) |
| Lint/format | Biome | one tool, and fast enough to run on every save |
| Testing | Vitest | plus a property-tested RQL parser and tests that read the docs |
| Packaging | electron-builder | AppImage, Flatpak, deb, rpm — **M6** |

## 8. Non-negotiable invariants

Violating any of these is a bug, regardless of what it enables:

0. **`../roost-library/SPEC.md` is normative** and outranks this document. Requirements `RL-1`
   … `RL-56` and RL-56's forbidden list govern storage, import and rebuild — not the schema,
   which RL-3 leaves to each implementation. It is **not this repository's document**: a change
   to it is proposed there, against that repository's `CHANGING.md`, and raises a document
   revision or a format version (ADR-0045). **This build reads format 2 only**, and refuses a
   version 1 library by name without reading a byte of it (RL-6a, ADR-0046).
1. The index is derivable from the journal plus `files/`. Always. Any state that exists
   only in `index.db` is a bug — except the two marks that say how far the index has folded
   each journal month, which are a **cache of the fold** and are discarded, never trusted, when
   they disagree with the file.
2. No path is constructed from an **id** outside a `Storage` implementation.
3. Every SQL statement is built and executed in `@roost/core`'s `db` module. The one exception
   is the `WHERE` fragment `@roost/search` compiles an RQL query into (§3.4), which arrives with
   its values bound rather than interpolated.
4. No business logic in `apps/desktop/main`.
5. No user input reaching SQL unparameterized.
6. Nothing is ever written into a user directory. A file **inside** the library is a different
   matter: it is a workspace, and an edit over it is ordinary (RL-20). Nothing may hold one open
   in a way that stops another application writing to it (RL-21).
7. No network calls at runtime, except explicit user-initiated "import from URL".
8. `@roost/core` depends on no other workspace package.
9. Every user-authored mutation is journalled before it touches `index.db`.
10. The renderer is sandboxed, context-isolated, and reaches the engine only through the
    preload's typed surface.
11. Image bytes never travel through IPC, and are never base64-encoded.
