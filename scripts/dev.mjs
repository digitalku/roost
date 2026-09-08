/**
 * `pnpm dev` — the Vite dev server and Electron, together.
 *
 * A script rather than a `concurrently` dependency, because the two processes
 * are not interchangeable: Electron must not start until Vite is answering, or
 * the window loads a blank page and stays blank. Waiting for the port is the
 * whole reason this file exists.
 */
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const RENDERER = fileURLToPath(new URL("../apps/desktop/renderer", import.meta.url));
const MAIN = fileURLToPath(new URL("../apps/desktop/main/dist/main.js", import.meta.url));
const PORT = 5173;
const HOST = "127.0.0.1";

const children = [];
let shuttingDown = false;

const vite = run("npx", ["vite", "--host", HOST, "--port", String(PORT), "--strictPort"], {
  cwd: RENDERER,
});
children.push(vite);

await waitForPort(PORT, 20_000);

const electron = run(
  "npx",
  [
    "electron",
    MAIN,
    // Without this the window is XWayland on a Wayland session: blurry on a HiDPI
    // screen and wrong under fractional scaling, which reads as a rendering bug
    // and is not one (TODO.md §2).
    "--ozone-platform-hint=auto",
  ],
  {
    env: { ...process.env, ROOST_DEV_SERVER: `http://${HOST}:${PORT}`, ROOST_COMMIT: commit() },
  },
);
children.push(electron);

// Closing the window ends the session; Vite has no reason to outlive it.
electron.on("exit", (code) => shutdown(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(0));

/**
 * The commit the About dialog names (ADR-0038 §5.1).
 *
 * Empty when git cannot answer — a tarball, or no git at all. Main turns that
 * into "no commit" and the dialog says only the version, which is better than
 * a build claiming to be one it is not.
 */
function commit() {
  const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  return git.status === 0 ? git.stdout.trim() : "";
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
