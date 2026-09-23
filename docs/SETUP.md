# Roost — Development Setup

Status: **Draft v1** · Last updated: 2026-08-24

Nothing in this repository is built yet — M0 creates the workspace these commands assume. This
document is written first so that M0 produces something it describes, rather than the reverse.
Correct it in the same change if M0 lands differently.

---

## 1. Prerequisites

| Requirement | Version | Platform | Why |
| --- | --- | --- | --- |
| Node.js | 22 LTS | Both | The system runtime for the CLI and for tests. **Not** Electron's Node, which is 24.18.1 at Electron 43 — `packages/` targets the lower of the two (ADR-0011 §5) |
| pnpm | 10+ | Both | Workspace manager of record. `corepack enable` is enough |
| git | any | Both | |
| The format, checked out beside this one | — | Both | `../roost-library` holds *Roost Library Format 2* and its conformance suite. `pnpm test` runs that suite (RL-52) and **fails loudly** if the checkout is not there — see below |
| A C++ toolchain | `gcc-c++`, `make`, `python3` | **Linux** | `sharp` is built from source there, always — see below |
| libvips headers | `vips-devel` **8.18.3+** | **Linux** | What that source build links against (ADR-0013). Not optional, and the version is `sharp` 0.35.3's own minimum — a distribution that packages an older one has to be built from source (see below) |
| Electron runtime libs | nss, gtk3, libX11, alsa | **Linux** | Needed to open a window, not to run tests |
| Visual C++ runtime | 2015+ x64 | **Windows** | What the three native modules link against. Absent, they report a missing binding rather than a missing DLL — see below |

Optional, and each one degrades gracefully when absent:

| Tool | Enables |
| --- | --- |
| `ffmpeg` / `ffprobe` | Video frames and durations, audio waveforms. `roost doctor` says when they are missing, and `roost thumb --retry-blocked` picks the work up once they arrive |
| `gh` | Reading CI results without leaving the terminal |

SVG, fonts, and PDF need nothing installed: their backends are WebAssembly and ship with Roost
(ADR-0015, ADR-0016).

### The library format

Roost is one format with an implementation per platform (ADR-0045), and the format is a separate
repository:

```bash
git clone <roost-library> ../roost-library
```

It must sit **beside** this checkout, so that `roost/` and `roost-library/` share a parent.
`packages/library/tests/format-conformance.test.ts` replays its library and compares the result
with the state it publishes; `packages/core/tests/spec-conformance.test.ts` checks this build's
journal vocabulary against its operation registry.

Nothing is copied out of it, ever — a vendored copy drifts the moment somebody fixes one of them.
And nothing in this repository updates it: `pnpm refresh` pulls *this* checkout, because pulling
somebody else's repository from inside this one's script is a surprise nobody asked for.

**The suite fails rather than skipping** when the checkout is absent. A suite that quietly reports
success when it did not run turns "this build conforms" into a claim nobody checks, and the day it
matters is the day somebody changes the hashing and sees green.

### On Fedora

```bash
sudo dnf install -y nodejs npm gcc-c++ make python3 \
                    vips-devel \
                    nss gtk3 libX11 alsa-lib \
                    ffmpeg-free
corepack enable
```

### On Ubuntu, and in a container

**Noble's libvips is below the minimum and `apt` has no newer one.** Ubuntu 24.04 packages
8.15.1 where `sharp` 0.35.3 asks for 8.18.3, so `libvips-dev` is the wrong library however
willingly it installs. Building it instead is what ADR-0013 wants anyway: linked against the
system GLib, there is one of it in the process rather than two.

```bash
sudo apt-get install -y --no-install-recommends \
    build-essential pkg-config meson ninja-build \
    libglib2.0-dev libexpat1-dev libjpeg-turbo8-dev libpng-dev libwebp-dev \
    libtiff-dev libexif-dev liblcms2-dev libheif-dev librsvg2-dev libcgif-dev \
    libimagequant-dev liborc-0.4-dev libfftw3-dev libarchive-dev libspng-dev \
    libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libxtst6 libatspi2.0-0t64 \
    libdrm2 libxkbcommon0 libsecret-1-0 libnotify4 libcups2t64 xdg-utils \
    fonts-liberation ffmpeg

curl -fsSLO https://github.com/libvips/libvips/releases/download/v8.18.6/vips-8.18.6.tar.xz
tar -xf vips-8.18.6.tar.xz && cd vips-8.18.6
meson setup build --prefix=/usr/local --buildtype=release -Dintrospection=disabled
ninja -C build && sudo ninja -C build install && sudo ldconfig
```

`pkg-config --modversion vips-cpp` is the question `scripts/build-sharp.mjs` asks, and it has to
answer 8.18.3 or better before `pnpm install` is worth running. **Neither libraw nor a PDF
backend is needed** in that build: a RAW is drawn from the JPEG its camera embedded
(`packages/media/src/raw.ts`) and PDF is pdfium in WebAssembly (ADR-0016). JPEG, PNG, WebP,
TIFF, HEIF, GIF and SVG are, and the `meson setup` summary lists each one as it finds it — read
it rather than trusting the package list above.

Ubuntu's own `nodejs` is 18, which `engines` refuses. The tarball from `nodejs.org` unpacked
into `/usr/local` is the shortest way to 22, and `corepack enable pnpm` does the rest.

**Electron's binary may not arrive with the install**, and says nothing when it does not:
`node_modules/electron` is there with no `dist/` and no `path.txt`, and the first `pnpm start`
is where it surfaces. Fetching it is one command, and it checks the version it already has
before downloading anything:

```bash
node node_modules/.pnpm/electron@*/node_modules/electron/install.js
```

**In a container it is the session bus that matters, not the system bus.** Measured on
2026-09-22 in a rootless podman `ubuntu:24.04` against a KDE host: with `/run/user/1000`, the
Wayland socket and `$DBUS_SESSION_BUS_ADDRESS` carried in, the window draws and the folder
chooser is the host's own portal dialog. `/run/dbus/system_bus_socket` is absent and can stay
absent — Chromium logs `ERROR:dbus/bus.cc:405` over it twice at every start, and nothing Roost
does depends on the answer.

### On Windows

Linux is the platform Roost is *for* (`CONCEPT.md` §3.5) and nothing below changes that. What
this section describes is a machine the work can be done on: as of 2026-09-11 `pnpm verify`
passes on Windows 11 — 91 files, 1234 tests, 23 skipped — and ADR-0041 gives `dirs.ts` a layout
there, so the engine and the CLI run rather than refuse.

```powershell
winget install OpenJS.NodeJS.LTS
winget install Microsoft.VCRedist.2015+.x64      # administrator
corepack enable                                  # administrator
```

Four things are worth knowing before the first `pnpm install`, all of them measured on a clean
machine rather than assumed:

- **The Visual C++ runtime is not optional and does not announce itself.** Without it
  `@napi-rs/blake-hash` reports *"Cannot find native binding"* — napi-rs's own message, which
  blames a bug in npm's optional dependencies and is wrong — and `biome ci` dies with exit
  `3221225781`, which is `0xC0000135`, `STATUS_DLL_NOT_FOUND`. Neither says *DLL*.
- **`corepack enable` needs an administrator shell**, because it writes shims into
  `C:\Program Files\nodejs`. Running pnpm as `corepack pnpm` instead works for every direct
  command and then fails inside `pnpm verify`, which calls `pnpm` four times of its own.
- **`pnpm install` needs `--ignore-scripts` for now.** `TODO.md` §3 has the reason and the
  decision it is waiting on. Nothing here needs a compiler otherwise: `better-sqlite3` and
  `sharp` both load from binaries they ship, and `scripts/build-sharp.mjs` skips a platform that
  wants the prebuilt. `pnpm refresh` passes the flag itself (§4), so the first install is the
  only place it is typed by hand.
- **A terminal opened before an installer finished has the old `PATH` forever.** A process
  inherits it once and never re-reads it, so `node -v` answering *"not recognized"* after a
  successful install means the window, not the install. **A terminal inside an editor or an
  application inherits that application's environment**, so opening a second tab there changes
  nothing — the application itself has to be restarted, or the command run from a shell started
  since the install. `[Environment]::GetEnvironmentVariable('PATH','Machine')` is the way to tell
  the two apart: if `C:\Program Files\nodejs\` is in there, the installation is fine and the
  window is stale.

```powershell
pnpm install --force --ignore-scripts            # `--force` when the tree came from another platform
node --experimental-strip-types scripts/probe-native.ts
```

The probe is what confirms the three native modules are the Windows ones. A `node_modules`
copied from a Linux checkout is not usable: pnpm's links are written there as plain files
carrying the Linux target path, so Node reads one as JavaScript and reports *"Invalid or
unexpected token"* for every native module. `--force` makes pnpm lay the tree down again, and
it is the safe way to do it.

**Do not delete `node_modules` by hand to fix that.** `node_modules\@roost\<name>` is a junction
to `packages\<name>`, and both obvious tools follow a junction into its target instead of
removing the link: `robocopy /MIR` does unless given `/XJ`, and so does `Remove-Item -Recurse`
under Windows PowerShell 5.1. Either one empties the source tree it points at — measured here on
2026-09-12, 337 files deleted. If a removal really is needed, `cmd /c rmdir /s /q node_modules`
removes junctions as links.

`--ignore-scripts` has one consequence beyond the native modules: Electron's own `postinstall`
never runs, so its binary is absent and `pnpm dev` downloads it (~100 MB) the first time it is
started. That is one download, not one per run.

The twelve `check-*.mjs` scripts have never been run on Windows and are not covered by any of
this.

### Why `sharp` is built from source on Linux

`pnpm install` runs `scripts/build-sharp.mjs` from `postinstall`, and on Linux that compiles
`sharp` against the libvips the system supplies. It is not an optimisation. The prebuilt
`@img/sharp-linux-x64` statically bundles GLib; Electron dynamically links the system GLib; two
GLibs in one process means two GObject type registries, and the first decode inside Electron
calls through a null function pointer and takes the whole engine down. ADR-0013 has the
backtrace and the numbers.

The build takes about half a minute and only runs when the binary is missing, so a second
`pnpm install` is fast. macOS and Windows skip it and keep the prebuilt — there is no system
GLib there to collide with.

```bash
pnpm build:native     # the same build on its own, after a manual node_modules edit
node --experimental-strip-types scripts/probe-native.ts --both
```

The probe is what confirms it worked. It reports `(source build)` or `(prebuilt build)` under
each runtime, because both report libvips 8.18.3 and the version cannot tell them apart.
`roost doctor` prints the same thing on every run.

If `vips-devel` is absent, `postinstall` fails and says so. That is deliberate: a build that
quietly keeps the prebuilt is a build that quietly segfaults later, in the engine, with no
message. `ROOST_SKIP_SHARP_BUILD=1` exists for a CI job that only type-checks, and it prints a
warning saying what it just gave up.

### State of this container, probed 2026-08-24

**Read the date.** As of 2026-09-22 the container sessions run in is a rootless podman
`ubuntu:24.04` one on a Fedora 44 host, and none of the versions below were probed there — that
container started bare, and §1's Ubuntu subsection is what it took to make `pnpm start` open a
window in it. What follows describes the Fedora container this document was written in.

A Fedora 44 distrobox container. Present: Node 22.23.1, pnpm 11.22.0, npm 10.9.8, git 2.55.0,
gcc 16.1.1, make 4.4.1, Python 3.14.7, pkg-config 2.5.1, sqlite3 3.51.2, xdg-open, and
cargo 1.97.1 — the last one matters because generating the cross-implementation fixture means
running `roost-old`.

**Every shared library Electron needs at runtime is already installed** — all of NSS, GTK 3,
X11 and its extensions, xkbcommon, libdrm, gbm, ALSA, ATK and at-spi, CUPS, Pango, Cairo, and
libsecret. Nothing has to be added to open a window.

**Everything the toolchain needs is now installed too**, as of 2026-08-24: g++ 16.2.1,
cmake 4.3.0, gh 2.97.0, and ffmpeg/ffprobe 8.1.2. So a native module with no prebuild for
Electron's ABI compiles from source rather than failing, video thumbnails have a backend from
M4's first day, and CI results are readable without leaving the terminal.

If a fresh container ever needs them again:

```bash
sudo dnf install -y gcc-c++ cmake ffmpeg-free gh
```

The working directory is on **Btrfs**, so reflink import is testable here.

### Toolchain versions, as pinned and verified 2026-08-24

| Thing | Version | Note |
| --- | --- | --- |
| Electron | 43.4.1 | Pinned exactly; ADR-0011 governs when it moves |
| ├ Chromium | 150.0.7871.224 | What the renderer's frame budget is measured against |
| ├ Node (bundled) | **24.18.1** | The engine process runs on this |
| └ ABI (`process.versions.modules`) | 148 | What a non-Node-API native module would have to be built for |
| Node (system) | 22.23.1 | The CLI and the tests run on this; `packages/` targets it |
| TypeScript | 7.0.2 | The native compiler; `tsc -b` is the typecheck |
| Vitest | 4.1.11 | |
| Biome | 2.5.10 | Formatter and linter, one tool |

**The bundled Node is 24, not 22.** Earlier drafts of this file said Electron bundled 22 and that
matching it was why the repository targeted 22. That was wrong. The reason to target 22 is that
it is the *system* LTS and the lower of the two runtimes hosting `packages/` — the CLI runs on
the system's Node, the engine runs on Electron's — and ADR-0011 §5 makes re-checking that part
of every Electron bump.

**Display passthrough works**: the session is Wayland with `WAYLAND_DISPLAY=wayland-0` and
XWayland at `:0`, both visible inside the container. Electron defaults to XWayland unless told
otherwise, so `pnpm dev` passes `--ozone-platform-hint=auto` — under XWayland the window is
blurry on a HiDPI screen and fractional scaling is wrong, which reads as a rendering bug and is
not one.

See `TODO.md` §2 for what each absence blocks.

## 2. First run

```bash
git clone <this repo> && cd roost
pnpm install
pnpm verify           # typecheck, lint, CSS tokens, tests — everything CI runs
```

**On Windows the install takes a flag**, for the reason §1 gives — pnpm would otherwise rebuild
a native module that already ships a binary, and demand a compiler for it:

```powershell
pnpm install --ignore-scripts
pnpm verify
```

`pnpm verify` is the gate on both. Run it before finishing a session; if it passes, CI will too.

`pnpm install` is where native modules are resolved. Three of them matter — `better-sqlite3`,
`sharp`, and `@napi-rs/blake-hash` (ADR-0009) — and all three publish prebuilt binaries upstream.
Reflink needs no module at all: `COPYFILE_FICLONE_FORCE` is in Node already (ADR-0012). If a prebuild
exists for the current Electron ABI, nothing compiles and the install is fast.

**On Linux one of the three compiles anyway**: `postinstall` builds `sharp` from source against
the system's libvips, because the prebuilt segfaults inside Electron (ADR-0013). Anything else
missing a prebuild falls back to a source build too — which works here, because the C++ toolchain
is present. On a machine where it is not, that failure reads like a download error rather than a
missing compiler, so check for `g++` before debugging the network.

**On Windows nothing compiles at all**, which is what makes `--ignore-scripts` cheap: the three
modules load the binaries they ship, and `build-sharp.mjs` skips the platform anyway. It costs one
thing — Electron's own `postinstall` is skipped with them, so its binary (~100 MB) is fetched on
the first `pnpm start` instead of during the install. That is one download, not one per run, and
`pnpm refresh` does it deliberately afterwards (§4).

## 3. Everyday commands

```bash
pnpm verify                  # typecheck + lint + CSS tokens + tests, in CI's order
pnpm typecheck               # tsc -b — build mode is the typecheck, in dependency order
pnpm check                   # biome check --write
pnpm check:css               # fail on a var(--token) nothing declares
pnpm test                    # vitest
pnpm test:watch
pnpm build                   # tsc -b
pnpm clean                   # tsc -b --clean

pnpm dev                                        # Electron + Vite, both watching  (M3)
pnpm start                                      # the window, from this checkout's build,
                                                # with no watcher and no dev server  (§4)
pnpm --filter @roost/cli start -- --help        # the `roost` binary
```

The CLI's `start` runs the built binary, so `pnpm build` has to have run. That is deliberate
rather than an oversight: there is no watch mode wired into the CLI, and a command that silently
ran the previous build is exactly the trap `vitest.config.ts` had to be fixed for.

There is no separate `--noEmit` typecheck. `tsc -b` is what validates project references, so
build mode *is* the check, and a stale `dist/` cannot make it pass.

**Deriving is up to 1.5× faster with a wider threadpool**, and a process cannot widen its own:
libuv reads `UV_THREADPOOL_SIZE` once, before any of this code runs (`BENCHMARKS.md`,
2026-08-29). The app does not need this — main forks the engine with the pool sized — but a long
`roost thumb` does:

```bash
UV_THREADPOOL_SIZE=$(nproc) pnpm --filter @roost/cli start -- thumb
```

```powershell
# PowerShell has no inline environment prefix, so it is two statements
$env:UV_THREADPOOL_SIZE = $env:NUMBER_OF_PROCESSORS
pnpm --filter @roost/cli start -- thumb
```

`roost doctor` prints the pool the current process got, and says this when it is the default.

Working against a library:

```bash
export ROOST_LIBRARY=~/RoostTest.roost

# A library is a folder ending in .roost (ADR-0014). The suffix is added if it
# is missing, and the path actually used is printed, so `init ~/RoostTest` and
# `init ~/RoostTest.roost` create the same directory.
pnpm --filter @roost/cli start -- init "$ROOST_LIBRARY"
pnpm --filter @roost/cli start -- import ~/Pictures --tag reference
pnpm --filter @roost/cli start -- stats
pnpm --filter @roost/cli start -- thumb            # works the derive queue
pnpm --filter @roost/cli start -- thumb --retry-blocked   # after installing ffmpeg
pnpm --filter @roost/cli start -- rebuild

pnpm --filter @roost/cli start -- query 'tag:blue rating:>=4'
pnpm --filter @roost/cli start -- tag add --tag blue <ASSET>...
pnpm --filter @roost/cli start -- folder create Icons --parent Design
pnpm --filter @roost/cli start -- smart create Wooden 'tag:wood rating:>=4'
pnpm --filter @roost/cli start -- doctor --deep
```

**Two of those lines are the shell's syntax rather than Roost's**, and PowerShell writes them
differently — the variable, and `init`, which is the one command that takes the path as an
argument instead of finding it:

```powershell
$env:ROOST_LIBRARY = "$HOME\RoostTest.roost"
pnpm --filter @roost/cli start -- init $env:ROOST_LIBRARY
```

Everything after it reads the variable, so the rest of the block is typed the same on both.

An asset is named by its full hash or by any prefix that matches one asset, so
`roost show 010b3484` is enough. `roost query --hashes` prints one hash per line for exactly
that purpose: `roost query 'is:untagged' --hashes | xargs roost tag add --tag triage`.

A query beginning with `-` reads as a flag rather than a negation — here and in the Rust build
alike. `--` is the escape hatch, and everything after it is the query, so any other flag goes
first: `roost query --count -- '-tag:wip'`.

`roost doctor` exits **1** when it finds damage, so it can be a scheduled check rather than a
report nobody reads. Objects nothing references are waste rather than damage; `--reclaim`
deletes them, and refuses while the index and the object store disagree about what exists.

Every CLI command finds the library the way `git` does — `--library`, else `$ROOST_LIBRARY`,
else the nearest one at or above the working directory — so from inside a library none of them
needs an argument at all. **The window reads none of it.** It opens on the picker, which lists
the libraries opened before it, and a library is chosen there — no argument and no environment
variable names one (`TODO.md` §M3). `library:current` only answers after a page reload, because
the engine outlives the page and is still holding the library open.

Results go to stdout and everything else to stderr, so `roost stats | grep assets` works and a
progress counter never lands in a pipe. Exit codes separate the two kinds of failure: **2** for
a command line that cannot be acted on, **1** for a command that tried and failed.

Never point these at a library you care about while the engine is under development. Journal
writes are append-only and recoverable; a half-written migration is not.

## 4. Using it as an application

Roost is not packaged yet — that is M6 — so everyday use is this checkout. Two commands make it
behave like an installed application anyway.

```bash
node scripts/install-launcher.mjs    # the platform's menu entry
pnpm refresh                         # git pull --ff-only, install, build
```

**Both commands are the same on Windows and do something different there**, which is the point
of them being commands rather than instructions. `install-launcher` writes
`$XDG_DATA_HOME/applications/roost.desktop` on Linux and
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Roost.lnk` on Windows — the user's own Start
Menu, never the machine's, because nothing here needs an administrator. A `.lnk` is a COM object
rather than a file format, so it is written by asking Windows Script Host through PowerShell; the
two things that look like alternatives are not, since a `.cmd` leaves a console window behind the
application for as long as it runs and a `.url` carries neither arguments nor an icon. The icon
is `assets/brand/roost.ico`, which `scripts/build-brand.mjs` writes beside the PNGs: a shortcut
cannot point at a `.png`, and Windows picks a different member of an `.ico` for the Start Menu,
the taskbar and Alt+Tab.

**The desktop entry launches the built output and never builds.** It runs the `electron` binary
from `node_modules` directly, by absolute path, so it depends on nothing being on `PATH` — a
desktop entry is not started from a login shell and cannot be assumed to have one. A menu click
that ran `tsc -b` first would spend a couple of seconds on it and, when it failed, would have
nowhere to print the error. So building is `pnpm refresh`, and it is a separate, visible step. A
launcher installed before the first build refuses to write rather than pointing at nothing.

**`pnpm refresh` pulls with `--ff-only` on purpose.** A machine that only consumes this
repository should never quietly acquire a merge commit; `--ff-only` stops and says so instead.
It builds both halves, which is exactly what `pnpm start` does before opening the window, so
after a refresh the entry and the terminal run the same code.

**It is a script rather than a chain of `&&`, because Windows needs two questions asked.** The
install there takes `--ignore-scripts` (§1), and skipping those scripts means Electron's own
`postinstall` never runs — so after a version bump the `dist` in `node_modules` is the *previous*
Electron and nothing says so, since `require("electron")` asks only whether a file is there.
`scripts/refresh.mjs` therefore runs `electron/install.js` itself on Windows, which checks the
version it finds and exits immediately when it matches. `pnpm start` became a script for the same
kind of reason: the Wayland flag belongs to Linux alone, and a shell chain has nowhere to ask
which platform it is on or to hand the window the commit About should name (ADR-0038 §5.1).

**Pulling needs the machine to be able to reach the repository**, which a checkout that was
copied onto a machine rather than cloned on it usually cannot: `git pull` answers *"Host key
verification failed"* or asks for a password nobody has. That is a per-machine setup — an SSH key,
or an HTTPS clone whose token Git for Windows' credential manager holds — and it is not something
`pnpm refresh` can paper over.

**An update migrates the library forward, and there is no way back.** Opening a library on a
newer build applies the numbered migrations to `index.db`; the older build then refuses that
library with `SchemaTooNewError` rather than migrating it down (`db.test.ts`). Recovering from a
bad release means going forward to a fixed one, not `git checkout` to yesterday. Nothing is at
risk — the journal is the source of truth and `roost rebuild` reconstructs the index — but the
old binary is done with that library.

**Inside a container the entry needs exporting once.** `install-launcher` writes into the
container's own applications directory, which no desktop draws. From inside the container:

```bash
distrobox-export --app roost           # and --delete to take it back out
```

**The window groups under `StartupWMClass=electron`, which is measured rather than chosen.** An
unpackaged Electron reports `WM_CLASS` as `electron` whatever it is launched as — neither
`--class=Roost` nor a symlink named `roost` moves it, both tried. It is accurate here because
every other Electron application on a machine ships its own named binary. Packaging gives Roost
one too, and settles it (M6).

## 5. A test library, cheaply

`roost fixture` builds a reproducible synthetic library — the same seed produces the same
library — which is what every benchmark in `BENCHMARKS.md` is measured against.

```bash
pnpm --filter @roost/cli start -- fixture ~/RoostBench --count 100000
```

By default every file is random bytes: fast, and enough to measure hashing, placing, and
indexing. **Nothing it writes can be thumbnailed**, which looks like a broken pipeline and is
only ever the fixture — pass `--real-images` when the thumbnail path is what is being measured,
and expect it to take an order of magnitude longer.

The bytes match what `../roost-old` writes for the same seed, count, and size, which is what
makes a measurement here comparable to one recorded there rather than merely similar.

## 6. Debugging

- **Renderer** — the usual Chromium devtools, opened from the app.
- **Main** — `pnpm dev` passes `--inspect` on a fixed port; attach from the editor.
- **Engine** — a separate process, so it needs its own inspector port. `ROOST_ENGINE_INSPECT=1`
  starts it with one and prints the URL. Console output from a `utilityProcess` is forwarded to
  main's stdout; if it is not appearing, the engine died before it could log, which is what the
  exit-code handler is for.
- **Logs** — structured JSON at debug level in `$XDG_STATE_HOME/roost/logs`
  (`~/.local/state/roost/logs`), and `%LOCALAPPDATA%\roost\state\logs` on Windows — Local
  rather than Roaming, because a log describes one machine (ADR-0041). Warnings and errors also
  go to the terminal. `ROOST_LOG=debug` raises the terminal level.
- **SQLite** — the library's `index.db` is an ordinary database. `sqlite3 index.db '.schema'`
  and `EXPLAIN QUERY PLAN` are the fastest way to answer a performance question, and deleting
  the file is safe by construction: `roost rebuild` replays it.

## 7. Things that will confuse you once

- **The renderer cannot import anything from `packages/`.** A lint rule enforces it. If an
  auto-import pulls `@roost/core` into a component, the failure appears as a bundler error
  about `node:fs`, which is the rule working.
- **`better-sqlite3` is synchronous.** `await` on a query is not just unnecessary, it hides
  which thread is blocked. See `ARCHITECTURE.md` §4.1. It also means `Db.transaction` refuses a
  function that returns a promise, which is why rebuild uses `beginTransaction`/`commitTransaction`
  directly — replay reads files, so it awaits by nature.
- **pnpm calls the build-script allowlist `allowBuilds`, not `onlyBuiltDependencies`.** It was
  renamed in pnpm 11 and the old key is **ignored in silence** — no warning, no error, just a
  native module that never builds. That is why M0's Electron binary had to be fetched by hand.
  `pnpm approve-builds <pkg>` writes the right key into `pnpm-workspace.yaml`; do not write it
  from memory.
- **`sharp`'s prebuilt binary cannot run inside Electron on Linux.** It loads and then
  segfaults on the first decode (ADR-0013). `pnpm test` and the CLI are unaffected — they run on
  the system's Node. If you are working on M3 and thumbnails take the engine down, this is why,
  and `node --experimental-strip-types scripts/probe-native.ts --both` says so in two seconds.
- **A window with no text in it is a fontconfig cache, not the renderer.** Electron ships its
  own fontconfig rather than using the system's. If `~/.cache/fontconfig` holds `*.cache-11`
  files that a newer fontconfig wrote, Electron's copy logs *"We will not regenerate the cache
  because some cache files were generated by a newer version"* and then finds **no fonts at
  all**. The text is still in the DOM, but every glyph is zero-width, so the buttons draw empty.
  `fc-list` looks healthy, because Fedora's own fontconfig reads the `cache-9` files beside them.
  `rm ~/.cache/fontconfig/*.cache-11` fixes it, and Electron rebuilds its caches on the next
  start. Seen on Fedora 44 on 2026-09-23. Which program wrote the newer files was not found, so
  expect it to come back — and it did, the same day, with a worse symptom: the window **crashed**
  with `SIGTRAP` on the first text it laid out, the log ending at
  `SkFontMgr_FontConfigInterface.cpp:163 … Not implemented`. A window check that dies on
  `location.reload()` and reports only *"unsettled top-level await"* is this. To run the checks
  without touching the files, give them a cache of their own:
  `XDG_CACHE_HOME=$(mktemp -d) node scripts/check-….mjs`.
- **Thumbnails do not survive a rebuild.** They derive from bytes, not from journal records.
  `roost rebuild` says so and tells you to run `roost thumb`.
- **A library can be open in one process at a time.** The single-instance lock is advisory —
  a PID file under `$XDG_STATE_HOME/roost/locks` (`%LOCALAPPDATA%\roost\state\locks` on
  Windows, ADR-0041), keyed by a BLAKE3 hash of the library's canonical path. A Roost killed
  without releasing it leaves the file behind; deleting it is safe once the process is really
  gone.
  **`roost-old` and this build share that derivation**, deliberately and by test, so they lock
  each other out of the same library. That matters here: both repositories are checked out on
  this machine and both get pointed at the same test library.
