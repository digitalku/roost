<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/roost-logo-dark.svg">
  <img src="assets/brand/roost-logo.svg" alt="Roost" height="64">
</picture>

A local-first digital asset manager — an open alternative to Eagle.cool.
Electron shell, TypeScript engine, React interface. Your files stay yours.

> **Status: pre-implementation.** This repository holds the design and nothing else. The
> milestone plan starts at M0 in [docs/ROADMAP.md](docs/ROADMAP.md).
>
> A working implementation of the same product exists in Rust and Tauri, complete through its
> desktop shell. This repository re-implements the engine in TypeScript on Electron and rebuilds
> the interface from scratch. **The library format does not change** — a library written by
> either implementation opens in the other, and that is enforced by a test rather than hoped for.

## Why

Eagle.cool is the reference product for visual asset management, and it does not ship for Linux.
Roost aims at the same job — collect, organize, and re-find tens of thousands of images, videos,
fonts, and design files — while being offline-first, open, and honest about performance.

## Principles

- **Local-first.** No account, no cloud, no telemetry.
- **Your data outlives the app.** Every change is appended to a plain JSONL journal; the database
  is a rebuildable cache you can delete at any time.
- **Fast at scale.** 1M assets, 60fps grid, sub-100ms search — treated as requirements.
- **Non-destructive.** Originals are never modified in place; existing folders can be indexed
  without copying.
- **Scriptable.** The engine ships as a headless CLI too, and the interface may not do anything
  the CLI cannot.

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
| [Decisions](docs/adr/) | Architecture decision records |

## License

MIT — see [LICENSE](LICENSE). You may use, modify, and redistribute Roost, including
commercially; the copyright notice and licence text must travel with every copy or substantial
portion of the software.

Copyright © 2026 Digitalku · [www.digitalku.com](https://www.digitalku.com) ·
[appsupport@digitalku.com](mailto:appsupport@digitalku.com)
