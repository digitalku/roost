import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MigrationFailedError,
  parseAssetId,
  SchemaTooNewError,
  UnreadableSchemaVersionError,
} from "../index.js";
import { Db } from "./database.js";
import { applyMigrations, latestSchemaVersion, migrationSql } from "./migrations.js";
import { THUMBNAILS_FILE } from "./pictures.js";
import { IndexSink } from "./sink.js";

/** Every table the binding specification's schema v1 defines. */
const SPEC_TABLES = [
  "meta",
  "assets",
  "thumbs",
  "folders",
  "asset_folders",
  "tags",
  "asset_tags",
  "assets_fts",
];

describe("schema", () => {
  it("gives a fresh database every table the specification requires", () => {
    const db = Db.openInMemory();
    try {
      expect(db.schemaVersion()).toBe(latestSchemaVersion());

      const present = db.pragma("table_list") as { name: string }[];
      const names = present.map((t) => t.name);
      for (const table of SPEC_TABLES) expect(names).toContain(table);
    } finally {
      db.close();
    }
  });

  it("keeps the full-text row aligned with the asset it describes", () => {
    // FTS5 itself is guarded by opening at all: migration 1 runs
    // `CREATE VIRTUAL TABLE ... USING fts5`, which fails outright on a SQLite
    // built without it. What needs asserting here is the rowid alignment — the
    // FTS table has no foreign keys, so nothing cascades for it, and a leaked
    // row keeps returning a deleted asset from search.
    const db = Db.openInMemory();
    try {
      const id = "AAAAAAAAAAAA" as never;
      db.repo.applyAdd(0, { id, ext: "jpg", name: "beach trip" });
      db.repo.applyTagAdd(id, ["reference", "blue"]);
      db.repo.applyAssetRename(id, "beach trip, second pass");
      expect(db.repo.orphanSearchRows()).toBe(0);

      db.repo.applyRemove(id);
      expect(db.repo.orphanSearchRows()).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rejects values the specification's CHECK constraints forbid", () => {
    const db = Db.openInMemory();
    try {
      // A rating outside 1..5 and a `take` that is not one of the two are both
      // refused by the schema rather than by us. Version 1 asserted the same
      // thing about `storage_mode` and `link_method`, and version 2 has
      // neither column (RL-19).
      db.repo.applyAdd(0, { id: "BBBBBBBBBBBB" as never, ext: "jpg", name: "x" });
      expect(() => db.repo.applyRate("BBBBBBBBBBBB" as never, 9)).toThrow();

      expect(() => db.repo.applyWatchAdd(1, "D:\\Inbox", "borrow" as never)).toThrow();
    } finally {
      db.close();
    }
  });

  it("treats tag names as case-insensitively unique", () => {
    // The spec declares `name TEXT NOT NULL UNIQUE COLLATE NOCASE`, so "Wood"
    // must not become a second tag alongside "wood".
    const db = Db.openInMemory();
    try {
      db.repo.applyTagGroupSet("wood", null);
      db.repo.applyTagGroupSet("Wood", null);
      expect(db.repo.stats().tags).toBe(1);
    } finally {
      db.close();
    }
  });

  it("cascades foreign keys, which are per-connection and off in SQLite itself", () => {
    const db = Db.openInMemory();
    try {
      // Asserting the pragma and not only the behaviour: `better-sqlite3`
      // happens to enable this for us, so the cascade below passes even with
      // our own `PRAGMA` removed. If the driver ever stops, this line is what
      // notices.
      expect(db.pragma("foreign_keys")).toEqual([{ foreign_keys: 1 }]);

      const id = "DDDDDDDDDDDD" as never;
      db.repo.applyAdd(0, { id, ext: "jpg", name: "x" });
      db.repo.putThumbnail(id, 256, 256, 128, Buffer.from([0]));
      expect(db.repo.stats().thumbnails).toBe(1);

      db.repo.applyRemove(id);
      // Without `PRAGMA foreign_keys = ON` this row survives as an orphan.
      expect(db.repo.stats().thumbnails).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("migrations", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-db-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does not re-run on reopening an existing library", () => {
    const path = join(dir, "index.db");

    const first = Db.open(path);
    first.repo.applyTagGroupSet("reference", null);
    first.close();

    // Re-running migration 1 would fail on `CREATE TABLE`, and a runner that
    // dropped and recreated instead would lose this row.
    const second = Db.open(path);
    try {
      expect(second.repo.stats().tags).toBe(1);
      expect(second.schemaVersion()).toBe(latestSchemaVersion());
    } finally {
      second.close();
    }
  });

  it("refuses a library written by a newer build rather than migrating it", () => {
    const path = join(dir, "index.db");

    const first = Db.open(path);
    first.close();

    const raw = new BetterSqlite3(path);
    raw.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    raw.close();

    expect(() => Db.open(path)).toThrow(SchemaTooNewError);
  });

  it("refuses a schema version that is not a version number", () => {
    const path = join(dir, "index.db");

    const first = Db.open(path);
    first.close();

    const raw = new BetterSqlite3(path);
    // An empty string is the case that matters: `Number("")` is 0, and a 0
    // would replay migration 1 over a live schema.
    raw.prepare("UPDATE meta SET value = '' WHERE key = 'schema_version'").run();
    raw.close();

    expect(() => Db.open(path)).toThrow(UnreadableSchemaVersionError);
  });

  it("closes the connection when it refuses to open, rather than holding the file", () => {
    // The `Db` that would own the connection is never constructed when `open`
    // throws, so nothing else can close it. Asserted through the sidecars,
    // because SQLite removes `-wal` and `-shm` when the last connection to a
    // file goes — which makes this checkable on every platform rather than only
    // on the one where a leak is loud. Windows is that one: it refuses to
    // unlink an open file, and the temporary directory could not be cleaned up.
    const path = join(dir, "index.db");

    const first = Db.open(path);
    first.close();

    const raw = new BetterSqlite3(path);
    raw.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    raw.close();

    expect(() => Db.open(path)).toThrow(SchemaTooNewError);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  it("leaves nothing half-applied when a migration fails", () => {
    const path = join(dir, "index.db");
    const raw = new BetterSqlite3(path);
    // Migration 1 creates `folders`. Occupying the name makes it fail partway,
    // after `meta` and `assets` have already been created inside the same
    // transaction.
    raw.exec("CREATE TABLE folders (mine INTEGER)");

    expect(() => applyMigrations(raw)).toThrow(MigrationFailedError);

    const tables = (raw.pragma("table_list") as { name: string }[]).map((t) => t.name);
    expect(tables).toContain("folders");
    expect(tables).not.toContain("assets");
    expect(tables).not.toContain("meta");
    raw.close();
  });

  it("puts a file-backed library in WAL mode", () => {
    const db = Db.open(join(dir, "index.db"));
    try {
      const mode = db.pragma("journal_mode") as { journal_mode: string }[];
      expect(mode[0]?.journal_mode).toBe("wal");
    } finally {
      db.close();
    }
  });
});

describe("the thumbnail database (ADR-0051)", () => {
  const ONE = parseAssetId("AAAAAAAAAAAA");
  const TWO = parseAssetId("BBBBBBBBBBBB");
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-pictures-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Inside a transaction, as every other caller does: the sink batches, and
  // left to itself it holds one open that nothing here would commit.
  const addAsset = (db: Db, id: typeof ONE): void => {
    db.transaction(() => new IndexSink(db).apply({ ts: 1, op: "add", id, ext: "png", name: id }));
  };

  it("lives in thumbs/roost.db beside the index, not in it", () => {
    const db = Db.open(join(dir, "index.db"));
    try {
      addAsset(db, ONE);
      db.repo.putThumbnail(ONE, 256, 256, 160, Buffer.from("picture"));
      const main = (db.pragma("main.table_list") as { name: string }[]).map((t) => t.name);
      expect(main).not.toContain("thumbs");
    } finally {
      db.close();
    }
    expect(existsSync(join(dir, THUMBNAILS_FILE))).toBe(true);
    const raw = new BetterSqlite3(join(dir, THUMBNAILS_FILE), { readonly: true });
    try {
      expect(raw.prepare("SELECT count(*) AS n FROM thumbs").get()).toEqual({ n: 1 });
      // Set before the first table, which is the only moment it can be.
      expect(raw.pragma("auto_vacuum", { simple: true })).toBe(2);
    } finally {
      raw.close();
    }
  });

  it("carries a schema v1 index's pictures across, and what they were drawn from", () => {
    // Built by hand at schema v1, which is what every library this build wrote
    // before ADR-0051 has on disk.
    const path = join(dir, "index.db");
    const raw = new BetterSqlite3(path);
    raw.exec(migrationSql("0001_initial.sql"));
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
    raw
      .prepare(
        `INSERT INTO assets (id, ext, name, imported_at, poster_ms, size, mtime, content_hash,
                             width, height, derived_at)
         VALUES (?, 'png', 'one', 1, 1200, 42, 1700000000, 'abc', 640, 480, 5)`,
      )
      .run(ONE);
    raw
      .prepare("INSERT INTO asset_props (asset_id, key, value) VALUES (?, 'codec', 'h264')")
      .run(ONE);
    raw
      .prepare(
        "INSERT INTO thumbs (asset_id, size, width, height, data) VALUES (?, 256, 256, 192, ?)",
      )
      .run(ONE, Buffer.from("carried"));
    raw.close();

    const db = Db.open(path);
    try {
      expect(db.schemaVersion()).toBe(2);
      expect(db.repo.thumbnail(ONE, 256)?.toString()).toBe("carried");
      expect(db.repo.pictureSource(ONE)).toEqual({
        size: 42,
        mtime: 1700000000,
        posterMs: 1200,
        metadata: {
          size: 42,
          mtime: 1700000000,
          contentHash: "abc",
          width: 640,
          height: 480,
          props: { codec: "h264" },
        },
        chosen: false,
      });
      const main = (db.pragma("main.table_list") as { name: string }[]).map((t) => t.name);
      expect(main).not.toContain("thumbs");
    } finally {
      db.close();
    }
  });

  it("brings a version 1 thumbnail database forward without losing a picture (ADR-0060)", () => {
    const path = join(dir, "index.db");
    const before = Db.open(path);
    try {
      addAsset(before, ONE);
      before.repo.putThumbnail(ONE, 256, 256, 160, Buffer.from("kept"));
      before.repo.putPictureSource(ONE, { size: 7, mtime: 9, posterMs: null, metadata: {} });
    } finally {
      before.close();
    }
    // What every library has on disk from before ADR-0060.
    const raw = new BetterSqlite3(join(dir, THUMBNAILS_FILE));
    raw.exec("ALTER TABLE sources DROP COLUMN chosen; PRAGMA user_version = 1");
    raw.close();

    const db = Db.open(path);
    try {
      expect(db.repo.thumbnail(ONE, 256)?.toString()).toBe("kept");
      expect(db.repo.pictureSource(ONE)).toMatchObject({ size: 7, mtime: 9, chosen: false });
    } finally {
      db.close();
    }
    const after = new BetterSqlite3(join(dir, THUMBNAILS_FILE), { readonly: true });
    try {
      expect(after.pragma("user_version", { simple: true })).toBe(2);
    } finally {
      after.close();
    }
  });

  it("never drops a chosen picture for a changed file, only for a removed asset", () => {
    const db = Db.openInMemory();
    try {
      addAsset(db, ONE);
      addAsset(db, TWO);
      const chosen = [
        { size: 256, width: 256, height: 128, data: Buffer.from("small") },
        { size: 512, width: 512, height: 256, data: Buffer.from("large") },
      ];
      db.repo.choosePictures(ONE, chosen);
      db.repo.putThumbnail(TWO, 256, 256, 160, Buffer.from("drawn"));

      db.repo.dropThumbnails(ONE);
      db.repo.dropThumbnail(ONE, 512);
      db.repo.dropThumbnails(TWO);

      expect(db.repo.picturesOf(ONE).map((one) => one.data.toString())).toEqual(["small", "large"]);
      expect(db.repo.thumbnail(TWO, 256)).toBeUndefined();
      // Unmeasured, so the next derive reads the file rather than trusting a
      // size nobody took.
      expect(db.repo.pictureSource(ONE)).toMatchObject({ size: -1, chosen: true });
      expect([...db.repo.chosenAmong([ONE, TWO])]).toEqual([ONE]);

      db.transaction(() => new IndexSink(db).apply({ ts: 2, op: "remove", asset: ONE }));
      expect(db.repo.picturesOf(ONE)).toEqual([]);
      expect(db.repo.pictureSource(ONE)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("makes a thumbnail database of an unknown version again rather than trusting it", () => {
    const path = join(dir, "index.db");
    Db.open(path).close();
    const raw = new BetterSqlite3(join(dir, THUMBNAILS_FILE));
    raw.exec("DROP TABLE thumbs; CREATE TABLE thumbs (mine INTEGER); PRAGMA user_version = 9");
    raw.close();

    const db = Db.open(path);
    try {
      addAsset(db, ONE);
      db.repo.putThumbnail(ONE, 256, 256, 160, Buffer.from("fresh"));
      expect(db.repo.thumbnail(ONE, 256)?.toString()).toBe("fresh");
    } finally {
      db.close();
    }
  });

  it("takes an asset's pictures with it, since no foreign key can reach them", () => {
    const db = Db.openInMemory();
    try {
      addAsset(db, ONE);
      db.repo.putThumbnail(ONE, 256, 256, 160, Buffer.from("picture"));
      db.repo.putPictureSource(ONE, { size: 1, mtime: 1, posterMs: null, metadata: {} });

      db.repo.applyRemove(ONE);

      expect(db.repo.thumbnail(ONE, 256)).toBeUndefined();
      expect(db.repo.pictureSource(ONE)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("prunes the pictures of assets the index does not hold, and hands the space back", () => {
    const db = Db.open(join(dir, "index.db"));
    try {
      addAsset(db, ONE);
      db.repo.putThumbnail(ONE, 256, 256, 160, Buffer.from("kept"));
      // Enough strays to free whole pages, as a rebuild of a library that lost
      // assets would leave behind.
      const bytes = Buffer.alloc(8192, 1);
      db.transaction(() => {
        for (let n = 0; n < 50; n += 1) {
          const stray = parseAssetId(`C${String(n).padStart(11, "0")}`);
          db.repo.putThumbnail(stray, 256, 256, 160, bytes);
          db.repo.putPictureSource(stray, { size: 1, mtime: 1, posterMs: null, metadata: {} });
        }
      });

      expect(db.repo.prunePictures()).toBe(100);
      expect(db.repo.thumbnail(ONE, 256)?.toString()).toBe("kept");
      expect(db.repo.stats().thumbnails).toBe(1);
      expect(db.reclaimPictureSpace()).toBeGreaterThan(50 * 8192 * 0.9);
    } finally {
      db.close();
    }
  });

  it("queues an asset that holds its picture but was never measured", () => {
    // What every asset looks like after a rebuild, now that the pictures stay.
    const db = Db.openInMemory();
    try {
      addAsset(db, ONE);
      addAsset(db, TWO);
      db.repo.putThumbnail(ONE, 256, 256, 160, Buffer.from("picture"));
      db.repo.putThumbnail(TWO, 256, 256, 160, Buffer.from("picture"));
      db.repo.putDerived(TWO, { size: 3 }, 1);

      expect(db.repo.enqueueMissingDerives("derive", [256], 0, 1, 100)).toBe(1);
      expect(db.repo.claimJob("derive")?.assetId).toBe(ONE);
    } finally {
      db.close();
    }
  });
});
