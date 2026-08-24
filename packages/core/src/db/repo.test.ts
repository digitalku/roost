import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddRecord } from "../journal/index.js";
import { parseContentHash } from "../model/index.js";
import { Db } from "./database.js";
import { type Cursor, type Filter, MATCH_ALL, type Page, type SearchHit } from "./query.js";
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

  it("answers a filtered page from the index, without sorting the match set", () => {
    // Migration 0005 carries the sort key inside each filter index precisely so
    // this plan has no temporary B-tree in it. With a single-column index on
    // `ext`, SQLite seeks the matches and then sorts all of them to produce one
    // screen — 18.9 ms at 96,666 assets in the Rust build, against a 100 ms p95
    // budget that has to hold at a million.
    //
    // Read through a second connection because `EXPLAIN QUERY PLAN` is not a
    // repository statement; WAL is what makes that free.
    const raw = new BetterSqlite3(db.path, { readonly: true });
    try {
      const plan = raw
        .prepare(`EXPLAIN QUERY PLAN ${searchSql("a.ext = ?", true)}`)
        .all("png", { cursorTs: 1_700_000_100, cursorHash: hashOf(1), limit: 200 }) as {
        detail: string;
      }[];
      const detail = plan.map((row) => row.detail).join("\n");

      expect(detail).toContain("idx_assets_ext");
      expect(detail).not.toContain("TEMP B-TREE");
    } finally {
      raw.close();
    }
  });
});
