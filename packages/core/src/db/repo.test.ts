import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddRecord } from "../journal/index.js";
import {
  type AssetId,
  DEFAULT_SORT,
  ID_ALPHABET,
  JOB_PRIORITY,
  parseAssetId,
  SORT_KEYS,
  type Sort,
} from "../model/index.js";
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

/**
 * An id that is distinct per `n` and still twelve characters of the alphabet
 * RL-14 allows.
 *
 * The leading character varies so that the fixtures land in different shards,
 * which is the only thing a test can get wrong about {@link shardOf} without
 * noticing.
 */
function idOf(n: number): AssetId {
  const head = ID_ALPHABET[n % ID_ALPHABET.length] ?? "0";
  return parseAssetId(`${head}${String(n).padStart(11, "0")}`);
}

/**
 * An `add`, which in version 2 says nothing about the bytes.
 *
 * No size, no dimensions, no storage mode: every one of those is derived
 * (RL-22) and arrives through {@link Repo.putDerived}. A test that needs a size
 * uses {@link sized}.
 */
function asset(n: number, over: Partial<AddRecord> = {}): AddRecord {
  return { id: idOf(n), ext: "png", name: `asset-${n}`, ...over };
}

describe("folding one operation at a time", () => {
  let db: Db;

  beforeEach(() => {
    db = Db.openInMemory();
  });

  afterEach(() => {
    db.close();
  });

  it("covers a folder with its own newest pictures, then its subfolders'", () => {
    // ADR-0043 §7, built 2026-09-25: the user chose the newest, the folder's
    // own first, topped up from below so a folder of folders is not blank.
    const png = Buffer.from([0]);
    const drawn = (n: number, ts: number): AssetId => {
      db.repo.applyAdd(ts, asset(n));
      db.repo.putThumbnail(idOf(n), 256, 1, 1, png);
      return idOf(n);
    };
    db.repo.applyFolderCreate(1, null, "Design");
    db.repo.applyFolderCreate(2, 1, "Icons");
    db.repo.applyFolderCreate(3, 2, "Old");
    db.repo.applyFolderCreate(4, null, "Only folders");
    db.repo.applyFolderCreate(5, 4, "Inside");

    const own = [drawn(1, 10), drawn(2, 20)];
    for (const id of own) db.repo.applyFolderAdd(id, 1);
    db.repo.applyFolderAdd(drawn(3, 90), 2);
    db.repo.applyFolderAdd(drawn(4, 80), 3);
    db.repo.applyFolderAdd(drawn(5, 70), 3);
    // Not drawn, and trashed: neither is a picture to put on a cover.
    db.repo.applyAdd(99, asset(6));
    db.repo.applyFolderAdd(idOf(6), 1);
    db.repo.applyFolderAdd(drawn(7, 95), 1);
    db.repo.applyTrash(idOf(7), 96);
    db.repo.applyFolderAdd(drawn(8, 50), 5);

    const covers = db.repo.folderCovers([1, 4, 5, 3], 256, 4);
    // Own first, newest first; then the subfolders', nearest first.
    expect(covers.get(1)?.map((c) => c.id)).toEqual([idOf(2), idOf(1), idOf(3), idOf(4)]);
    expect(covers.get(4)?.map((c) => c.id)).toEqual([idOf(8)]);
    expect(covers.get(3)?.map((c) => c.id)).toEqual([idOf(4), idOf(5)]);
    // An asset in two folders of one subtree is drawn once.
    db.repo.applyFolderAdd(idOf(3), 1);
    expect(
      db.repo
        .folderCovers([1], 256, 4)
        .get(1)
        ?.map((c) => c.id),
    ).toEqual([idOf(3), idOf(2), idOf(1), idOf(4)]);
  });

  it("finds a large folder's cover by walking the newest, and still finds an old one", () => {
    // More members than the sort is allowed, so the bounded walk runs; the
    // folder of old ones walks past nothing and falls back to the sort.
    const png = Buffer.from([0]);
    db.repo.applyFolderCreate(1, null, "Huge");
    db.transaction(() => {
      for (let n = 0; n < 20_010; n += 1) {
        db.repo.applyAdd(n, asset(n));
        db.repo.putThumbnail(idOf(n), 256, 1, 1, png);
        db.repo.applyFolderAdd(idOf(n), 1);
      }
    });
    expect(
      db.repo
        .folderCovers([1], 256, 4)
        .get(1)
        ?.map((c) => c.id),
    ).toEqual([idOf(20_009), idOf(20_008), idOf(20_007), idOf(20_006)]);
  });

  it("re-importing the same bytes keeps the tags the asset already carried", () => {
    // This is why the insert is `ON CONFLICT ... DO UPDATE` and not
    // `INSERT OR REPLACE`: replace deletes the row first, and the schema's
    // `ON DELETE CASCADE` would take the tags and folder memberships with it.
    const a = asset(1);
    db.repo.applyAdd(10, a);
    db.repo.applyTagAdd(a.id, ["reference"]);
    db.repo.applyFolderCreate(1, null, "Moodboards");
    db.repo.applyFolderAdd(a.id, 1);

    db.repo.applyAdd(20, { ...a, name: "asset-1 (copy).png" });

    const detail = db.repo.assetDetail(a.id);
    expect(detail?.tags).toEqual(["reference"]);
    expect(detail?.folders).toEqual([{ id: 1, path: "Moodboards" }]);
    expect(detail?.name).toBe("asset-1 (copy).png");
    expect(detail?.importedAt).toBe(20);
  });

  it("stores a favourite as an integer, because a boolean cannot be bound", () => {
    // `better-sqlite3` binds numbers, strings, bigints, buffers, and null, and
    // throws on anything else. The column is `CHECK (is_favorite IN (0, 1))`,
    // so the conversion is the schema's, not a workaround.
    const a = asset(2);
    db.repo.applyAdd(10, a);
    db.repo.applyFavoriteSet(a.id, true);
    expect(db.repo.assetDetail(a.id)?.isFavorite).toBe(true);
    expect(db.repo.stats().favorites).toBe(1);

    db.repo.applyFavoriteSet(a.id, false);
    expect(db.repo.assetDetail(a.id)?.isFavorite).toBe(false);
    expect(db.repo.stats().favorites).toBe(0);
  });

  it("distinguishes an unrated asset from a deliberate one star", () => {
    const a = asset(3);
    db.repo.applyAdd(10, a);

    db.repo.applyRate(a.id, 1);
    expect(db.repo.assetDetail(a.id)?.rating).toBe(1);
    expect(db.repo.stats().rated).toBe(1);

    db.repo.applyRate(a.id, null);
    expect(db.repo.assetDetail(a.id)?.rating).toBeNull();
    expect(db.repo.stats().rated).toBe(0);
  });

  it("holds nothing about the bytes until something has read them", () => {
    // The version 2 shape of this row. `created` is the one fact about a file
    // the journal still carries, because nothing can recover it afterwards
    // (RL-22); the size, the dimensions and the hash are `null` until a derive
    // has been anywhere near the file.
    const bare = asset(4);
    db.repo.applyAdd(10, bare);
    expect(db.repo.assetDetail(bare.id)).toMatchObject({
      createdAt: null,
      size: null,
      width: null,
      contentHash: null,
      derivedAt: null,
    });

    const dated = asset(5, { created: 1_700_000_000 });
    db.repo.applyAdd(10, dated);
    expect(db.repo.assetDetail(dated.id)?.createdAt).toBe(1_700_000_000);

    db.repo.putDerived(dated.id, { size: 4096, width: 800, height: 600 }, 1_700_000_100);
    expect(db.repo.assetDetail(dated.id)).toMatchObject({
      size: 4096,
      width: 800,
      height: 600,
      derivedAt: 1_700_000_100,
    });
  });

  it("forgets what it derived when the bytes change under the id", () => {
    // The case version 1 could not have: an edit leaves the asset alone and
    // makes every derived column a description of a file that is gone (RL-20).
    const a = asset(6);
    db.repo.applyAdd(10, a);
    db.repo.putDerived(a.id, { size: 4096, durationMs: 9000 }, 20);
    db.repo.clearDerived(a.id);

    expect(db.repo.assetDetail(a.id)).toMatchObject({
      size: null,
      durationMs: null,
      derivedAt: null,
    });
    // And the row itself survives, which is the whole point of the id.
    expect(db.repo.assetDetail(a.id)?.name).toBe("asset-6");
  });

  it("merges a tag rename onto an existing name instead of failing", () => {
    // `tags.name` is UNIQUE COLLATE NOCASE, so a rename onto a name that exists
    // has no other outcome that both succeeds and replays to the same state.
    const a = asset(6);
    const b = asset(7);
    db.repo.applyAdd(10, a);
    db.repo.applyAdd(10, b);
    db.repo.applyTagAdd(a.id, ["wood"]);
    db.repo.applyTagAdd(b.id, ["timber"]);

    db.repo.applyTagRename("wood", "timber");

    expect(db.repo.stats().tags).toBe(1);
    expect(db.repo.assetDetail(a.id)?.tags).toEqual(["timber"]);
    expect(db.repo.assetDetail(b.id)?.tags).toEqual(["timber"]);
  });

  it("renames a tag in place when only its case changes", () => {
    const a = asset(8);
    db.repo.applyAdd(10, a);
    db.repo.applyTagAdd(a.id, ["wood"]);

    db.repo.applyTagRename("wood", "Wood");

    expect(db.repo.stats().tags).toBe(1);
    expect(db.repo.assetDetail(a.id)?.tags).toEqual(["Wood"]);
  });

  it("keeps the tags when the group arranging them is deleted", () => {
    // `tags.group_id` is ON DELETE SET NULL, never CASCADE: deleting an
    // arrangement must not delete what was arranged, nor unpick every asset
    // carrying it.
    const a = asset(9);
    db.repo.applyAdd(10, a);
    db.repo.applyTagAdd(a.id, ["oak"]);
    db.repo.applyTagGroupCreate(1, "Materials");
    db.repo.applyTagGroupSet("oak", 1);

    db.repo.applyTagGroupDelete(1);

    expect(db.repo.stats().tagGroups).toBe(0);
    expect(db.repo.stats().tags).toBe(1);
    expect(db.repo.assetDetail(a.id)?.tags).toEqual(["oak"]);
  });

  it("deletes a folder without deleting the assets collected in it", () => {
    const a = asset(11);
    db.repo.applyAdd(10, a);
    db.repo.applyFolderCreate(1, null, "Moodboards");
    db.repo.applyFolderCreate(2, 1, "Icons");
    db.repo.applyFolderAdd(a.id, 2);

    db.repo.applyFolderDelete(1);

    // The child folder goes by cascade, and so does the membership. The asset
    // stays: folders are collections, not locations.
    expect(db.repo.stats().folders).toBe(0);
    expect(db.repo.assetDetail(a.id)?.folders).toEqual([]);
    expect(db.repo.stats().assets).toBe(1);
  });

  it("hands out the next id from the journal's maximum, not the table's", () => {
    expect(db.repo.nextFolderId()).toBe(1);
    db.repo.applyFolderCreate(1, null, "One");
    db.repo.applyFolderCreate(2, null, "Two");
    expect(db.repo.nextFolderId()).toBe(3);

    // The id of a deleted folder is **not** handed out again (RL-25a). Through
    // M4 it was, and within one implementation that replayed correctly —
    // create, delete and re-create arrive in the order they happened. It stops
    // being true with a second implementation reading the same journal: a line
    // it could not parse, or an entity it deleted afterwards, and the two hold
    // different folders under one id.
    db.repo.applyFolderDelete(2);
    expect(db.repo.stats().folders).toBe(1);
    expect(db.repo.nextFolderId()).toBe(3);
  });

  it("keeps the mark for each of the four numbered tables apart", () => {
    db.repo.applyFolderCreate(9, null, "Nine");
    db.repo.applySmartFolderCreate(1, null, "Recent", "ext:png");
    db.repo.applyTagGroupCreate(4, "Material");

    expect(db.repo.nextFolderId()).toBe(10);
    expect(db.repo.nextSmartFolderId()).toBe(2);
    expect(db.repo.nextTagGroupId()).toBe(5);
    // Nothing has been commented on, so this one is still at the beginning.
    expect(db.repo.nextCommentId()).toBe(1);
  });

  it("reports an id prefix that names two assets as two", () => {
    // Two ids sharing everything but their last character, which is what
    // `idOf` produces for two numbers 32 apart.
    db.repo.applyAdd(10, asset(1));
    db.repo.applyAdd(10, asset(2));
    expect(db.repo.resolveIdPrefix("1")).toHaveLength(1);
    expect(db.repo.resolveIdPrefix(idOf(1))).toEqual([idOf(1)]);
    // A prefix every id shares answers with the two the limit allows.
    expect(db.repo.resolveIdPrefix("")).toHaveLength(2);
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

    const ids = seen.map((h) => h.id);
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    // Descending on the tie-break, because the key is descending and the
    // tie-break follows it (migration 0014).
    expect(ids).toEqual([...ids].sort().reverse());
  });

  it("names the cursor once and writes it once per seek", () => {
    // The regression the Rust build's benchmark found, expressed as a property
    // of the SQL rather than of a timing. A query-plan test cannot catch it:
    // with the parameters written as literals the two values become one
    // constant, which SQLite collapses exactly as it collapses one shared
    // parameter, so the plan looks correct either way.
    const sql = searchSql("1", true);
    // `\b` matters: an unanchored `/@cursorKey/` also matches a second,
    // distinct `@cursorKey2`, so the broken version passes the test meant to
    // catch it.
    expect(sql.match(/@cursorKey\b/g)).toHaveLength(2);
    expect(sql).toContain("a.id < @cursorId");
    expect(sql.trimEnd().endsWith("LIMIT @limit")).toBe(true);
  });

  it("resumes as two seeks rather than one predicate over a run of equal keys", () => {
    // ADR-0039 §4: written as one disjunction, SQLite seeks on the key and then
    // walks every row sharing it — invisible until a key repeats, and ratings
    // have six values. The two halves are asserted structurally because the
    // cost is invisible in a fixture small enough to write down.
    const sql = searchSql("1", true, { key: "rating", descending: true, seed: 0 });
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain("COALESCE(a.rating, 0) = @cursorKey AND a.id < @cursorId");
    expect(sql).toContain("COALESCE(a.rating, 0) < @cursorKey");
  });

  it("resumes a shuffle as two seeks as well, because its key ties on purpose", () => {
    // ADR-0039 §11: the key is one character's place in a reordered alphabet,
    // and the first seek — the rest of that character's run, in id order — is
    // what spares most pages a sort of the whole library.
    const sql = searchSql("1", true, { key: "random", descending: false, seed: 3 });
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain(
      "instr(@shuffleAlphabet, substr(a.id, @shuffleAt, 1)) = @cursorKey AND a.id > @cursorId",
    );
  });

  it("orders by a total order, tie-break included and pointing the same way", () => {
    // Also structural, and for a subtler reason than the one above. The
    // ordering index *is* `(imported_at DESC, hash DESC)`, so SQLite satisfies
    // `ORDER BY imported_at DESC` by walking it — and hands back rows in hash
    // order anyway. Dropping the tie-break is invisible to any fixture small
    // enough to write, and stops being invisible on a library where a different
    // plan is cheaper. The direction matters as much as the column: a mixed
    // order is one an index serves in a single direction (migration 0014).
    expect(searchSql("1", false)).toContain("ORDER BY a.imported_at DESC, a.id DESC");
    expect(searchSql("1", false, { key: "name", descending: false, seed: 0 })).toContain(
      "ORDER BY lower(a.name) ASC, a.id ASC",
    );
  });

  it("leaves the filter's own placeholders anonymous and positional", () => {
    // `better-sqlite3` treats `?NNN` as a *named* parameter and refuses to bind
    // it positionally, so the Rust build's numbering does not survive the port.
    // The filter contract stays anonymous `?`; everything appended is named.
    // Sizes are derived, so they have to be put there before a filter can ask
    // about them — which is the version 2 shape of every test about bytes.
    for (let n = 1; n <= 7; n += 1) db.repo.putDerived(idOf(n), { size: 100 + n }, 1_700_000_000);

    const filter: Filter = { sql: "a.ext = ? AND a.size >= ?", params: ["png", 105] };
    const hits = db.repo.search(filter, { limit: 10 });
    expect(hits.map((h) => h.id)).toEqual([5, 6, 7].map(idOf).sort().reverse());
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
  function planFor(filterSql: string, sort: Sort = DEFAULT_SORT, ...params: unknown[]): string {
    const raw = new BetterSqlite3(db.path, { readonly: true });
    try {
      // The filter is written once per seek and a resume has two of them, so
      // its positional values are repeated with it — the same doubling
      // `Repo.search` does.
      const plan = raw
        .prepare(`EXPLAIN QUERY PLAN ${searchSql(filterSql, true, sort)}`)
        .all(...params, ...params, {
          cursorKey: sort.key === "name" ? "asset-1" : 1_700_000_100,
          cursorId: idOf(1),
          limit: 200,
          shuffleAt: 1,
          shuffleAlphabet: ID_ALPHABET,
        }) as { detail: string }[];
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
    const detail = planFor(`(a.ext = ?) AND ${MATCH_LIVE.sql}`, DEFAULT_SORT, "png");

    expect(detail).toContain("idx_assets_ext");
    expect(detail).not.toContain("TEMP B-TREE");
  });

  it("uses the partial indexes only when the query says it is looking at live assets", () => {
    // The grid's indexes are partial, and SQLite will use one only when the
    // query's WHERE contains a term implying the index's. That makes the exact
    // spelling of the scope predicate part of the schema rather than a detail
    // of the compiler — so it is asserted, and the unscoped version is asserted
    // to lose the index rather than silently falling back to a scan nobody
    // measured.
    expect(planFor("a.ext = ?", DEFAULT_SORT, "png")).not.toContain("idx_assets_ext");
    expect(planFor(`(1) AND ${MATCH_LIVE.sql}`)).toContain("idx_assets_imported");

    // **The whole scope is one term now**, where version 1 had two: there is no
    // `superseded_by` any more (ADR-0046), so a query carrying `trashed_at IS
    // NULL` carries all of it and keeps the index. The caption-track rule is a
    // subquery, which SQLite forbids in an index's WHERE — so it is checked per
    // row the seek returns rather than being part of the index.
    expect(planFor("(1) AND a.trashed_at IS NULL")).toContain("idx_assets_imported");
  });

  it("gives the Trash place its own index, in the same order as every other view", () => {
    const detail = planFor("a.trashed_at IS NOT NULL");
    expect(detail).toContain("idx_assets_trashed");
    expect(detail).not.toContain("TEMP B-TREE");
  });

  it.each([
    ["created", "idx_assets_created"],
    ["name", "idx_assets_name"],
    ["size", "idx_assets_size"],
    ["rating", "idx_assets_rated"],
  ] as const)("seeks rather than sorts when the grid is ordered by %s", (key, index) => {
    // The whole of ADR-0039's engine half. Without an index per order the
    // plan carries a TEMP B-TREE, which is SQLite reading the match set into a
    // sorter to produce one screen: 28–35 ms at 95,001 assets against 0.05 ms
    // with it (`docs/BENCHMARKS.md`). The index has to be spelled exactly as
    // the order is — `COALESCE(size, 0)`, not `size` — or it serves nothing.
    for (const descending of [false, true]) {
      const detail = planFor(`(1) AND ${MATCH_LIVE.sql}`, { key, descending, seed: 0 });
      expect(detail).toContain(index);
      expect(detail).not.toContain("TEMP B-TREE");
    }
  });

  it("has no index for the random order, and says so rather than pretending", () => {
    // A shuffle per seed is an index per shuffle. Its second seek sorts every
    // match: the cost ADR-0039 §5 accepts deliberately, and a test asserting it
    // is what keeps the acceptance visible. The first seek walks the ids in
    // order and sorts nothing, which is what §11 bought.
    const [sameKey, beyondKey] = planFor(`(1) AND ${MATCH_LIVE.sql}`, {
      key: "random",
      descending: false,
      seed: 7,
    }).split("UNION ALL");
    expect(beyondKey).toContain("TEMP B-TREE");
    expect(sameKey).not.toContain("TEMP B-TREE");
  });

  it("reads a tag's name once per query, not once per asset", () => {
    // Spelled as `@roost/search` compiles `tag:` (its `query.test.ts` holds the
    // string). Joined to `tags` instead, SQLite looked the name up in a
    // correlated subquery, again for every asset the seek returned: 515 ms
    // against 370 ms for a count at a million assets (`docs/BENCHMARKS.md`).
    const tag =
      "EXISTS (SELECT 1 FROM asset_tags at WHERE at.asset_id = a.id" +
      " AND at.tag_id = (SELECT t.id FROM tags t WHERE t.name = ?))";
    const lines = planFor(`(${tag}) AND ${MATCH_LIVE.sql}`, DEFAULT_SORT, "wood").split("\n");
    const name = lines.findIndex((line) => line.includes("SEARCH t "));
    expect(name).toBeGreaterThan(0);
    expect(lines[name - 1]).toMatch(/^SCALAR SUBQUERY/);
    expect(lines.join("\n")).toContain("(asset_id=? AND tag_id=?)");
  });

  it("seeks an asset's folders once, whatever the length of the folder list", () => {
    // `folder:` over a subtree: given the list, the seek was one per folder per
    // asset, 2.5 s for a count over sixteen folders at a million assets, where
    // reading the asset's own row or two is one seek: 0.36 s.
    const folders =
      "EXISTS (SELECT 1 FROM asset_folders af WHERE af.asset_id = a.id" +
      " AND +af.folder_id IN (?, ?, ?))";
    const detail = planFor(`(${folders}) AND ${MATCH_LIVE.sql}`, DEFAULT_SORT, 1, 2, 3);
    expect(detail).toContain("sqlite_autoindex_asset_folders_1 (asset_id=?)");
    expect(detail).not.toContain("folder_id=?");
  });
});

describe("every order pages without repeating or skipping a row", () => {
  let db: Db;

  beforeEach(() => {
    db = Db.openInMemory();
    db.transaction(() => {
      for (let n = 1; n <= 25; n += 1) {
        // Keys that tie on purpose: five timestamps over twenty-five assets,
        // one size for a third of them, and a rating on some. A key that never
        // repeats never exercises the second seek.
        db.repo.applyAdd(1_700_000_000 + (n % 5), asset(n));
        db.repo.putDerived(idOf(n), { size: n % 3 === 0 ? 100 : 100 + n }, 1_700_000_000);
        if (n % 4 === 0) db.repo.applyRate(idOf(n), 3);
      }
    });
  });

  afterEach(() => {
    db.close();
  });

  const walk = (sort: Sort): SearchHit[] => {
    const seen: SearchHit[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const hits = db.repo.search(MATCH_ALL, {
        limit: 4,
        sort,
        ...(cursor && { after: cursor }),
      });
      if (hits.length === 0) break;
      seen.push(...hits);
      cursor = lastCursor(hits);
      // A runaway loop is the failure this whole shape exists to catch, and an
      // unbounded `for` would hang the suite rather than fail it.
      if (seen.length > 100) throw new Error("paging did not terminate");
    }
    return seen;
  };

  it.each(SORT_KEYS)("in %s, both ways", (key) => {
    for (const descending of [false, true]) {
      const seen = walk({ key, descending, seed: 4 });
      const ids = seen.map((hit) => hit.id);
      expect(ids).toHaveLength(25);
      expect(new Set(ids).size).toBe(25);

      // And in the order it was asked for, not merely all of it: a page that
      // starts again from the top would still return every row once if the
      // cursor happened to advance.
      const keys = seen.map((hit) => hit.sortKey);
      const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      expect(keys).toEqual(descending ? sorted.reverse() : sorted);
    }
  });
});

describe("the random order", () => {
  let db: Db;

  /**
   * Ids with every character carrying information, unlike `idOf`.
   *
   * The shuffle is a rotation of the id, so it shuffles exactly as far as the
   * id is uniformly distributed — which a minted id is (RL-14) and a padded
   * counter is not. A fixture of counters is ordered the same way by every
   * seed, and a test built on it would report a working shuffle as a broken
   * one.
   */
  const spread = (n: number): AssetId => {
    let state = n * 2654435761;
    let id = "";
    while (id.length < 12) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      id += ID_ALPHABET[(state >>> 8) % ID_ALPHABET.length];
    }
    return parseAssetId(id.slice(0, 12));
  };

  beforeEach(() => {
    db = Db.openInMemory();
    db.transaction(() => {
      for (let n = 1; n <= 60; n += 1) {
        db.repo.applyAdd(1_700_000_000 + n, { ...asset(n), id: spread(n) });
      }
    });
  });

  afterEach(() => {
    db.close();
  });

  const order = (seed: number): string[] =>
    db.repo
      .search(MATCH_ALL, { limit: 60, sort: { key: "random", descending: false, seed } })
      .map((hit) => hit.id);

  it("gives one seed's order and another seed's differently", () => {
    const one = order(1);
    const two = order(2);
    expect(new Set(one)).toEqual(new Set(two));
    expect(one).not.toEqual(two);
    // And neither is the order the rows arrived in, which is the shuffle that
    // would be no shuffle at all.
    expect(one).not.toEqual(
      db.repo.search(MATCH_ALL, { limit: 60, sort: DEFAULT_SORT }).map((hit) => hit.id),
    );
  });

  it("is the same order every time it is asked for one seed", () => {
    // What a cursor rests on: a shuffle that moved between two pages would show
    // one asset twice and another not at all.
    expect(order(9)).toEqual(order(9));
  });

  it("gives a different order for each of many seeds", () => {
    // The rotation this replaced had eleven shuffles, so a window rolling one
    // at every open would have shown an old one again within a week. Sixty
    // assets in twenty seeds is too small to prove there are many, and large
    // enough that eleven would have repeated.
    const orders = new Set(Array.from({ length: 20 }, (_, seed) => order(seed).join()));
    expect(orders.size).toBe(20);
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
    for (const n of [1, 2, 3]) db.repo.enqueueJob("derive", idOf(n), priority, 1_700_000_000);
  };

  it("claims in priority order, then in the order work arrived", () => {
    db.repo.enqueueJob("derive", idOf(1), JOB_PRIORITY.backfill, 1_700_000_000);
    db.repo.enqueueJob("derive", idOf(2), JOB_PRIORITY.backfill, 1_700_000_001);
    db.repo.enqueueJob("derive", idOf(3), JOB_PRIORITY.interactive, 1_700_000_002);

    // The asset someone is looking at goes first, even though it was queued
    // last — that is the whole point of the priority.
    expect(db.repo.claimJobs("derive", 3).map((job) => job.assetId)).toEqual([
      idOf(3),
      idOf(1),
      idOf(2),
    ]);
  });

  it("hands a claimed job the bytes it is about", () => {
    db.repo.applyAdd(1_700_000_009, asset(9));
    db.repo.enqueueJob("derive", idOf(9), JOB_PRIORITY.import, 1_700_000_009);

    // A runner needs the id and the extension to find the file at all (RL-9),
    // and a per-job lookup afterwards would be a second query per asset. There
    // is no mode to carry any more — every asset's bytes are under `files/`.
    expect(db.repo.claimJobs("derive", 1)[0]).toMatchObject({
      assetId: idOf(9),
      ext: "png",
      posterMs: null,
      attempts: 1,
    });
  });

  it("does not hand the same job to two runners", () => {
    enqueueAll();

    const first = db.repo.claimJobs("derive", 2);
    const second = db.repo.claimJobs("derive", 2);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((job) => job.assetId)).size).toBe(3);
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
    db.repo.enqueueJob("derive", idOf(1), JOB_PRIORITY.import, 1_700_000_000);
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

  it("names the files a derive failed on, and how often each was tried", () => {
    // A count is not something anybody can act on: the dialog that reports
    // failures groups them, and it needs the file each one is about to do it.
    enqueueAll();
    const claims = db.repo.claimJobs("derive", 3);
    db.repo.failJob(claims[0]?.id ?? 0, "sharp: unsupported image format");
    db.repo.failJob(claims[1]?.id ?? 0, "sharp: unsupported image format");

    expect(db.repo.jobsIn("derive", "failed", 10)).toEqual([
      {
        assetId: idOf(1),
        name: "asset-1",
        ext: "png",
        attempts: 1,
        reason: "sharp: unsupported image format",
      },
      {
        assetId: idOf(2),
        name: "asset-2",
        ext: "png",
        attempts: 1,
        reason: "sharp: unsupported image format",
      },
    ]);
    expect(db.repo.jobsIn("derive", "failed", 1)).toHaveLength(1);
  });

  it("puts one file's stalled job back, and nothing else", () => {
    // The per-file Try again (ADR-0050).
    enqueueAll();
    const claims = db.repo.claimJobs("derive", 3);
    db.repo.failJob(claims[0]?.id ?? 0, "sharp: corrupt header");
    db.repo.blockJob(claims[1]?.id ?? 0, "missing:libheif");

    expect(db.repo.requeueJobFor("derive", idOf(1))).toBe(true);
    expect(db.repo.requeueJobFor("derive", idOf(1))).toBe(false);
    // Still running: not stalled, so not this button's to release.
    expect(db.repo.requeueJobFor("derive", idOf(3))).toBe(false);
    expect(db.repo.stalledReasons("derive", [idOf(1), idOf(2)])).toEqual(
      new Map([[idOf(2), "missing:libheif"]]),
    );
  });

  it("says why each asset on a page has no picture, and nothing for the rest", () => {
    // A grid cell with no thumbnail used to be a grey square with an extension
    // in it, whatever the reason; the card now carries the reason.
    enqueueAll();
    const claims = db.repo.claimJobs("derive", 3);
    db.repo.blockJob(claims[0]?.id ?? 0, "missing:libheif");
    db.repo.failJob(claims[1]?.id ?? 0, "sharp: unsupported image format");
    // The third is still running: not stalled, so absent.

    const reasons = db.repo.stalledReasons("derive", [idOf(1), idOf(2), idOf(3)]);
    expect(Object.fromEntries(reasons)).toEqual({
      [idOf(1)]: "missing:libheif",
      [idOf(2)]: "sharp: unsupported image format",
    });
    expect(db.repo.stalledReasons("derive", [])).toEqual(new Map());
  });

  it("reads parked work the same way, because the question about it is the same", () => {
    // `blocked` is not a failure — a format nothing here draws, or a decoder
    // nobody installed (ADR-0040) — but "which files, and why" is asked of both.
    enqueueAll();
    const claims = db.repo.claimJobs("derive", 3);
    db.repo.blockJob(claims[0]?.id ?? 0, "missing:libheif");

    expect(db.repo.jobsIn("derive", "blocked", 10)).toMatchObject([
      { assetId: idOf(1), name: "asset-1", reason: "missing:libheif" },
    ]);
    expect(db.repo.jobsIn("derive", "failed", 10)).toEqual([]);
  });

  it("re-queuing something urgent moves it ahead of what it was behind", () => {
    db.repo.enqueueJob("derive", idOf(1), JOB_PRIORITY.backfill, 1_700_000_000);
    db.repo.enqueueJob("derive", idOf(2), JOB_PRIORITY.backfill, 1_700_000_001);
    db.repo.enqueueJob("derive", idOf(2), JOB_PRIORITY.interactive, 1_700_000_002);

    // The job's own id is a number; what says *which asset* is the assetId.
    expect(db.repo.claimJobs("derive", 1)[0]?.assetId).toBe(idOf(2));
  });

  it("drops a job whose asset was removed", () => {
    db.repo.enqueueJob("derive", idOf(1), JOB_PRIORITY.import, 1_700_000_000);
    db.repo.applyRemove(idOf(1));

    expect(db.repo.claimJobs("derive", 5)).toEqual([]);
    expect(db.repo.jobCounts()).toEqual([]);
  });

  it("claims one job at a time, most urgent first, and only up to a priority", () => {
    db.repo.enqueueJob("derive", idOf(1), JOB_PRIORITY.backfill, 1_700_000_000);
    db.repo.enqueueJob("derive", idOf(2), JOB_PRIORITY.interactive, 1_700_000_001);

    expect(db.repo.claimJob("derive", JOB_PRIORITY.interactive)?.assetId).toBe(idOf(2));
    // Nothing interactive is left, and the bound is what stops the backfill
    // being handed out in its place.
    expect(db.repo.claimJob("derive", JOB_PRIORITY.interactive)).toBeUndefined();
    expect(db.repo.claimJob("derive")?.assetId).toBe(idOf(1));
    expect(db.repo.claimJob("derive")).toBeUndefined();
  });

  it("claims past a job whose asset has gone, so empty means empty", () => {
    enqueueAll();
    // Foreign keys would cascade the job away with the asset; a row whose
    // asset vanished some other way is what this guards against.
    db.pragma("foreign_keys = OFF");
    db.repo.applyRemove(idOf(1));
    db.pragma("foreign_keys = ON");

    expect(db.repo.claimJob("derive")?.assetId).toBe(idOf(2));
  });

  it("claims the job for one asset only while it is waiting", () => {
    enqueueAll();

    expect(db.repo.claimJobFor("derive", idOf(3))?.assetId).toBe(idOf(3));
    // Already running — another runner has it, or this one does.
    expect(db.repo.claimJobFor("derive", idOf(3))).toBeUndefined();

    const blocked = db.repo.claimJobFor("derive", idOf(2));
    db.repo.blockJob(blocked?.id ?? 0, "unsupported:zip");
    // Parked work is released deliberately, never by being looked at.
    expect(db.repo.claimJobFor("derive", idOf(2))).toBeUndefined();
    expect(db.repo.claimJobFor("derive", idOf(9))).toBeUndefined();
  });

  it("counts each state without reading the queue into a sorter", () => {
    enqueueAll();
    const [first, second] = db.repo.claimJobs("derive", 2);
    db.repo.blockJob(first?.id ?? 0, "missing:ffmpeg");
    expect(second).toBeDefined();
    db.repo.applyAdd(1_700_000_009, asset(9));
    db.repo.enqueueJob("derive", idOf(9), JOB_PRIORITY.import, 1_700_000_009);

    // `ready` is what the unfinished states leave of the total, so it has to
    // come out the same as counting it would.
    expect(db.repo.jobCounts()).toEqual([
      { kind: "derive", state: "blocked", count: 1 },
      { kind: "derive", state: "ready", count: 2 },
      { kind: "derive", state: "running", count: 1 },
    ]);
  });
});

describe("derived metadata", () => {
  let db: Db;

  beforeEach(() => {
    db = Db.openInMemory();
    db.repo.applyAdd(1_700_000_001, asset(1));
  });

  afterEach(() => {
    db.close();
  });

  it("does not erase what an earlier pass found", () => {
    // A backend that knows a page count and nothing else must not blank the
    // dimensions probing already wrote.
    db.repo.putDerived(idOf(1), { width: 800, height: 600 }, 20);
    db.repo.putDerived(idOf(1), { pageCount: 12 }, 30);

    expect(db.repo.assetDetail(idOf(1))).toMatchObject({
      width: 800,
      height: 600,
      pageCount: 12,
      durationMs: null,
      // Written whenever anything is, because it is what a sweep compares.
      derivedAt: 30,
    });
  });

  it("carries format-specific properties the columns have no room for", () => {
    db.repo.putDerived(idOf(1), { props: { "font.family": "Adwaita Sans" } }, 20);
    db.repo.putDerived(
      idOf(1),
      {
        props: { "font.family": "Adwaita Sans", "font.style": "Regular" },
      },
      20,
    );

    expect(db.repo.assetDetail(idOf(1))?.props).toEqual({
      "font.family": "Adwaita Sans",
      "font.style": "Regular",
    });
  });

  it("loses its properties with the asset, not before", () => {
    db.repo.putDerived(idOf(1), { props: { "font.family": "Adwaita Sans" } }, 20);
    db.repo.applyRemove(idOf(1));

    expect(db.repo.props(idOf(1))).toEqual({});
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

  /** Three assets, derived as 1000, 2000 and 3000 bytes. */
  const three = (): AssetId[] =>
    [1, 2, 3].map((n) => {
      const a = asset(n);
      db.repo.applyAdd(10 * n, a);
      db.repo.putDerived(a.id, { size: n * 1000 }, 10 * n);
      return a.id;
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
    const ids = three();
    for (const id of ids) db.repo.applyRate(id, 4);
    expect(db.repo.selectionSummary(ids)).toMatchObject({ rating: 4, ratingMixed: false });

    db.repo.applyRate(ids[1] as AssetId, 2);
    expect(db.repo.selectionSummary(ids)).toMatchObject({ rating: null, ratingMixed: true });
  });

  it("treats one unrated asset among rated ones as mixed", () => {
    // The case a `min = max` test alone would call agreement: two fours and an
    // unrated is not "they are all four".
    const ids = three();
    db.repo.applyRate(ids[0] as AssetId, 4);
    db.repo.applyRate(ids[1] as AssetId, 4);
    expect(db.repo.selectionSummary(ids)).toMatchObject({ rating: null, ratingMixed: true });
  });

  it("says whether their notes agree, and how many hold one (ADR-0048)", () => {
    const ids = three();
    // Nobody has a note: agreement, with nothing to replace.
    expect(db.repo.selectionSummary(ids).note).toEqual({
      value: null,
      mixed: false,
      distinct: 0,
      holding: 0,
    });

    for (const id of ids) db.repo.applyNoteSet(id, "draft");
    expect(db.repo.selectionSummary(ids).note).toEqual({
      value: "draft",
      mixed: false,
      distinct: 1,
      holding: 3,
    });

    // The rating's trap again: `min` skips NULLs, so two "draft"s and an empty
    // note would read as agreement if the holders were not counted.
    db.repo.applyNoteSet(ids[2] as AssetId, null);
    expect(db.repo.selectionSummary(ids).note).toEqual({
      value: null,
      mixed: true,
      distinct: 1,
      holding: 2,
    });

    db.repo.applyNoteSet(ids[2] as AssetId, "final");
    expect(db.repo.selectionSummary(ids).note).toMatchObject({ mixed: true, distinct: 2 });
  });

  it("does the same for the source, independently of the note", () => {
    const ids = three();
    for (const id of ids) db.repo.applySourceSet(id, "https://example.com/post");
    const summary = db.repo.selectionSummary(ids);
    expect(summary.source).toEqual({
      value: "https://example.com/post",
      mixed: false,
      distinct: 1,
      holding: 3,
    });
    expect(summary.note.holding).toBe(0);
  });

  it("separates a tag they all carry from one only some carry", () => {
    const ids = three();
    for (const id of ids) db.repo.applyTagAdd(id, ["wood"]);
    db.repo.applyTagAdd(ids[0] as AssetId, ["wip"]);

    const summary = db.repo.selectionSummary(ids);
    expect(summary.sharedTags).toEqual(["wood"]);
    expect(summary.partialTags).toEqual(["wip"]);
  });

  it("separates a folder they are all in from one only some are in", () => {
    const ids = three();
    db.repo.applyFolderCreate(1, null, "Design");
    db.repo.applyFolderCreate(2, 1, "Icons");
    for (const id of ids) db.repo.applyFolderAdd(id, 1);
    db.repo.applyFolderAdd(ids[0] as AssetId, 2);

    const summary = db.repo.selectionSummary(ids);
    expect(summary.sharedFolders).toEqual([{ id: 1, path: "Design" }]);
    // The nested one carries its whole path: a control that says "Icons" alone
    // does not say which `Icons`, and a library may hold three of them.
    expect(summary.partialFolders).toEqual([{ id: 2, path: "Design/Icons" }]);
  });

  it("counts membership, not the subtree a folder query would match", () => {
    // `folder:Design` finds all three through the child, but only one asset was
    // added to `Design/Icons` — and detaching is about what was added.
    const ids = three();
    db.repo.applyFolderCreate(1, null, "Design");
    db.repo.applyFolderCreate(2, 1, "Icons");
    for (const id of ids) db.repo.applyFolderAdd(id, 2);

    expect(db.repo.selectionSummary(ids).sharedFolders).toEqual([{ id: 2, path: "Design/Icons" }]);
  });

  it("ignores an asset the library does not hold", () => {
    // A selection can outlive the rows it points at, and the summary must
    // describe what is there rather than what was asked about.
    const ids = three();
    expect(db.repo.selectionSummary([...ids, idOf(99)]).count).toBe(3);
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
