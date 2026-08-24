import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests live next to the code they cover (`CLAUDE.md` §6). Integration
    // tests get `tests/` in the package they exercise, and arrive with M1.
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
