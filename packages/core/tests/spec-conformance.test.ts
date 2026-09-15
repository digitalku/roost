import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allMigrations, Db, latestSchemaVersion, OP_NAMES, toLine, toRecord } from "@roost/core";
import { describe, expect, it } from "vitest";

const docs = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url)), "utf8");

/**
 * A file from the Roost Library Format, checked out beside this repository.
 *
 * The journal vocabulary is the standard's (RL-24), so this is what the
 * vocabulary is compared against. It is never vendored — see ADR-0045, and
 * `packages/library/tests/format-conformance.test.ts` for the rest of the suite.
 */
const standard = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../../roost-library/${name}`, import.meta.url)),
    "utf8",
  );

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

/**
 * Every journal line the registry publishes, with its hashes filled in.
 *
 * A document elides a hash to its first few characters, which is right for
 * something a person reads and unparseable here. Padding restores the length
 * `isContentHash` checks without inventing a different value: the point is the
 * shape of the line, never which asset it names.
 *
 * Both spellings of the elision are accepted — the registry sets a real
 * ellipsis, and a document typed by hand may carry three dots.
 */
function publishedOps(markdown: string): string[] {
  return [...markdown.matchAll(/```json\n([\s\S]*?)```/g)]
    .flatMap((block) => (block[1] ?? "").split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{"ts"'))
    .map((line) =>
      line.replace(
        /"([0-9a-f]{1,63})(?:…|\.\.\.)"/g,
        (_, head: string) => `"${head.padEnd(64, "0")}"`,
      ),
    );
}

/** The `op` of one published line, read without parsing the rest of it. */
function opOf(line: string): string {
  const found = /"op":"([a-z_]+)"/.exec(line);
  if (found?.[1] === undefined) throw new Error(`no op in published line: ${line}`);
  return found[1];
}

describe("the schema on disk against the schema in the documents", () => {
  it("keeps every migration identical to what DATA_MODEL publishes", () => {
    // §2.0 through §2.13 publish one block each, in migration order. The schema
    // is a **cache** as far as the library format is concerned (RL-2), which is
    // why all fourteen live in one document here rather than the first one
    // living in a specification: what the format binds is that every row can be
    // rebuilt from the journal, not what shape the rows are.
    const published = sqlBlocks(docs("DATA_MODEL.md"));
    expect(published).toHaveLength(14);

    for (const [index, block] of published.entries()) {
      const migration = allMigrations()[index];
      expect(migration?.version).toBe(index + 1);

      // The two PRAGMAs in §2.0's block are deliberately not in migration 0001:
      // `journal_mode` cannot be set inside a transaction, and `foreign_keys`
      // is per-connection. Both are applied at open instead, and the migration's
      // header says so.
      const want = statements(block).filter((statement) => !statement.startsWith("PRAGMA"));
      expect(statements(migration?.sql ?? "")).toEqual(want);
    }
  });

  it("carries the migration numbers a library from the Rust build already has", () => {
    // A library created by `roost-old` arrives at v5 with those five versions
    // in its bookkeeping. Consolidating them into one baseline here — tempting
    // with no users yet — would either re-run against such a library or
    // disagree with it about what version it is. 0006 is the first migration
    // this repository authors, and it is where the two builds part company:
    // see `DATA_MODEL.md` §2.5 on what a library that goes back has to do.
    expect(allMigrations().map((m) => m.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(latestSchemaVersion()).toBe(14);
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

      expect(indexes).toEqual(
        [
          // The four filter indexes and the ordering one, each rebuilt by 0014
          // with its tie-break pointing the same way as its key.
          "idx_assets_ext",
          "idx_assets_favorite",
          "idx_assets_imported",
          "idx_assets_rating",
          "idx_assets_trashed",
          // And one per sort key the view menu offers, added by 0014. `random`
          // has none and cannot have one (ADR-0039 §5).
          "idx_assets_created",
          "idx_assets_name",
          "idx_assets_rated",
          "idx_assets_size",
        ].sort(),
      );

      // Migration 0007 made every one of them partial: four scoped to live
      // assets and one to the trash. An index that covered both would make
      // SQLite filter after the seek, which is the cost 0005 exists to avoid.
      const partial = (db.pragma("index_list(assets)") as { name: string; partial: number }[])
        .filter((row) => row.name.startsWith("idx_"))
        .every((row) => row.partial === 1);
      expect(partial).toBe(true);

      for (const index of [
        "idx_assets_ext",
        "idx_assets_favorite",
        "idx_assets_imported",
        "idx_assets_rating",
        "idx_assets_trashed",
      ]) {
        const columns = (db.pragma(`index_info(${index})`) as { name: string | null }[]).map(
          (c) => c.name,
        );
        // Every one of them carries the default order, which is what lets
        // SQLite seek and stop at the LIMIT instead of sorting the match set.
        expect(columns.slice(-2)).toEqual(["imported_at", "hash"]);
      }

      // And every one of the four new ones ends on the same tie-break, because
      // an order that is not total pages wrongly (migration 0003). Two of them
      // index an expression, which `index_info` reports as a null name — the
      // expression itself is asserted in `repo.test.ts` through the plan.
      for (const index of [
        "idx_assets_created",
        "idx_assets_name",
        "idx_assets_rated",
        "idx_assets_size",
      ]) {
        const columns = (db.pragma(`index_info(${index})`) as { name: string | null }[]).map(
          (c) => c.name,
        );
        expect(columns).toHaveLength(2);
        expect(columns.at(-1)).toBe("hash");
      }
    } finally {
      db.close();
    }
  });
});

describe("the journal vocabulary against the vocabulary in the documents", () => {
  it("publishes one example line for every operation this build understands", () => {
    // The drift this catches has happened twice, and both times in the same
    // direction: an operation was built, `OP_NAMES` grew, and the specification
    // was not told — once for the three comment ops of ADR-0023, once for the
    // two subtitle ops and `supersede` of ADR-0025 and ADR-0026. Nothing failed
    // either time, because the list in the document is prose and prose does not
    // compile. `sink.ts` already ties the `Op` union to the repository through
    // a `never`, and `noImplicitReturns` ties the renderer's fake engine to the
    // request union the same way; this is the one edge of that vocabulary the
    // compiler cannot reach, because one end of it is a markdown file.
    //
    // Sorted and not deduplicated, so a second example for an operation that
    // already has one fails too: `OP_NAMES` holds each name once.
    const names = publishedOps(standard("ops/REGISTRY.md")).map(opOf).sort();
    expect(names).toEqual([...OP_NAMES]);
  });

  it("reads and rewrites every line the specification publishes, byte for byte", () => {
    // The same promise `journal.test.ts` makes about the fixture, made about
    // the document: an example with a field this build does not read, or a name
    // in `OP_NAMES` that `toRecord` has no case for, fails here. The latter is
    // otherwise invisible until a replay reports a real operation as a corrupt
    // line, which reads like data loss rather than like a missing case.
    const lines = publishedOps(standard("ops/REGISTRY.md"));
    expect(lines).toHaveLength(OP_NAMES.length);

    for (const line of lines) {
      expect(toLine(toRecord(JSON.parse(line)))).toBe(`${line}\n`);
    }
  });
});
