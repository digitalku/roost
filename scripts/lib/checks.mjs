/**
 * The ledger every window check keeps: a line per claim, a count at the end,
 * and an exit code CI can read.
 *
 * Lifted out of `check-trash.mjs` and `check-transport.mjs`, which carried the
 * same fifteen lines twice. The output format is theirs unchanged — the scripts
 * are read by a person watching them run, and a format that drifts between two
 * of them is one more thing to read carefully.
 */

/**
 * A run of checks.
 *
 * `check` takes what was *seen* as well as whether it passed, because a failing
 * line that says only "failed" sends you back to the window to find out what it
 * saw instead — which is the expensive half of running these at all.
 */
export function ledger() {
  const failures = [];
  let passed = 0;

  return {
    /** A heading, so a run of thirty checks reads as the shape of the feature. */
    section(name) {
      console.log(`${passed + failures.length === 0 ? "" : "\n"}${name}`);
    },

    check(name, pass, saw) {
      console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}${saw === undefined ? "" : `   ${saw}`}`);
      if (pass) passed += 1;
      else failures.push(name);
    },

    /** The claims that failed, for a caller that wants to say more than the count. */
    get failures() {
      return [...failures];
    },

    get passed() {
      return passed;
    },

    /**
     * Sets `process.exitCode` rather than exiting, so the caller's `finally`
     * still runs — a script that kills its window on the way out must not be
     * short-circuited by its own report.
     */
    report() {
      console.log("");
      if (failures.length > 0) {
        console.log(`${failures.length} of ${failures.length + passed} checks failed`);
        process.exitCode = 1;
      } else {
        console.log(`all ${passed} checks passed`);
      }
      return failures.length === 0;
    },
  };
}
