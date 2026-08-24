/**
 * Writes the content-hashing fixtures to a directory, so that another
 * implementation can hash byte-identical inputs.
 *
 * This is how the expected digests in `packages/media/src/hash.test.ts` were
 * produced: the files were written here, imported into a library by the Rust
 * implementation at `../roost-old`, and its hashes read back out. Run it again
 * whenever those digests need re-deriving.
 *
 *   pnpm build
 *   node scripts/make-hash-fixtures.mjs /tmp/roost-hash-fixtures
 *
 * It reads the generator from the built package rather than carrying its own
 * copy, so the bytes it writes and the bytes the test hashes cannot drift.
 */

import { argv, exit } from "node:process";
import { HASH_FIXTURES, writeHashFixtures } from "../packages/media/dist/testing/hash-fixtures.js";

const dir = argv[2];
if (!dir) {
  console.error("usage: make-hash-fixtures <dir>");
  exit(2);
}

const paths = await writeHashFixtures(dir);
for (const fixture of HASH_FIXTURES) {
  console.error(
    `${paths.get(fixture.name)}  ${fixture.size} bytes  ${fixture.isPartial ? "partial" : "full"}`,
  );
}
