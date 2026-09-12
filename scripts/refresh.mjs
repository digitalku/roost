/**
 * `pnpm refresh` — bring this checkout up to date, and build what changed.
 *
 *     pnpm refresh
 *
 * Roost is not packaged yet (M6), so a machine that only *uses* Roost updates
 * it the way a machine that develops it does: pull, install, build. That was
 * three commands joined by `&&` in `package.json` until Windows, where the
 * install needs `--ignore-scripts` (`TODO.md` §3) — and where skipping scripts
 * means Electron's own `postinstall` never runs, so its binary has to be
 * fetched deliberately instead. A chain of `&&` has nowhere to put a platform.
 *
 * **The pull is `--ff-only` on purpose.** A machine that only consumes this
 * repository should never quietly acquire a merge commit; `--ff-only` stops and
 * says so instead.
 *
 * **An update migrates the library forward and there is no way back.** The
 * newer build applies its migrations to `index.db` and the older one then
 * refuses that library rather than migrating it down (`SETUP.md` §4). Nothing
 * is at risk — the journal is the source of truth — but recovering from a bad
 * build means going forward to a fixed one.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const onWindows = process.platform === "win32";

run("git pull --ff-only", "git", ["pull", "--ff-only"]);

// `--ignore-scripts` is the workaround `TODO.md` §3 carries, not a preference:
// `allowBuilds` makes pnpm run an implicit `node-gyp rebuild` for
// `better-sqlite3`, which ships a prebuild for every platform and needs Python
// and MSVC to rebuild one it already has.
pnpm(["install", ...(onWindows ? ["--ignore-scripts"] : [])]);
if (onWindows) installElectron();

pnpm(["build"]);
pnpm(["--filter", "@roost/desktop-renderer", "build"]);

console.log("\nRoost is up to date. Open it from the menu, or run `pnpm start`.");

/**
 * pnpm, run as the script it is.
 *
 * `npm_execpath` is pnpm's own answer to what started this, and it is a `.mjs`
 * — so it runs under this process's Node. Spawning the name instead would mean
 * spawning `pnpm.cmd` on Windows, and Node refuses to spawn a `.cmd` without a
 * shell since 20.12 (CVE-2024-27980), which is the same trap `dev.mjs`
 * documents about `npx`.
 */
function pnpm(args) {
  const exec = process.env["npm_execpath"];
  if (exec === undefined || !/\.[cm]?js$/.test(exec)) {
    fail("run this as `pnpm refresh` — without pnpm's own environment there is no pnpm to run");
  }
  run(`pnpm ${args.join(" ")}`, process.execPath, [exec, ...args]);
}

/**
 * Electron's binary, fetched the way its own `postinstall` would have.
 *
 * `--ignore-scripts` skips that postinstall, so after a version bump the `dist`
 * left in `node_modules` is the *previous* Electron and nothing says so:
 * `require("electron")` asks only whether a file is there. `install.js` asks
 * what version it is and exits immediately when it matches, so running it on
 * every refresh costs one process and nothing else.
 */
function installElectron() {
  const installer = createRequire(import.meta.url).resolve("electron/install.js");
  run("electron install", process.execPath, [installer]);
}

function run(label, command, args) {
  console.log(`\n→ ${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) fail(`failed to start ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`\n${label} exited ${result.status}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
