# Roost — Development Setup

Status: **Draft v1** · Last updated: 2026-08-24

Nothing in this repository is built yet — M0 creates the workspace these commands assume. This
document is written first so that M0 produces something it describes, rather than the reverse.
Correct it in the same change if M0 lands differently.

---

## 1. Prerequisites

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | 22 LTS | The system runtime for the CLI and for tests. **Not** Electron's Node, which is 24.18.1 at Electron 43 — `packages/` targets the lower of the two (ADR-0011 §5) |
| pnpm | 10+ | Workspace manager of record. `corepack enable` is enough |
| git | any | |
| A C++ toolchain | `gcc-c++`, `make`, `python3` | Only needed when a native module has no prebuilt binary for Electron's ABI |
| Electron runtime libs | nss, gtk3, libX11, alsa | Needed to open a window, not to run tests |

Optional, and each one degrades gracefully when absent:

| Tool | Enables |
| --- | --- |
| `ffmpeg` / `ffprobe` | Video thumbnails and duration (M4) |
| A PDF backend | First-page thumbnails and page count (M4) |
| `gh` | Reading CI results without leaving the terminal |

### On Fedora

```bash
sudo dnf install -y nodejs npm gcc-c++ make python3 \
                    nss gtk3 libX11 alsa-lib \
                    ffmpeg-free
corepack enable
```

### State of this container, probed 2026-08-24

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

`pnpm verify` is the gate. Run it before finishing a session; if it passes, CI will too.

`pnpm install` is where native modules are resolved. Three of them matter — `better-sqlite3`,
`sharp`, and `@napi-rs/blake-hash` (ADR-0009) — and all three publish prebuilt binaries upstream.
Reflink needs no module at all: `COPYFILE_FICLONE_FORCE` is in Node already (ADR-0012). If a prebuild
exists for the current Electron ABI, nothing compiles and the install is fast. If one does not,
the install falls back to building from source — which works here, because the C++ toolchain is
present. On a machine where it is not, that failure reads like a download error rather than a
missing compiler, so check for `g++` before debugging the network.

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
pnpm --filter @roost/cli start -- --help        #                                 (M1)
```

There is no separate `--noEmit` typecheck. `tsc -b` is what validates project references, so
build mode *is* the check, and a stale `dist/` cannot make it pass.

Working against a library:

```bash
export ROOST_LIBRARY=~/RoostTest

pnpm --filter @roost/cli start -- init "$ROOST_LIBRARY"
pnpm --filter @roost/cli start -- import ~/Pictures
pnpm --filter @roost/cli start -- stats
pnpm --filter @roost/cli start -- query 'tag:blue rating:>=4' --json
pnpm --filter @roost/cli start -- doctor
```

Never point these at a library you care about while the engine is under development. Journal
writes are append-only and recoverable; a half-written migration is not.

## 4. A test library, cheaply

`roost fixture` builds a reproducible synthetic library — the same seed produces the same
library — which is what every benchmark in `BENCHMARKS.md` is measured against.

```bash
pnpm --filter @roost/cli start -- fixture ~/RoostBench --count 100000
```

## 5. Debugging

- **Renderer** — the usual Chromium devtools, opened from the app.
- **Main** — `pnpm dev` passes `--inspect` on a fixed port; attach from the editor.
- **Engine** — a separate process, so it needs its own inspector port. `ROOST_ENGINE_INSPECT=1`
  starts it with one and prints the URL. Console output from a `utilityProcess` is forwarded to
  main's stdout; if it is not appearing, the engine died before it could log, which is what the
  exit-code handler is for.
- **Logs** — structured JSON at debug level in `$XDG_STATE_HOME/roost/logs`
  (`~/.local/state/roost/logs`). Warnings and errors also go to the terminal.
  `ROOST_LOG=debug` raises the terminal level.
- **SQLite** — the library's `index.db` is an ordinary database. `sqlite3 index.db '.schema'`
  and `EXPLAIN QUERY PLAN` are the fastest way to answer a performance question, and deleting
  the file is safe by construction: `roost rebuild` replays it.

## 6. Things that will confuse you once

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
- **Thumbnails do not survive a rebuild.** They derive from bytes, not from journal records.
  `roost rebuild` says so and tells you to run `roost thumb`.
- **A library can be open in one process at a time.** The single-instance lock is advisory —
  a PID file under `$XDG_STATE_HOME/roost/locks`, keyed by a hash of the library's canonical
  path. A Roost killed without releasing it leaves the file behind; deleting it is safe once
  the process is really gone.
