import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddRecord } from "../journal/index.js";
import { JOB_PRIORITY, parseContentHash } from "../model/index.js";
import { Db } from "./database.js";
import {
  type Cursor,
  type Filter,
  MATCH_ALL,
  MATCH_LIVE,
  type Page,
  type SearchHit,
} from "./query.js";
import { lastCursor, searchSql } from "./repo.js";

/** A hash that is distinct per `n` and still 64 lowercase hex characters. */
function hashOf(n: number): ReturnType<typeof parseContentHash> {
  return parseContentHash(n.toString(16).padStart(64, "0"));
}

function asset(n: number, over: Partial<AddRecord> = {}): AddRecord {
  return {
    hash: hashOf(n),
    ext: "png",
    size: 100 + n,
    name: `asset-${n}.png`,
    mode: "managed",
    link: "hardlink",
    ...over,
  };
}

/**
 * A referenced asset: nothing was placed, so nothing was linked. Built without
 * the key rather than with `link: undefined`, which is the same distinction the
 * journal draws (`op.ts`).
 */
function referenced(n: number, over: Partial<AddRecord> = {}): AddRecord {
  return {
    hash: hashOf(n),
    ext: "png",
    size: 100 + n,
    name: `asset-${n}.png`,
    mode: "referenced",
    ...over,
  };
}

describe("folding one operation at a time", () => {
  let db: Db;

  beforeEach(() => {
    db = Db.openInMemory();
  });

  afterEach(() => {
    db.close();
  });

  it("re-importing the same bytes keeps the tags the asset already carried", () => {
    // This is why the insert is `ON CONFLICT ... DO UPDATE` and not
    // `INSERT OR REPLACE`: replace deletes the row first, and the schema's
    // `ON DELETE CASCADE` would take the tags and folder memberships with it.
    const a = asset(1);
    db.repo.applyAdd(10, a);
    db.repo.applyTagAdd(a.hash, ["reference"]);
    db.repo.applyFolderCreate(1, null, "Moodboards");
    db.repo.applyFolderAdd(a.hash, 1);

    db.repo.applyAdd(20, { ...a, name: "asset-1 (copy).png" });

    const detail = db.repo.assetDetail(a.hash);
    expect(detail?.tags).toEqual(["reference"]);
    expect(detail?.folders).toEqual(["Moodboards"]);
    expect(detail?.origName).toBe("asset-1 (copy).png");
    expect(detail?.importedAt).toBe(20);
  });

  it("stores a favourite as an integer, because a boolean cannot be bound", () => {
    // `better-sqlite3` binds numbers, strings, bigints, buffers, and null, and
    // throws on anything else. The column is `CHECK (is_favorite IN (0, 1))`,
    // so the conversion is the schema's, not a workaround.
    const a = asset(2);
    db.repo.applyAdd(10, a);
    db.repo.applyFavoriteSet(a.hash, true);
    expect(db.repo.assetDetail(a.hash)?.isFavorite).toBe(true);
    expect(db.repo.stats().favorites).toBe(1);

    db.repo.applyFavoriteSet(a.hash, false);
    expect(db.repo.assetDetail(a.hash)?.isFavorite).toBe(false);
    expect(db.repo.stats().favorites).toBe(0);
  });

  it("distinguishes an unrated asset from a deliberate one star", () => {
    const a = asset(3);
    db.repo.applyAdd(10, a);

    db.repo.applyRate(a.hash, 1);
    expect(db.repo.assetDetail(a.hash)?.rating).toBe(1);
    expect(db.repo.stats().rated).toBe(1);

    db.repo.applyRate(a.hash, null);
    expect(db.repo.assetDetail(a.hash)?.rating).toBeNull();
    expect(db.repo.stats().rated).toBe(0);
  });

  it("writes the journal's optional fields as NULL rather than dropping them", () => {
    // `created`, `ref`, and `partial` cannot be recovered from `originals/`, so
    // a rebuild that loses them loses data. `w` and `h` can be — but only by
    // decoding every file again, which a rebuild does not do.
    const bare = referenced(4);
    db.repo.applyAdd(10, bare);
    const detail = db.repo.assetDetail(bare.hash);
    expect(detail?.createdAt).toBeNull();
    expect(detail?.refPath).toBeNull();
    expect(detail?.width).toBeNull();
    expect(detail?.isPartialHash).toBe(false);

    const full = referenced(5, {
      w: 800,
      h: 600,
      created: 1_700_000_000,
      ref: "/home/user/pictures/asset-5.png",
      partial: true,
    });
    db.repo.applyAdd(10, full);
    expect(db.repo.assetDetail(full.hash)).toMatchObject({
      width: 800,
      height: 600,
      createdAt: 1_700_000_000,
      refPath: "/home/user/pictures/asset-5.png",
      isPartialHash: true,
    });
  });

  it("merges a tag rename onto an existing name instead of failing", () => {
    // `tags.name` is UNIQUE COLLATE NOCASE, so a rename onto a name that exists
    // has no other outcome that both succeeds and replays to the same state.
    const a = asset(6);
    const b = asset(7);
    db.repo.applyAdd(10, a);
    db.repo.applyAdd(10, b);
    db.repo.applyTagAdd(a.hash, ["wood"]);
    db.repo.applyTagAdd(b.hash, ["timber"]);

    db.repo.applyTagRename("wood", "timber");

    expect(db.repo.stats().tags).toBe(1);
    expect(db.repo.assetDetail(a.hash)?.tags).toEqual(["timber"]);
    expect(db.repo.assetDetail(b.hash)?.tags).toEqual(["timber"]);
  });

  it("renames a tag in place when only its case changes", () => {
    const a = asset(8);
    db.repo.applyAdd(10, a);
    db.repo.applyTagAdd(a.hash, ["wood"]);

    db.repo.applyTagRename("wood", "Wood");

    expect(db.repo.stats().tags).toBe(1);
    expect(db.repo.assetDetail(a.hash)?.tags).toEqual(["Wood"]);
  });

  it("keeps the tags when the group arranging them is deleted", () => {
    // `tags.group_id` is ON DELETE SET NULL, never CASCADE: deleting an
    // arrangement must not delete what was arranged, nor unpick every asset
    // carrying it.
    const a = asset(9);
    db.repo.applyAdd(10, a);
    db.repo.applyTagAdd(a.hash, ["oak"]);
    db.repo.applyTagGroupCreate(1, "Materials");
    db.repo.applyTagGroupSet("oak", 1);

    db.repo.applyTagGroupDelete(1);

    expect(db.repo.stats().tagGroups).toBe(0);
    expect(db.repo.stats().tags).toBe(1);
    expect(db.repo.assetDetail(a.hash)?.tags).toEqual(["oak"]);
  });

  it("deletes a folder without deleting the assets collected in it", () => {
    const a = asset(11);
    db.repo.applyAdd(10, a);
    db.repo.applyFolderCreate(1, null, "Moodboards");
    db.repo.applyFolderCreate(2, 1, "Icons");
    db.repo.applyFolderAdd(a.hash, 2);

    db.repo.applyFolderDelete(1);

    // The child folder goes by cascade, and so does the membership. The asset
    // stays: folders are collections, not locations.
    expect(db.repo.stats().folders).toBe(0);
    expect(db.repo.assetDetail(a.hash)?.folders).toEqual([]);
    expect(db.repo.stats().assets).toBe(1);
  });

  it("hands out the next id from the table, not from the last insert", () => {
    expect(db.repo.nextFolderId()).toBe(1);
    db.repo.applyFolderCreate(1, null, "One");
    db.repo.applyFolderCreate(2, null, "Two");
    expect(db.repo.nextFolderId()).toBe(3);

    // Ids of deleted folders are reused, which replays correctly because
    // replay is total and ordered.
    db.repo.applyFolderDelete(2);
    expect(db.repo.nextFolderId()).toBe(2);
  });

  it("reports a hash prefix that names two assets as two", () => {
    db.repo.applyAdd(10, asset(0x1a));
    db.repo.applyAdd(10, asset(0x1b));
    const prefix = "0".repeat(62);
    expect(db.repo.resolveHashPrefix(prefix)).toHaveLength(2);
    expect(db.repo.resolveHashPrefix(`${prefix}1a`)).toEqual([hashOf(0x1a)]);
  });
});

describe("keyset paging", () => {
  let db: Db;

  beforeEach(() => {
    db = Db.openInMemory();
    // Every asset shares one `imported_at`, which is what a bulk import
    // produces. Without the tie-break column, paging then shows an asset twice
    // or skips it entirely.
    db.transaction(() => {
      for (let n = 1; n <= 7; n += 1) db.repo.applyAdd(1_700_000_000, asset(n));
    });
  });

  afterEach(() => {
    db.close();
  });

  it("walks a tied page boundary without repeating or skipping a row", () => {
    const seen: SearchHit[] = [];
    let cursor: Cursor | undefined;

    for (;;) {
      const page: Page = cursor === undefined ? { limit: 2 } : { limit: 2, after: cursor };
      const hits = db.repo.search(MATCH_ALL, page);
      if (hits.length === 0) break;
      seen.push(...hits);
      cursor = lastCursor(hits);
    }

    const hashes = seen.map((h) => h.hash);
    expect(hashes).toHaveLength(7);
    expect(new Set(hashes).size).toBe(7);
    // Ascending on the tie-break, which is what the index holds.
    expect(hashes).toEqual([...hashes].sort());
  });

  it("names the cursor timestamp once and writes it twice", () => {
    // The regression the Rust build's benchmark found, expressed as a property
    // of the SQL rather than of a timing. A query-plan test cannot catch it:
    // with the parameters written as literals the two timestamps become one
    // constant, which SQLite collapses exactly as it collapses one shared
    // parameter, so the plan looks correct either way.
    const sql = searchSql("1", true);
    // `\b` matters: an unanchored `/@cursorTs/` also matches a second, distinct
    // `@cursorTs2`, so the broken version passes the test meant to catch it.
    expect(sql.match(/@cursorTs\b/g)).toHaveLength(2);
    expect(sql).toContain("a.hash > @cursorHash");
    expect(sql.trimEnd().endsWith("LIMIT @limit")).toBe(true);
  });

  it("orders by a total order, tie-break included", () => {
    // Also structural, and for a subtler reason than the one above. After
    // migration 0003 the ordering index *is* `(imported_at DESC, hash)`, so
    // SQLite satisfies `ORDER BY imported_at DESC` by walking it — and hands
    // back rows in hash order anyway. Dropping the tie-break is invisible to
    // any fixture small enough to write, and stops being invisible on a
    // library where a different plan is cheaper.
    expect(searchSql("1", false)).toContain("ORDER BY a.imported_at DESC, a.hash");
  });

  it("leaves the filter's own placeholders anonymous and positional", () => {
    // `better-sqlite3` treats `?NNN` as a *named* parameter and refuses to bind
    // it positionally, so the Rust build's numbering does not survive the port.
    // The filter contract stays anonymous `?`; everything appended is named.
    const filter: Filter = { sql: "a.ext = ? AND a.size >= ?", params: ["png", 105] };
    const hits = db.repo.search(filter, { limit: 10 });
    expect(hits.map((h) => h.hash)).toEqual([5, 6, 7].map(hashOf).sort());
    expect(db.repo.count(filter)).toBe(3);
  });
});

describe("the plan a grid query actually gets", () => {
  let dir: string;
  let db: Db;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-plan-"));
    db = Db.open(join(dir, "index.db"));
    db.transaction(() => {
      for (let n = 1; n <= 200; n += 1) {
        db.repo.applyAdd(1_700_000_000 + n, asset(n, { ext: n % 5 === 0 ? "jpg" : "png" }));
      }
    });
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * The plan for one compiled filter.
   *
   * Read through a second connection because `EXPLAIN QUERY PLAN` is not a
   * repository statement; WAL is what makes that free.
   */
  function planFor(filterSql: string, ...params: unknown[]): string {
    const raw = new BetterSqlite3(db.path, { readonly: true });
    try {
      const plan = raw
        .prepare(`EXPLAIN QUERY PLAN ${searchSql(filterSql, true)}`)
        .all(...params, { cursorTs: 1_700_000_100, cursorHash: hashOf(1), limit: 200 }) as {
        detail: string;
      }[];
      return plan.map((row) => row.detail).join("\n");
    } finally {
      raw.close();
    }
  }

  it("answers a filtered page from the index, without sorting the match set", () => {
    // Migration 0005 carries the sort key inside each filter index precisely so
    // this plan has no temporary B-tree in it. With a single-column index on
    // `ext`, SQLite seeks the matches and then sorts all of them to produce one
    // screen — 18.9 ms at 96,666 assets in the Rust build, against a 100 ms p95
    // budget that has to hold at a million.
    //
    // The filter is spelled as `@roost/search` compiles it, trailing scope and
    // all, because that is the only shape this statement is ever given.
    const detail = planFor(`(a.ext = ?) AND ${MATCH_LIVE.sql}`, "png");

    expect(detail).toContain("idx_assets_ext");
    expect(detail).not.toContain("TEMP B-TREE");
  });

  it("uses the partial indexes only when the query says it is looking at live assets", () => {
    // Migration 0007 made the four grid indexes partial and 0010 added the
    // second term to them, and SQLite will use a partial index only when the
    // query's WHERE contains a term implying the index's. That makes the exact
    // spelling of the scope predicate part of the schema rather than a detail
    // of the compiler — so it is asserted, and the unscoped version is asserted
    // to lose the index rather than silently falling back to a scan nobody
    // measured.
    expect(planFor("a.ext = ?", "png")).not.toContain("idx_assets_ext");
    expect(planFor(`(1) AND ${MATCH_LIVE.sql}`)).toContain("idx_assets_imported");
    // Half the scope is not the scope. Migration 0010 added the second term to
    // every partial index, so a query carrying only the first one loses them —
    // which is the failure this test exists to make loud rather than slow.
    expect(planFor("(1) AND a.trashed_at IS NULL")).not.toContain("idx_assets_imported");
  });

  it("gives the Trash place its own index, in the same order as every other view", () => {
    const detail = planFor("a.trashed_at IS NOT NULL AND a.superseded_by IS NULL");
    expect(detail).toContain("idx_assets_trashed");
    expect(detail).not.toContain("TEMP B-TREE");
  });
});

describe("the derive queue", () => {
  let db: Db;

  beforeEach(() => {
    db = Db.openInMemory();
    for (const n of [1, 2, 3]) db.repo.applyAdd(1_700_000_000 + n, asset(n));
  });

  afterEach(() => {
    db.close();
  });

  const enqueueAll = (priority = JOB_PRIORITY.import): void => {
    for (const n of [1, 2, 3]) db.repo.enqueueJob("derive", hashOf(n), priority, 1_700_000_000);
  };

  it("claims in priority order, then in the order work arrived", () => {
    db.repo.enqueueJob("derive", hashOf(1), JOB_PRIORITY.backfill, 1_700_000_000);
    db.repo.enqueueJob("derive", hashOf(2), JOB_PRIORITY.backfill, 1_700_000_001);
    db.repo.enqueueJob("derive", hashOf(3), JOB_PRIORITY.interactive, 1_700_000_002);

    // The asset someone is looking at goes first, even though it was queued
    // last — that is the whole point of the priority.
    expect(db.repo.claimJobs("derive", 3).map((job) => job.hash)).toEqual([
      hashOf(3),
      hashOf(1),
      hashOf(2),
    ]);
  });

  it("hands a claimed job the bytes it is about", () => {
    db.repo.applyAdd(1_700_000_009, referenced(9, { ref: "/somewhere/nine.png" }));
    db.repo.enqueueJob("derive", hashOf(9), JOB_PRIORITY.import, 1_700_000_009);

    // A runner needs the ext and the storage mode to find the file at all, and
    // a per-job lookup afterwards would be a second query per asset.
    expect(db.repo.claimJobs("derive", 1)[0]).toMatchObject({
      hash: hashOf(9),
      ext: "png",
      storageMode: "referenced",
      refPath: "/somewhere/nine.png",
      attempts: 1,
    });
  });

  it("does not hand the same job to two runners", () => {
    enqueueAll();

    const first = db.repo.claimJobs("derive", 2);
    const second = db.repo.claimJobs("derive", 2);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((job) => job.hash)).size).toBe(3);
  });

  it("returns jobs a crash left claimed", () => {
    enqueueAll();
    db.repo.claimJobs("derive", 3);

    // `running` describes a process. After a crash it describes one that no
    // longer exists, and nothing would ever claim those rows again.
    expect(db.repo.resetRunningJobs()).toBe(3);
    expect(db.repo.claimJobs("derive", 3)).toHaveLength(3);
  });

  it("forgets a finished job, because the derived data is the record of it", () => {
    enqueueAll();
    const [job] = db.repo.claimJobs("derive", 1);
    if (job === undefined) throw new Error("nothing was claimed");

    db.repo.completeJob(job.id);
    expect(db.repo.jobCounts().reduce((n, row) => n + row.count, 0)).toBe(2);
  });

  it("keeps a blocked job out of the backfill sweep, and a sweep converges", () => {
    // A format nothing in this build can draw must not be retried on every
    // sweep, forever. The block is what makes the sweep terminate.
    const [job] = db.repo.claimJobs("derive", 1);
    db.repo.enqueueJob("derive", hashOf(1), JOB_PRIORITY.import, 1_700_000_000);
    const [claimed] = db.repo.claimJobs("derive", 1);
    if (claimed === undefined) throw new Error("nothing was claimed");
    db.repo.blockJob(claimed.id, "unsupported:zip");
    expect(job).toBeUndefined();

    const added = db.repo.enqueueMissingDerives("derive", [256], JOB_PRIORITY.backfill, 1, 100);
    expect(added).toBe(2);
    expect(db.repo.enqueueMissingDerives("derive", [256], JOB_PRIORITY.backfill, 1, 100)).toBe(0);
    expect(db.repo.jobReasons("blocked")).toEqual([{ reason: "unsupported:zip", count: 1 }]);
  });

  it("releases blocked jobs only for the capability that arrived", () => {
    enqueueAll();
    const claims = db.repo.claimJobs("derive", 3);
    db.repo.blockJob(claims[0]?.id ?? 0, "missing:ffmpeg");
    db.repo.blockJob(claims[1]?.id ?? 0, "missing:ffmpeg");
    db.repo.blockJob(claims[2]?.id ?? 0, "unsupported:bmp");

    // Installing ffmpeg releases the videos. It does not make a BMP drawable.
    expect(db.repo.requeueBlocked("derive", "missing:ffmpeg")).toBe(2);
    expect(db.repo.jobReasons("blocked")).toEqual([{ reason: "unsupported:bmp", count: 1 }]);
  });

  it("retries a failure only while it is still worth retrying", () => {
    enqueueAll();
    const [job] = db.repo.claimJobs("derive", 1);
    if (job === undefined) throw new Error("nothing was claimed");
    db.repo.failJob(job.id, "decode failed");

    expect(db.repo.requeueFailed("derive", 1)).toBe(0);
    expect(db.repo.requeueFailed("derive", 3)).toBe(1);
    // The retry keeps counting: a job that fails forever stops being retried.
    expect(db.repo.claimJobs("derive", 1)[0]?.attempts).toBe(2);
  });

  it("re-queuing something urgent moves it ahead of what it was behind", () => {
    db.repo.enqueueJob("derive", hashOf(1), JOB_PRIORITY.backfill, 1_700_000_000);
    db.repo.enqueueJob("derive", hashOf(2), JOB_PRIORITY.backfill, 1_700_000_001);
    db.repo.enqueueJob("derive", hashOf(2), JOB_PRIORITY.interactive, 1_700_000_002);

    expect(db.repo.claimJobs("derive", 1)[0]?.hash).toBe(hashOf(2));
  });

  it("drops a job whose asset was removed", () => {
    db.repo.enqueueJob("derive", hashOf(1), JOB_PRIORITY.import, 1_700_000_000);
    db.repo.applyRemove(hashOf(1));

    expect(db.repo.claimJobs("derive", 5)).toEqual([]);
    expect(db.repo.jobCounts()).toEqual([]);
  });
});

describe("derived metadata", () => {
  let db: Db;

  beforeEach(() => {
    db = Db.openInMemory();
    db.repo.applyAdd(1_700_000_001, asset(1, { w: 800, h: 600 }));
  });

  afterEach(() => {
    db.close();
  });

  it("does not erase what an earlier pass found", () => {
    // A backend that knows a page count and nothing else must not blank the
    // dimensions probing already wrote.
    db.repo.putDerived(hashOf(1), { pageCount: 12 });

    expect(db.repo.assetDetail(hashOf(1))).toMatchObject({
      width: 800,
      height: 600,
      pageCount: 12,
      durationMs: null,
    });
  });

  it("carries format-specific properties the columns have no room for", () => {
    db.repo.putDerived(hashOf(1), { props: { "font.family": "Adwaita Sans" } });
    db.repo.putDerived(hashOf(1), {
      props: { "font.family": "Adwaita Sans", "font.style": "Regular" },
    });

    expect(db.repo.assetDetail(hashOf(1))?.props).toEqual({
      "font.family": "Adwaita Sans",
      "font.style": "Regular",
    });
  });

  it("loses its properties with the asset, not before", () => {
    db.repo.putDerived(hashOf(1), { props: { "font.family": "Adwaita Sans" } });
    db.repo.applyRemove(hashOf(1));

    expect(db.repo.props(hashOf(1))).toEqual({});
  });
});

describe("summarising a selection", () => {
  /**
   * What the inspector draws over several assets.
   *
   * The distinctions here are the ones a panel gets wrong quietly: unrated is
   * not rated-zero, "none is rated" is agreement rather than disagreement, and
   * a tag two of three assets carry is a weaker claim than one all three carry.
   */
  let db: Db;

  beforeEach(() => {
    db = Db.openInMemory();
  });

  afterEach(() => {
    db.close();
  });

  /** Three assets, sized 1000, 2000 and 3000. */
  const three = (): ReturnType<typeof hashOf>[] =>
    [1, 2, 3].map((n) => {
      const a = asset(n, { size: n * 1000 });
      db.repo.applyAdd(10 * n, a);
      return a.hash;
    });

  it("counts them and adds up their bytes", () => {
    const summary = db.repo.selectionSummary(three());
    expect(summary.count).toBe(3);
    expect(summary.totalBytes).toBe(6000);
  });

  it("calls no rating at all agreement, not a disagreement", () => {
    // An untouched selection must show empty stars, not the word "mixed".
    const summary = db.repo.selectionSummary(three());
    expect(summary.rating).toBeNull();
    expect(summary.ratingMixed).toBe(false);
  });

  it("reports the rating they share, and mixed when they do not", () => {
    const hashes = three();
    for (const hash of hashes) db.repo.applyRate(hash, 4);
    expect(db.repo.selectionSummary(hashes)).toMatchObject({ rating: 4, ratingMixed: false });

    db.repo.applyRate(hashes[1] as ReturnType<typeof hashOf>, 2);
    expect(db.repo.selectionSummary(hashes)).toMatchObject({ rating: null, ratingMixed: true });
  });

  it("treats one unrated asset among rated ones as mixed", () => {
    // The case a `min = max` test alone would call agreement: two fours and an
    // unrated is not "they are all four".
    const hashes = three();
    db.repo.applyRate(hashes[0] as ReturnType<typeof hashOf>, 4);
    db.repo.applyRate(hashes[1] as ReturnType<typeof hashOf>, 4);
    expect(db.repo.selectionSummary(hashes)).toMatchObject({ rating: null, ratingMixed: true });
  });

  it("separates a tag they all carry from one only some carry", () => {
    const hashes = three();
    for (const hash of hashes) db.repo.applyTagAdd(hash, ["wood"]);
    db.repo.applyTagAdd(hashes[0] as ReturnType<typeof hashOf>, ["wip"]);

    const summary = db.repo.selectionSummary(hashes);
    expect(summary.sharedTags).toEqual(["wood"]);
    expect(summary.partialTags).toEqual(["wip"]);
  });

  it("ignores an asset the library does not hold", () => {
    // A selection can outlive the rows it points at, and the summary must
    // describe what is there rather than what was asked about.
    const hashes = three();
    expect(db.repo.selectionSummary([...hashes, hashOf(99)]).count).toBe(3);
  });

  it("answers for an empty selection without raising", () => {
    expect(db.repo.selectionSummary([])).toMatchObject({
      count: 0,
      totalBytes: 0,
      rating: null,
      ratingMixed: false,
    });
  });
});
