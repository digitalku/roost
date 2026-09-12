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

There is no package yet — packaging is M6 — so Roost is installed by building this repository,
and updated by pulling it. Linux is the platform Roost is *for* and the only one tested end to
end; Windows builds and runs the same checkout, with the differences its own section names.

### On Fedora

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
`ffmpeg-free` is Fedora's build and covers everything except HEVC; the section below is about the
formats it and libvips deliberately leave out.

### On Windows

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
winget install Microsoft.VCRedist.2015+.x64      # administrator
corepack enable                                  # administrator

git clone <this repo>
cd roost
pnpm install --ignore-scripts
pnpm start
```

Four things are worth knowing, all of them measured on a clean machine rather than assumed.

- **The Visual C++ runtime is not optional and does not announce itself.** Without it the hashing
  module reports *"Cannot find native binding"* — which blames a bug in npm and is wrong — and
  Biome dies with exit `3221225781`, which is `STATUS_DLL_NOT_FOUND`. Neither message says *DLL*.
- **`pnpm install` needs `--ignore-scripts` for now**, because pnpm insists on rebuilding a
  native module that already ships a binary for every platform. `pnpm refresh` passes the flag
  for you afterwards, so this is the only command that carries it by hand.
- **Electron's binary is fetched on the first launch** (~100 MB, once) rather than during the
  install, which is what skipping those scripts costs. Nothing else here needs a compiler.
- **A terminal opened before an installer finished has the old `PATH` forever.** A process
  inherits it once and never re-reads it, so `node` answering *"not recognized"* after a
  successful install means the window, not the install.

The test suite runs here and the window opens, imports, searches and previews. Two things are
known to be unproven rather than known to work: **`Delete permanently`** meets a file libvips
still holds open — Windows will not unlink one, and Linux never notices — and the `check-*.mjs`
scripts, which drive a real window, have almost all only ever been run on Linux. The decoders
below come from somewhere other than `dnf`.

### Formats that need a decoder from the system

Roost ships the decoders it can: images through libvips, SVG through resvg, PDF through pdfium.
Two families it cannot ship, because they are **patent-encumbered** — HEVC, which is what an
iPhone's `.HEIC` photographs and many camera videos are coded with. Roost is proprietary software
(ADR-0038), so bundling a decoder for them is a licensing question rather than a packaging one.
This is the same reason Fedora's own `ffmpeg-free` cannot open them.

Nothing here is required. Files of these kinds still import, still hash, still carry tags and
folders, and still turn up in a search — what is missing is the picture, and Roost says so in the
status bar rather than leaving an empty cell. Install a decoder and the pictures appear.

**On Fedora, both live in RPM Fusion**, which is one command to enable:

```bash
sudo dnf install -y \
  https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm
```

| For | Install | What it gives you |
| --- | --- | --- |
| **HEIC / HEIF photographs** | `sudo dnf install -y libheif-tools libheif-freeworld` | `heif-dec`, plus the libde265 plugin that decodes HEVC. Roost assembles the tiled grid an iPhone writes and applies its rotation |
| **HEVC video** (iPhone `.mov`, most modern cameras) | `sudo dnf swap ffmpeg-free ffmpeg --allowerasing` | Thumbnails, durations and waveforms for video Fedora's own ffmpeg build cannot decode |

`libheif-tools` alone is not enough: it is in Fedora's own repositories and the decoder plugin is
not, so `heif-dec` installs, runs, reports a version — and refuses every photograph. That is the
pair, and Roost checks for the decoder rather than for the binary.

**If Roost runs inside a container** — a distrobox, say — install these **inside the container**.
The engine runs `heif-dec` and `ffmpeg` from its own `PATH`, which is the container's and not the
host's.

**On Windows, one of the two has an answer.** ffmpeg is a user-scope install that needs no
administrator, and it brings HEVC with it:

```powershell
winget install Gyan.FFmpeg
```

It appends its own directory to the user `PATH` and says to restart the shell, which means the
Roost that was already running still cannot see it — close the window and open it again.

**HEIC has no verified package here.** Roost asks `heif-dec` for these photographs (ADR-0040) and
nothing in winget ships it; MSYS2's `mingw-w64-ucrt-x86_64-libheif` is the likely source and has
not been tried, so treat it as untested rather than as instructions. Until it is, iPhone
photographs import and search on Windows and are listed as not drawn.

Check what arrived:

```bash
heif-dec --list-decoders | grep -A2 'HEIC decoders'   # a non-empty list is the point
ffmpeg -hide_banner -decoders | grep hevc
pnpm --filter @roost/cli start -- doctor -L ~/Pictures/Photos.roost
```

`roost doctor` prints a line per backend, with the command to install anything missing. Assets that
were parked while a decoder was absent pick themselves up the next time the library is opened, or
straight away from the status bar's **Try again**.

### Put it in the application menu

```bash
node scripts/install-launcher.mjs
```

One command on both platforms, and it writes whatever that platform's menu reads: a
`roost.desktop` entry under `~/.local/share/applications` on Linux, and a `Roost` shortcut in the
Start Menu on Windows — `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Roost.lnk`, the user's
own, so nothing here wants an administrator. Both carry the name and the icon, both point at this
checkout by absolute path, and deleting the file is how either is removed.

It launches the build rather than producing one, so `pnpm start` has to have run at least once;
the script refuses to write an entry that would point at nothing. On Windows, right-click the
Start Menu item to pin it to Start or to the taskbar.

**If the checkout is inside a container** — a distrobox, say — the entry lands in the container's
own menu, which no desktop draws. Export it once, from inside the container:

```bash
distrobox-export --app roost         # --delete takes it back out
```

Some desktops cache the menu. If Roost does not appear, `update-desktop-database
~/.local/share/applications` or a fresh session picks it up.

### Update it

```bash
pnpm refresh
```

`git pull --ff-only`, then install and build — `--ff-only` so a machine that only consumes this
repository stops rather than quietly acquiring a merge commit. Launch as usual afterwards; the
launcher points at the build, so an update reaches it with nothing else to do.

It is one command on both platforms and does the platform's extra work itself: on Windows it
skips the build scripts the install cannot run and then fetches Electron's binary deliberately,
which is the step that would otherwise be silently missing after a version bump.

**It pulls, so the machine needs to be able to reach the repository.** This one is private, and a
clone that was copied onto a machine rather than made on it usually cannot: `git pull` answers
*"Host key verification failed"* or asks for a password nobody has. Cloning over HTTPS lets Git
for Windows' credential manager hold the token; cloning over SSH wants a key on each machine.
Either is a one-time setup per computer, and `pnpm refresh` is the only command afterwards.

**An update migrates the library forward and there is no way back.** The newer build applies its
migrations to `index.db`; the older one then refuses that library rather than migrating it down. No
data is at risk — the journal is the source of truth and `roost rebuild` reconstructs the index —
but recovering from a bad build means going forward to a fixed one, not back to yesterday's commit.

[docs/SETUP.md](docs/SETUP.md) §4 has the reasoning behind each of these.

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
