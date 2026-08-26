import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Every workspace package, aliased to its source.
 *
 * Integration tests import through the package name, the way a consumer does.
 * Without these aliases that resolves to `dist/`, so a test run after an edit
 * and before a build silently exercises the previous build — which made five
 * deliberate breakages pass on 2026-08-25 and proved nothing.
 *
 * **Read from disk rather than listed**, because the second time this happened
 * the list simply did not mention `@roost/cli`. A list that has to be kept in
 * step with a directory is a list that will not be.
 */
const packages = readdirSync(fileURLToPath(new URL("./packages", import.meta.url)), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const alias = Object.fromEntries(
  packages.map((name) => [
    `@roost/${name}`,
    fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
  ]),
);

/**
 * Two projects, because the renderer needs a DOM and nothing else may have one.
 *
 * A single `environment: "happy-dom"` would give the engine and the CLI a
 * `window` they must never have, and a test that accidentally used one would
 * pass here and fail in the process that actually runs it.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    // Packages that have not been written yet have no tests, and that is not a
    // failure — it is the milestone plan.
    passWithNoTests: true,
    projects: [
      {
        resolve: { alias },
        test: {
          name: "node",
          environment: "node",
          passWithNoTests: true,
          // Unit tests live next to the code they cover (`CLAUDE.md` §6).
          // Integration tests get `tests/` in the package they exercise.
          include: [
            "packages/*/src/**/*.test.ts",
            "packages/*/tests/**/*.test.ts",
            // The desktop app's processes are packages too, and their tests run
            // in plain Node: `serve` takes a port rather than importing
            // Electron, so the message loop is testable without a browser.
            "apps/desktop/{main,preload,engine}/src/**/*.test.ts",
            "apps/desktop/{main,preload,engine}/tests/**/*.test.ts",
            "scripts/**/*.test.mjs",
          ],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "renderer",
          environment: "happy-dom",
          passWithNoTests: true,
          globals: false,
          setupFiles: ["./apps/desktop/renderer/src/testing/setup.ts"],
          include: ["apps/desktop/renderer/src/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
