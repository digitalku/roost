# Roost — Concept

> A local-first digital asset manager. A Linux-first alternative to Eagle.cool,
> built in TypeScript on Electron. Proprietary software with an open format (ADR-0038).

Status: **Draft v2** · Last updated: 2026-09-08

---

## 1. The one-sentence pitch

**Roost is where your files land, get organized, and stay findable — tuned for images and
video, open to everything else, fully offline, fully yours, and fast enough to scroll a million
assets without stutter.**

## 2. Why this exists

Eagle.cool is the reference product for "visual asset manager": designers, artists, and
researchers use it to hoard references, screenshots, mockups, textures, fonts, and video
clips, then find them again months later. It is excellent — and it does not ship for Linux, and it
locks your metadata into a format you do not control.

Roost is proprietary too (ADR-0038), so the complaint is deliberately the second one and not the
first. Source availability is not what decides whether you can leave: a documented format, a plain
JSONL journal, and files named and laid out so that another program can read them without asking
this one. Those are promises this product keeps whether or not its own code is published.

Linux users today fall back to a pile of compromises:

| Tool | Gap |
| --- | --- |
| Digikam | Photo-centric, heavy UI, weak for design assets/fonts/mockups |
| Shotwell / gThumb | Photo viewers, no tag hierarchy, no smart folders |
| Nextcloud Memories | Server required, browser-bound, slow at scale |
| Obsidian + folders | No visual grid, no image search |
| Plain filesystem | Works until ~5k files, then discovery collapses |

Roost fills that hole: an offline-first app that treats visual assets as first-class citizens —
and everything else as a citizen, because a reference folder is never only images.

## 3. Principles

These are load-bearing. When a design decision is contested, resolve it against this list in
order.

1. **Local-first, no account.** No cloud, no telemetry, no login. Ever. Optional sync is the
   user's own (Syncthing, Nextcloud, git-annex) and Roost must not break it.
2. **Your data outlives the app.** Every user-authored change is appended to a plain-text JSONL
   journal on disk. The database is a *rebuildable cache*, never the only copy. If Roost
   disappears tomorrow, a `jq` one-liner recovers everything.
3. **Fast at scale, or it is not shipped.** Targets are hard: 1M assets indexed, 60fps grid
   scroll, sub-100ms search. Features that break these get redesigned, not merged.
4. **Nothing is written into your folders.** Roost never edits, moves, or renames a file outside
   the library unless explicitly told to — an import copies by default, and moves only when
   asked. Inside the library the opposite is the point: it is a **workspace**, and a file there
   is meant to be opened in the application that owns it, edited, and saved (ADR-0046).
5. **Linux-native first, portable by construction.** We ship for Linux first and target it
   properly (XDG, portals, Flatpak, reflinks). Electron runs on all three desktops, but that is
   not the same as *supporting* them: OS-specific behaviour lives behind one module, and macOS
   and Windows are a deliberate later act, not a side effect of the toolkit.
6. **The engine is usable without the GUI.** A headless CLI drives the same core. This keeps
   the architecture honest and makes automation trivial.

## 4. Who it is for

- **P1 — The Reference Hoarder (primary).** Illustrator/designer with 50k–500k images across
  scattered folders. Needs: fast import, tags, color search, "find that one blue poster I saved
  in 2023".
- **P2 — The Working Designer.** Manages project assets: mockups, exports, brand kits, fonts.
  Needs: folders per client, smart folders, version stacking, quick preview of PSD/AI/SVG/fonts.
- **P3 — The Media Archivist.** Video clips, audio samples, 3D models. Needs: format breadth,
  duration/codec metadata, scrubbing preview.
- **P4 — The Linux Power User.** Wants CLI access, scriptability, plain-file storage, no vendor
  lock-in. Is the loudest advocate if we get storage format right.

## 5. Scope

**What a library may hold: anything.** A file Roost cannot draw still imports, still carries
tags, folders, a rating, and a note, still turns up in search, and still deduplicates against
everything else. The format decides whether there is a thumbnail and whether the preview can
render it — never whether the file belongs. What Roost cannot draw, the desktop's own handler
opens (`UI_SPEC.md` §7).

**The optimisation is media, and that is not a hedge.** Thumbnails, the masonry grid, the
preview pane, dimensions, duration, and perceptual hashing are all built for images and video,
and the performance targets in §7 are stated against them. A `.blend` in a Roost library is an
organised, findable, deduplicated `.blend`. It is not a rendered one, and it is not going to be.

The engine has held this shape since M1: `unknown` is a format like any other, and its kind is
`other` rather than an error. `packages/library/tests/import.test.ts` pins it against a `.txt`,
a `.blend`, a `.zip`, and a file with no extension at all.

### 5.1 Feature parity map (vs Eagle)

Legend: **M** = must have (v1.0) · **S** = should have · **C** = could have · **W** = won't (this cycle)

**Import**
- M — Drag & drop files/folders into the app
- M — Import folder tree, preserving structure as Roost folders
- M — Watched folders (auto-import on new file)
- M — Duplicate detection at import (exact hash + perceptual near-dup)
- S — Clipboard / screenshot capture
- S — Import from URL
- C — Browser extension (clip images from web pages)
- W — Cloud service connectors (Dropbox/Drive/Figma API)

**Organize**
- M — Nested folders (an asset can live in multiple folders — folders are *collections*, not paths)
- M — Tags, flat and globally unique, arranged into groups with colors
- M — Star ratings (0–5)
- M — Smart folders (saved queries that auto-populate)
- M — Notes / annotations per asset
- M — Comments, many per asset, each optionally at a moment in a video or an audio track
- S — Colors auto-extracted per asset, filterable
- S — Version stacking (group revisions of the same asset)
- C — On-image annotations (arrows, boxes, comments)

**Browse**
- M — Masonry/waterfall grid, virtualized
- M — Uniform grid + list/table view
- M — Sort: date added, date created, name, size, rating, dimensions, random
- M — Filter panel: type, tag, folder, rating, color, dimension, duration, date range
- S — Timeline / calendar view
- C — Map view (GPS EXIF)

**Search**
- M — Full-text over name, tags, notes, folder names (FTS5)
- M — Structured query syntax (`tag:blue rating:>=4 type:image w:>2000`)
- S — Color similarity search ("show me everything in this palette")
- S — Similar image search (perceptual hash / embedding)
- C — OCR text inside images, searchable
- C — Local ML auto-tagging (CLIP-style, on-device, opt-in)

**Preview**
- M — Images: JPEG, PNG, WebP, AVIF, GIF, BMP, TIFF, SVG
- M — Video: MP4, WebM, MKV, MOV (thumbnail + playback)
- M — Audio: waveform + playback
- M — PDF: first-page thumbnail + page-through
- S — Fonts: TTF/OTF/WOFF specimen rendering
- S — RAW photos: CR2, NEF, ARW, DNG
- S — Design files: PSD, XCF, AI (thumbnail via embedded preview)
- M — **Anything else: the thumbnail if there is one, the metadata, and Open externally.** A
  format Roost cannot draw is not a dead end
- C — 3D: GLB, OBJ, STL
- W — Live Figma/Sketch rendering

**Library**
- M — Multiple libraries, switchable
- M — Portable library folder (copy it to another machine, it just works)
- M — Import moves or copies, and says which it did (~~two storage modes~~ — one, since ADR-0046)
- M — Full DB rebuild by replaying the journal
- M — ~~Opens a library written by the Rust implementation~~ — retired with format 1 (ADR-0046)
- S — Export/backup a folder or selection with metadata
- C — Merge two libraries

### 5.2 Explicit non-goals

- Not a photo *editor*. No retouching, no filters, no layers.
- Not a cloud service. No sync server, no sharing links, no accounts.
- Not a DAM for teams. Multi-user, permissions, and check-in/check-out are out of scope.
- Not a file manager replacement. A library holds what was imported into it; Roost does not
  browse arbitrary filesystems. Accepting any file is not the same as replacing the thing that
  browses every file.
- Not open source. Roost is proprietary and distributed as a binary (ADR-0038). What is open is
  the format: the journal, the layout, and the specification that documents them.
- No telemetry, no crash reporting phone-home, no auto-update that talks to us silently.
- Not a web app. The renderer runs against a local engine over a private protocol; it is not
  going to be hosted, and no code should be written to keep that door open.

## 6. What makes Roost better than a clone

These are the differentiators worth building, not just parity items:

1. **Journal-truth storage.** Every change appended to a monthly JSONL file. Survives app
   death, reads in any text editor, doubles as an audit log, and rebuilds the database on
   demand — without the million-sidecar file explosion that approach usually brings.
2. **A library you can work in.** A file in the library is a file: open it in the application
   that owns it, edit it, save it, and it is still the same asset with the same tags, rating and
   comments. That is what a content-addressed store could never do, and why the format is at
   version 2 (ADR-0046). ~~Referenced libraries~~ were the version 1 answer to the same wish and
   are retired.
3. **Reflink import.** On Btrfs/XFS, "copying" into the library costs zero bytes, and the
   library copy is still **independent** — a reflink is a separate file, not a shared inode, so
   editing it in the library cannot reach back into the original (RL-26).
4. **A real query language.** `tag:texture AND NOT tag:wip color:#3a7 rating:>=4` in the search
   bar, saveable as a smart folder.
5. **Headless CLI.** `roost import ~/Downloads --tag inbox`, `roost query 'tag:blue' --json`.
   Scriptable, cron-able, pipe-able.
6. **Honest performance.** Virtualized everything, thumbnails on a worker pool, incremental
   indexing, no "loading 40k items" spinner.
7. **Open format, documented, and owned by nobody.** The library layout is a numbered spec in
   its own repository, `../roost-library`, with an operation registry and a conformance suite —
   not a reverse engineering project, and not this implementation's to change unilaterally
   (ADR-0045). The application is proprietary; the format is not, and M6 publishes the spec for
   other implementers (ADR-0038).

## 7. Success criteria for v1.0

- Import 100,000 mixed assets without exhausting memory, at ≥300 files/sec for
  thumbnail-cached formats.
- Cold app start to interactive grid: < 1.5s on a 100k-asset library.
- Grid scroll: sustained 60fps with 4k-resolution thumbnails.
- Search p95: < 100ms on 1M rows.
- Delete `index.db` → full rebuild from the journal with zero metadata loss (CI-enforced).
- `../roost-library`'s conformance suite passes (CI-enforced, RL-52) — a library written by
  hand in another repository replays here to the state that repository publishes. **Reading
  `roost-old`'s libraries was dropped on 2026-09-21** along with the format that made it possible
  (ADR-0046): a version 1 library is refused by name. What is still promised is the line above it
  — the journal rebuilds the index — because that, not another implementation, is what makes the
  format durable.
- A file edited in place by the application that owns it stays the same asset, with its tags,
  rating, note and comments intact (RL-20). That is the promise version 2 exists for.
- Ships as AppImage + Flatpak + .rpm/.deb, with native modules bundled and no runtime
  dependency surprises.

## 8. Risks and open questions

| Risk | Mitigation |
| --- | --- |
| Electron cold start eats the 1.5s budget before the app does anything | Measure from M3, the milestone that first has a window; V8 snapshot and lazy module loading are the levers, and the engine process starts in parallel with the window |
| Synchronous SQLite blocks whatever thread it is on | The engine owns its own process; nothing that serves UI or bytes shares a thread with it (ADR-0006) |
| Native modules make packaging fragile | Three of them, all with upstream prebuilt binaries, built natively per target in CI. A fourth was proposed for reflink and measured away (ADR-0009, ADR-0012) |
| A JS engine is slower than the Rust one it replaces | Hashing, decoding, and encoding are all in native code already; what stays in JS is orchestration. Re-measure against `roost-old`'s numbers rather than guessing — that is what `BENCHMARKS.md` is for |
| Thumbnail generation blocks the app | Dedicated worker pool with a bounded queue, never on the process that answers IPC |
| Format breadth pulls in heavy dependencies | Optional and runtime-probed; degrade gracefully when `ffmpeg`/`poppler` are absent |
| Journal + DB drift | Single write path, journal written first, DB is derived; `roost doctor` consistency scan |
| Scope creep into "photo editor" | Non-goals section is binding |
| Solo/long-horizon project loses context | Docs-first workflow — see CLAUDE.md session protocol |

## 9. Related documents

- `../roost-library/SPEC.md` — **normative** library format, version 2 (RL-1…RL-56); `docs/STORAGE_SPEC.md` maps it to the code
- `docs/ARCHITECTURE.md` — how it is built
- `docs/DATA_MODEL.md` — query language and schema growth plan
- `docs/UI_SPEC.md` — the interface, designed for this stack rather than ported
- `docs/ROADMAP.md` — milestones and acceptance criteria
- `docs/adr/` — architecture decision records
- `docs/SESSION_LOG.md` — running work log across sessions
