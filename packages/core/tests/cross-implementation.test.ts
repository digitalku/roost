import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Db, latestSchemaVersion, parseContentHash } from "@roost/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** An `index.db` written by `../roost-old`. See the fixture's README. */
const RUST_INDEX = fileURLToPath(
  new URL("../src/db/__fixtures__/rust-written-index/index.db", import.meta.url),
);

const ALPHA = parseContentHash("e683cfdda42a354a1148b1d436f66d20074afbc207ff70efa7971d31e557bcc5");

describe("opening a library the Rust implementation wrote", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    // Copied rather than opened in place: opening sets `journal_mode = WAL`,
    // which writes to the file.
    dir = await mkdtemp(join(tmpdir(), "roost-cross-"));
    path = join(dir, "index.db");
    await copyFile(RUST_INDEX, path);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs no migration, because it already carries this build's schema", () => {
    const db = Db.open(path);
    try {
      expect(db.schemaVersion()).toBe(latestSchemaVersion());
    } finally {
      db.close();
    }
  });

  it("answers every query this build knows how to ask", () => {
    // The point is not the numbers — the journal fixture already pins those —
    // but that each statement runs at all against tables another
    // implementation created. A column renamed here fails at the first query
    // rather than in a user's library.
    const db = Db.open(path);
    try {
      expect(db.repo.stats()).toMatchObject({
        assets: 3,
        managed: 2,
        referenced: 1,
        totalBytes: 28,
        tags: 2,
        folders: 1,
        rated: 0,
        favorites: 1,
        notes: 1,
        thumbnails: 0,
      });

      expect(db.repo.assetDetail(ALPHA)).toMatchObject({
        origName: "alpha at dusk.png",
        note: "client approved",
        isFavorite: true,
        tags: ["timber"],
      });

      expect(db.repo.allHashes()).toHaveLength(3);
      expect(db.repo.search({ sql: "a.ext = ?", params: ["png"] }, { limit: 10 })).toHaveLength(2);
      expect(db.repo.resolveHashPrefix("e683cfdd")).toEqual([ALPHA]);
      // The FTS rowids the Rust build wrote have to line up with its own
      // `assets` rowids, or search returns assets that are not there.
      expect(db.repo.orphanSearchRows()).toBe(0);
    } finally {
      db.close();
    }
  });
});
