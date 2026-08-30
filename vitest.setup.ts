import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Points every XDG directory at scratch space, for every test in the workspace.
 *
 * Found by running the application after writing the recent-libraries list:
 * `~/.local/state/roost/recent.json` held twelve libraries, all of them
 * temporary directories from the engine's own test suite. `EngineHost` records
 * every library it opens, the tests open real ones, and `stateDir()` resolved to
 * the developer's actual home.
 *
 * Fixed here rather than in the test that revealed it, because the next test to
 * open a library would do it again and there is nothing in that test to warn
 * anybody. A per-file `beforeEach` is a rule to remember; this is a rule that
 * holds whether or not anyone remembers it.
 *
 * `HOME` is deliberately left alone: `dirs.ts` reads it only when an XDG
 * variable is absent, and a test that needs the real home for something else
 * should not have it moved out from under it.
 */

const scratch = mkdtempSync(join(tmpdir(), "roost-test-xdg-"));

for (const variable of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
  process.env[variable] = join(scratch, variable.slice(4).toLowerCase());
}

process.on("exit", () => {
  rmSync(scratch, { recursive: true, force: true });
});
