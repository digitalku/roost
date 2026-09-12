/**
 * `pnpm start` — the window, from the build in this checkout.
 *
 * The two build steps in front of this one are `package.json`'s; this file is
 * the launch alone. It is a file rather than the tail of that chain because the
 * launch is not the same command everywhere: the Wayland flag is Linux's, and
 * About should name the commit it is running rather than nothing (ADR-0038
 * §5.1) — and a shell chain has nowhere to put either.
 *
 * The launcher `scripts/install-launcher.mjs` writes does neither and cannot: a
 * menu entry has no shell to ask git and carries no environment.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { commit, electronBinary, ozone } from "./lib/launch.mjs";

const MAIN = fileURLToPath(new URL("../apps/desktop/main/dist/main.js", import.meta.url));

const child = spawn(electronBinary(), [MAIN, ...ozone], {
  stdio: "inherit",
  env: { ...process.env, ROOST_COMMIT: commit() },
});

child.on("error", (error) => {
  console.error(`failed to start electron: ${error.message}`);
  process.exit(1);
});

// A window closed by a signal is not a failing build, but it is not a success
// either; exiting 1 keeps `pnpm start && something` honest.
child.on("exit", (code, signal) => process.exit(signal === null ? (code ?? 0) : 1));
