import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationFailedError, SchemaTooNewError, UnreadableSchemaVersionError } from "../index.js";
import { Db } from "./database.js";
import { applyMigrations, latestSchemaVersion } from "./migrations.js";

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
      const hash = "a".repeat(64) as never;
      db.repo.applyAdd(0, {
        hash,
        ext: "jpg",
        size: 1,
        name: "beach trip.jpg",
        mode: "managed",
      });
      db.repo.applyTagAdd(hash, ["reference", "blue"]);
      db.repo.applyAssetRename(hash, "beach trip, second pass.jpg");
      expect(db.repo.orphanSearchRows()).toBe(0);

      db.repo.applyRemove(hash);
      expect(db.repo.orphanSearchRows()).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rejects values the specification's CHECK constraints forbid", () => {
    const db = Db.openInMemory();
    try {
      // `storage_mode` is case-sensitive per the CHECK, and `link_method` is
      // one of exactly three. Both are enforced by the schema, not by us.
      expect(() =>
        db.repo.applyAdd(0, {
          hash: "b".repeat(64) as never,
          ext: "jpg",
          size: 1,
          name: "x.jpg",
          mode: "Managed" as never,
        }),
      ).toThrow();

      expect(() =>
        db.repo.applyAdd(0, {
          hash: "c".repeat(64) as never,
          ext: "jpg",
          size: 1,
          name: "x.jpg",
          mode: "managed",
          link: "symlink" as never,
        }),
      ).toThrow();
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

      const hash = "d".repeat(64) as never;
      db.repo.applyAdd(0, { hash, ext: "jpg", size: 1, name: "x.jpg", mode: "managed" });
      db.repo.putThumbnail(hash, 256, 256, 128, Buffer.from([0]));
      expect(db.repo.stats().thumbnails).toBe(1);

      db.repo.applyRemove(hash);
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
