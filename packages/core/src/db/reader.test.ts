import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddRecord } from "../journal/index.js";
import { parseAssetId } from "../model/index.js";
import { Db, INDEX_FILE } from "./database.js";
import { READ_ONLY_OPTIONS, ReadOnlyIndex } from "./reader.js";
import { IndexSink } from "./sink.js";

const ONE = parseAssetId("AAAAAAAAAAAA");
const OTHER = parseAssetId("BBBBBBBBBBBB");

function asset(id: typeof ONE, over: Partial<AddRecord> = {}): AddRecord {
  return { id, ext: "png", name: "one", ...over };
}

describe("the protocol handler's read-only view", () => {
  let root: string;
  let reader: ReadOnlyIndex;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "roost-reader-"));
    const db = Db.open(join(root, INDEX_FILE));
    db.transaction(() => {
      const sink = new IndexSink(db);
      sink.apply({ ts: 1, op: "add", ...asset(ONE) });
      sink.apply({ ts: 1, op: "add", ...asset(OTHER, { ext: "mp4", name: "two" }) });
      db.repo.putDerived(ONE, { size: 12, width: 4, height: 4 }, 1);
      db.repo.putThumbnail(ONE, 256, 256, 160, Buffer.from("webp-bytes"));
    });
    db.close();
    reader = ReadOnlyIndex.open(root);
  });

  afterEach(async () => {
    reader.close();
    await rm(root, { recursive: true, force: true });
  });

  it("returns a thumbnail's bytes, and nothing for a size that has none", () => {
    expect(reader.thumbnail(ONE, 256)?.toString()).toBe("webp-bytes");
    // Not an error: the grid learns a thumbnail is absent by asking for it,
    // which is what ADR-0008 chose over a `has_thumbnail` column.
    expect(reader.thumbnail(ONE, 512)).toBeUndefined();
    expect(reader.thumbnail(OTHER, 256)).toBeUndefined();
  });

  it("says what is needed to find an asset's file, and nothing more", () => {
    // Two columns in version 2 rather than four: the id names the file and the
    // extension completes the name (RL-9), so there is no mode to branch on
    // and no path to read back.
    expect(reader.findFile(ONE)).toEqual({ ext: "png", size: 12 });
    // A size nothing has derived yet is `null`, which is a fact about how far
    // the library has got rather than about the file (RL-22).
    expect(reader.findFile(OTHER)).toEqual({ ext: "mp4", size: null });
    expect(reader.findFile(parseAssetId("CCCCCCCCCCCC"))).toBeUndefined();
  });

  it("refuses a write, from SQLite rather than from politeness", () => {
    // The whole point of the exception ADR-0008 grants: main gets a connection
    // that is incapable of writing, not one that has merely been asked not to.
    // `ReadOnlyIndex` exposes no write, so the guarantee is checked against a
    // connection opened with the same options object the class uses — change
    // `readonly` there and this fails.
    const same = new BetterSqlite3(join(root, INDEX_FILE), READ_ONLY_OPTIONS);
    try {
      expect(() => same.prepare("DELETE FROM thumbs").run()).toThrow(/readonly/i);
    } finally {
      same.close();
    }
  });

  it("does not block the engine's writer, which is what WAL is for", () => {
    // ADR-0008 leans on this: main holds a reader for as long as a library is
    // open, and the engine goes on importing. Without WAL the reader would take
    // a shared lock and the next write would get SQLITE_BUSY.
    expect(reader.thumbnail(ONE, 256)).toBeDefined();
    const writer = Db.open(join(root, INDEX_FILE));
    try {
      writer.transaction(() => {
        writer.repo.putThumbnail(OTHER, 256, 256, 256, Buffer.from("second"));
      });
    } finally {
      writer.close();
    }
    expect(reader.thumbnail(OTHER, 256)?.toString()).toBe("second");
  });

  it("refuses to open a library that has no index", async () => {
    const empty = await mkdtemp(join(tmpdir(), "roost-reader-empty-"));
    try {
      // A missing index is a missing library, and it must not be mistaken for a
      // library whose thumbnails are all missing.
      expect(() => ReadOnlyIndex.open(empty)).toThrow();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
