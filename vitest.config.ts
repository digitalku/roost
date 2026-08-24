import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  // Integration tests import through the package name, the way a consumer does.
  // Without these aliases that resolves to `dist/`, so a test run after an edit
  // and before a build silently exercises the previous build — which made five
  // deliberate breakages pass on 2026-08-25 and proved nothing. `pnpm verify`
  // typechecks first and would have caught it in CI; a bare `vitest run` would
  // not, and that is the command anyone reaches for while working.
  resolve: {
    alias: {
      "@roost/core": src("core"),
      "@roost/media": src("media"),
      "@roost/library": src("library"),
      "@roost/search": src("search"),
      "@roost/contract": src("contract"),
    },
  },
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
