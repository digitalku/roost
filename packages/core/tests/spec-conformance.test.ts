import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allMigrations, Db, latestSchemaVersion } from "@roost/core";
import { describe, expect, it } from "vitest";

const docs = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url)), "utf8");

/** Every fenced ```sql block in a markdown file, in order. */
function sqlBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

/**
 * The statements a block contains, with comments and layout removed.
 *
 * Comparing normalised statements rather than text is the point: the migration
 * files carry long explanations the documents phrase differently, and a test
 * that failed on a reworded comment would be turned off within a week.
 */
function statements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s !== "");
}

describe("the schema on disk against the schema in the documents", () => {
  it("keeps migration 0001 identical to the binding specification's schema v1", () => {
    const spec = sqlBlocks(docs("STORAGE_SPEC.md"))[0];
    expect(spec).toBeDefined();

    // The two PRAGMAs in the specification's block are deliberately not in the
    // migration: `journal_mode` cannot be set inside a transaction, and
    // `foreign_keys` is per-connection. Both are applied at open instead, and
    // migration 0001's header says so.
    const published = statements(spec ?? "").filter((s) => !s.startsWith("PRAGMA"));
    const migration = allMigrations()[0];

    expect(migration?.version).toBe(1);
    expect(statements(migration?.sql ?? "")).toEqual(published);
  });

  it("keeps migrations 0002 to 0005 identical to what DATA_MODEL publishes", () => {
    // `DATA_MODEL.md` §2.1 through §2.4 publish one block each, in migration
    // order, because the specification's schema block is v1 and stays v1 —
    // growth lives in that file (its §2).
    const published = sqlBlocks(docs("DATA_MODEL.md"));
    expect(published).toHaveLength(4);

    for (const [index, block] of published.entries()) {
      const migration = allMigrations()[index + 1];
      expect(migration?.version).toBe(index + 2);
      expect(statements(migration?.sql ?? "")).toEqual(statements(block));
    }
  });

  it("carries the migration numbers a library from the Rust build already has", () => {
    // A library created by `roost-old` arrives at v5 with those five versions
    // in its bookkeeping. Consolidating them into one baseline here — tempting
    // with no users yet — would either re-run against such a library or
    // disagree with it about what version it is. The first migration this
    // repository authors is 0006.
    expect(allMigrations().map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
    expect(latestSchemaVersion()).toBe(5);
  });
});

describe("the schema a fresh library actually gets", () => {
  it("ends with the filter indexes replacing their single-column predecessors", () => {
    // Migrations 0003 and 0005 each `DROP` an index and create one that leads
    // with the same column. Running them in order has to leave exactly one
    // index per filter, or every insert maintains two.
    const db = Db.open(":memory:");
    try {
      const indexes = (db.pragma("index_list(assets)") as { name: string; partial: number }[])
        .map((row) => row.name)
        .filter((name) => name.startsWith("idx_"))
        .sort();

      expect(indexes).toEqual([
        "idx_assets_ext",
        "idx_assets_favorite",
        "idx_assets_imported",
        "idx_assets_rating",
      ]);

      for (const index of indexes) {
        const columns = (db.pragma(`index_info(${index})`) as { name: string | null }[]).map(
          (c) => c.name,
        );
        // Every one of them carries the grid's sort key, which is what lets
        // SQLite seek and stop at the LIMIT instead of sorting the match set.
        expect(columns.slice(-2)).toEqual(["imported_at", "hash"]);
      }
    } finally {
      db.close();
    }
  });
});
