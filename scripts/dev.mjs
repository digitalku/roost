/**
 * `pnpm dev` — the Vite dev server and Electron, together.
 *
 * A script rather than a `concurrently` dependency, because the two processes
 * are not interchangeable: Electron must not start until Vite is answering, or
 * the window loads a blank page and stays blank. Waiting for the port is the
 * whole reason this file exists.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commit, ozone, roostBinary } from "./lib/launch.mjs";

const RENDERER = fileURLToPath(new URL("../apps/desktop/renderer", import.meta.url));
const MAIN = fileURLToPath(new URL("../apps/desktop/main/dist/main.js", import.meta.url));
const PORT = 5173;
const HOST = "127.0.0.1";

/**
 * Vite is started from a resolved path rather than through `npx`.
 *
 * `npx` is `npx.cmd` on Windows, and a `.cmd` is not an executable image: since
 * Node 20.12 spawning one without `shell` is refused outright with `EINVAL`,
 * the mitigation for CVE-2024-27980. `shell: true` lifts the refusal by
 * building a command line through the interpreter, which is the thing that
 * advisory is about. Neither is needed, because the package owning the binary
 * can say where it is: Vite's CLI is an ordinary script this process can run
 * with its own interpreter, and `electron` exports the path to its executable
 * (`lib/launch.mjs`). One fewer process in the tree on every platform, too.
 */
const VITE = binOf("vite", new URL("../apps/desktop/renderer/package.json", import.meta.url));

const children = [];
let shuttingDown = false;

const vite = run(process.execPath, [VITE, "--host", HOST, "--port", String(PORT), "--strictPort"], {
  cwd: RENDERER,
});
children.push(vite);

await waitForPort(PORT, 20_000);

const electron = run(roostBinary(), [MAIN, ...ozone], {
  env: { ...process.env, ROOST_DEV_SERVER: `http://${HOST}:${PORT}`, ROOST_COMMIT: commit() },
});
children.push(electron);

// Closing the window ends the session; Vite has no reason to outlive it.
electron.on("exit", (code) => shutdown(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(0));

/**
 * Where a dependency's CLI script actually is, resolved from the package that
 * depends on it.
 *
 * Not `require.resolve("vite/bin/vite.js")`: Vite 8's `exports` map does not
 * list its own CLI, so asking for the path directly is refused with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. `package.json` is exported, and the `bin`
 * field in it is the package's own statement of where the script lives — which
 * is what the shim in `node_modules/.bin` is generated from anyway.
 */
function binOf(name, from) {
  const manifest = createRequire(from).resolve(`${name}/package.json`);
  const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
  return join(dirname(manifest), typeof bin === "string" ? bin : bin[name]);
}

function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  child.on("error", (error) => {
    console.error(`failed to start ${command}: ${error.message}`);
    shutdown(1);
  });
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(code);
}

/** Resolves once something is listening, so the window never loads a blank page. */
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise((resolve) => {
      const socket = connect({ port, host: HOST });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    if (Date.now() > deadline) {
      console.error(`the dev server did not answer on ${HOST}:${port} within ${timeoutMs}ms`);
      shutdown(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
