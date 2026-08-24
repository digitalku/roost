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

export default defineConfig({
  resolve: { alias },
  test: {
    // Unit tests live next to the code they cover (`CLAUDE.md` §6). Integration
    // tests get `tests/` in the package they exercise.
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    // Packages that have not been written yet have no tests, and that is not a
    // failure — it is the milestone plan.
    passWithNoTests: true,
    environment: "node",
  },
});
