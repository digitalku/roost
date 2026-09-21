import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddRecord } from "../journal/index.js";
import { ID_ALPHABET, parseAssetId } from "../model/index.js";
import { Db } from "./database.js";
import { IndexSink } from "./sink.js";

function record(n: number): { ts: number; op: "add" } & AddRecord {
  return {
    ts: 1_700_000_000,
    op: "add",
    id: parseAssetId(`${ID_ALPHABET[n % 32] ?? "0"}${String(n).padStart(11, "0")}`),
    ext: "png",
    name: `asset-${n}`,
  };
}

describe("batching a rebuild", () => {
  let dir: string;
  let db: Db;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-sink-"));
    db = Db.open(join(dir, "index.db"));
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** What another connection can see — that is, what has actually committed. */
  function committedAssets(): number {
    const raw = new BetterSqlite3(db.path, { readonly: true });
    try {
      return (raw.prepare("SELECT count(*) AS n FROM assets").get() as { n: number }).n;
    } finally {
      raw.close();
    }
  }

  it("commits every batch and holds the remainder until it is told to finish", () => {
    const sink = new IndexSink(db, 2);

    sink.apply(record(1));
    expect(committedAssets()).toBe(0);

    sink.apply(record(2));
    expect(committedAssets()).toBe(2);

    // The tail is smaller than a batch, so nothing commits it but `finish` —
    // the same contract `Journal.close()` carries on the writing side, because
    // JavaScript has no destructor to flush in.
    sink.apply(record(3));
    expect(committedAssets()).toBe(2);

    sink.finish();
    expect(committedAssets()).toBe(3);
  });

  it("discards an unfinished batch, so a failed rebuild leaves no partial index", () => {
    const sink = new IndexSink(db, 1000);
    sink.apply(record(1));
    sink.apply(record(2));

    db.rollbackTransaction();
    expect(committedAssets()).toBe(0);
    expect(db.repo.stats().assets).toBe(0);
  });

  it("joins a transaction the caller already owns instead of committing it", () => {
    // Live mutation wants one record per transaction, alongside its journal
    // append. If the sink committed on its own schedule, a caller that meant to
    // roll back would find part of its work already durable.
    const sink = new IndexSink(db, 1);

    db.beginTransaction();
    sink.apply(record(1));
    expect(db.inTransaction).toBe(true);
    expect(committedAssets()).toBe(0);

    db.rollbackTransaction();
    expect(db.repo.stats().assets).toBe(0);
  });
});
