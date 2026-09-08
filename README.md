<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/roost-logo-dark.svg">
  <img src="assets/brand/roost-logo.svg" alt="Roost" height="64">
</picture>

A local-first digital asset manager — a Linux-first alternative to Eagle.cool.
Electron shell, TypeScript engine, React interface. Your files stay yours.

> **Status: M0 through M4 are done; it runs from source and is not packaged yet.** The engine, the
> headless CLI, the desktop window, and the format backends — images, video, audio, PDF, SVG,
> fonts — all work. Import, organize, search, preview, and edit a library today by following
> [docs/SETUP.md](docs/SETUP.md); `pnpm dev` opens the window and `pnpm --filter @roost/cli start
> -- --help` lists the CLI. What is left is M5 (discovery: colour, near-duplicates, watched
> folders) and M6 (packaging, preferences, undo, onboarding), both deferred while the feature set
> settles. [docs/ROADMAP.md](docs/ROADMAP.md) has the milestone detail and
> [docs/SESSION_LOG.md](docs/SESSION_LOG.md) is the running work log.
>
> This is a rewrite. An earlier Roost exists in Rust and Tauri, complete through its desktop
> shell; this repository re-implements the engine in TypeScript on Electron and rebuilds the
> interface from scratch. **The library format is carried over** — a library that
> implementation wrote opens here, and a test proves it. The reverse stopped being a requirement
> on 2026-08-29, when that project was discontinued: the schema has moved on since (it is at v13),
> and nothing here is traded away to keep an abandoned build's approval.

## Why

Eagle.cool is the reference product for visual asset management, and it does not ship for Linux.
Roost aims at the same job — collect, organize, and re-find tens of thousands of images, videos,
fonts, and design files — while being offline-first, honest about performance, and open about the
format your metadata is kept in.

## Principles

- **Local-first.** No account, no cloud, no telemetry.
- **Your data outlives the app.** Every change is appended to a plain JSONL journal; the database
  is a rebuildable cache you can delete at any time.
- **Fast at scale.** 1M assets, 60fps grid, sub-100ms search — treated as requirements.
- **Non-destructive.** Originals are never modified in place; existing folders can be indexed
  without copying.
- **Scriptable.** The engine ships as a headless CLI too, and the interface may not do anything
  the CLI cannot.

## Install

There is no package yet — Linux packaging is M6 — so Roost is installed by building this
repository. On Fedora:

```bash
sudo dnf install -y nodejs npm gcc-c++ make python3 vips-devel \
                    nss gtk3 libX11 alsa-lib ffmpeg-free
corepack enable

git clone <this repo> && cd roost
pnpm install
pnpm start
```

`vips-devel` is not optional on Linux. `sharp` is built from source against the system's libvips,
because the prebuilt binary bundles its own GLib and segfaults inside Electron on the first decode
(ADR-0013); the install fails loudly when the headers are missing, which is the better of the two
failures. `ffmpeg` is optional — without it video and audio are still indexed, just not
thumbnailed, and `roost thumb --retry-blocked` picks that work up once it arrives (ADR-0017).

Then, to put Roost in the application menu and to update it later:

```bash
node scripts/install-launcher.mjs    # a desktop entry pointing at this checkout
pnpm refresh                         # pull, install, build
```

[docs/SETUP.md](docs/SETUP.md) §4 covers both, including what an update does to a library that is
already open — migrations run forward, and the previous build will not open it again.

## Documentation

| Document | Contents |
| --- | --- |
| [Concept](docs/CONCEPT.md) | Vision, scope, feature map, non-goals |
| [Architecture](docs/ARCHITECTURE.md) | Packages, processes, IPC, invariants |
| [Storage spec](docs/STORAGE_SPEC.md) | **Binding** layout, invariants, schema, journal |
| [Data model](docs/DATA_MODEL.md) | Query language, schema growth plan |
| [UI spec](docs/UI_SPEC.md) | Layout, tokens, components, interaction, keyboard map |
| [Roadmap](docs/ROADMAP.md) | Milestones and acceptance criteria |
| [Setup](docs/SETUP.md) | Development environment |
| [Benchmarks](docs/BENCHMARKS.md) | Measured performance, and what each run revealed |
| [TODO](docs/TODO.md) | The working list, in priority order |
| [Session log](docs/SESSION_LOG.md) | What each working session did, decided, and deferred |
| [Decisions](docs/adr/) | Architecture decision records |

## Licence

**Proprietary — see [LICENSE](LICENSE).** Roost is licensed for use, not for redistribution: it
may not be copied, published, modified, or resold, and this repository is not open source
(ADR-0038).

**The format is open, and that is the part that protects you.** Your files are never modified in
place, every change is appended to a plain JSONL journal you can read in any text editor, and the
layout is a published specification ([STORAGE_SPEC.md](docs/STORAGE_SPEC.md)). Roost's source
being closed does not close your data — you can walk away with all of it, and the licence says so
in section 4.

Third-party components, and what their licences oblige, are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Copyright © 2026 Digitalku · [roost.digitalku.com](https://roost.digitalku.com) ·
[roostsupport@digitalku.com](mailto:roostsupport@digitalku.com)
