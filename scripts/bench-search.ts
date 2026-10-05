/**
 * Measures what a query costs on a library big enough for the answer to mean
 * something.
 *
 *   node --experimental-strip-types scripts/bench-search.ts <LIBRARY> [--runs N]
 *
 * The budget is `CONCEPT.md` §7: **p95 under 100 ms** on a large library. The
 * Rust implementation recorded 6–30 ms on 95k assets, and that is what a
 * regression here is measured against.
 *
 * Compiling is timed separately from running. They fail differently — a slow
 * compile is the parser, a slow run is the query plan — and a single number
 * would hide whichever one moved.
 */
import { parseArgs } from "node:util";
import {
  DEFAULT_PAGE_LIMIT,
  lastCursor,
  MATCH_ALL,
  MATCH_LIVE,
  SORT_KEYS,
  type Sort,
} from "@roost/core";
import { compileFor, Library } from "@roost/library";

/** Queries chosen to reach a different part of the schema each. */
const QUERIES = [
  "ext:png",
  "tag:corpus",
  'tag:"oak wood"',
  "rating:>=4",
  "is:favorite",
  "is:untagged",
  "size:>1mb",
  "ext:png OR ext:jpg OR ext:mp4",
  "tag:corpus -ext:png rating:>=1",
  "folder:Design",
  // Two free-text queries, deliberately: one that nearly every asset matches
  // and one that almost none does. `roost fixture` names every file
  // `asset-NNNNNNN.ext`, so the first is the worst case for FTS and the second
  // is what someone typing into a search box actually gets.
  "asset",
  "asset-0000083",
] as const;

const { values, positionals } = parseArgs({
  options: { runs: { type: "string" } },
  allowPositionals: true,
  strict: true,
});

const root = positionals[0];
if (root === undefined) {
  console.error("usage: bench-search.ts <LIBRARY> [--runs N]");
  process.exit(2);
}
const runs = Number(values.runs ?? 30);

const library = await Library.open(root);
try {
  const assets = library.stats().assets;
  console.log(`${assets} assets in ${library.root}`);
  console.log(`${runs} runs per query, one page of ${DEFAULT_PAGE_LIMIT}\n`);
  console.log("  compile p95   run p95    run p50   hits   query");

  for (const query of QUERIES) {
    const compiles: number[] = [];
    const searches: number[] = [];
    let hits = 0;

    for (let run = 0; run < runs; run += 1) {
      const compileStart = performance.now();
      const filter = compileFor(library, query);
      compiles.push(performance.now() - compileStart);

      const searchStart = performance.now();
      hits = library.db.repo.search(filter, { limit: DEFAULT_PAGE_LIMIT }).length;
      searches.push(performance.now() - searchStart);
    }

    console.log(
      `${ms(percentile(compiles, 95))}  ${ms(percentile(searches, 95))}  ${ms(
        percentile(searches, 50),
      )}  ${String(hits).padStart(5)}   ${query}`,
    );
  }
  pagingCost(library);
  sortCost(library, runs);
} finally {
  await library.close();
}

/**
 * What page 200 costs against what page 1 costs.
 *
 * The claim keyset paging makes is that it costs the same either way, and the
 * Rust implementation measured 23x on page 200 of a 50,000-asset library when
 * the cursor timestamp was written as two parameters instead of one. That is a
 * number worth being able to see move.
 */
function pagingCost(library: Library): void {
  const pages = 200;
  const costs: number[] = [];
  let after = undefined as ReturnType<typeof lastCursor>;

  for (let page = 0; page < pages; page += 1) {
    const started = performance.now();
    const hits = library.db.repo.search(MATCH_ALL, {
      limit: DEFAULT_PAGE_LIMIT,
      ...(after && { after }),
    });
    costs.push(performance.now() - started);
    after = lastCursor(hits);
    if (after === undefined) break;
  }

  const first = costs.slice(0, 10);
  const last = costs.slice(-10);
  console.log(`\nPaging ${costs.length} pages of ${DEFAULT_PAGE_LIMIT}, keyset, never OFFSET`);
  console.log(`  first 10 pages p95 ${ms(percentile(first, 95))}`);
  console.log(`  last 10 pages  p95 ${ms(percentile(last, 95))}`);
}

/**
 * What each order costs, at the first page and deep into the listing.
 *
 * The two halves are separate claims. The **first page** is the one migration
 * 0014's indexes exist for: without them SQLite reads the match set into a
 * sorter to produce one screen. **Page 200** is the resume, which is written as
 * two seeks rather than one predicate because a key with few distinct values —
 * a rating has six — makes the single-predicate form walk the whole run of
 * equal keys (ADR-0039 §4).
 *
 * `random` is measured with the rest and is expected to be the slow one: it is
 * a seeded shuffle of the id with no index and cannot have one, and the
 * number here is what that costs. Its resume is cheap until a page crosses
 * from one character's run into the next (ADR-0039 §11), so page 200 here is
 * mostly the cheap seek, and the first page is the price.
 *
 * Measured through `MATCH_LIVE` rather than `MATCH_ALL`, unlike the paging cost
 * above it: every index the schema has is **partial**, scoped to live rows
 * (migrations 0007 and 0010), so a query without that scope cannot use one and
 * would measure a plan no window ever asks for.
 */
function sortCost(library: Library, runs: number): void {
  console.log(`\nOrders, one page of ${DEFAULT_PAGE_LIMIT} (ADR-0039)`);
  console.log("      first p95   page 200 p95   key");

  for (const key of SORT_KEYS) {
    const sort: Sort = { key, descending: true, seed: 7 };
    const first: number[] = [];
    for (let run = 0; run < runs; run += 1) {
      const started = performance.now();
      library.db.repo.search(MATCH_LIVE, { limit: DEFAULT_PAGE_LIMIT, sort });
      first.push(performance.now() - started);
    }

    // Walked rather than jumped, because a cursor is the only way to reach page
    // 200 — which is the whole point of the shape being measured.
    let after = undefined as ReturnType<typeof lastCursor>;
    const deep: number[] = [];
    for (let page = 0; page < 200; page += 1) {
      const started = performance.now();
      const hits = library.db.repo.search(MATCH_LIVE, {
        limit: DEFAULT_PAGE_LIMIT,
        sort,
        ...(after && { after }),
      });
      deep.push(performance.now() - started);
      after = lastCursor(hits);
      if (after === undefined) break;
    }

    console.log(`${ms(percentile(first, 95))}  ${ms(percentile(deep.slice(-10), 95))}   ${key}`);
  }
}

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank, which is what a small sample can honestly support: with 30
  // runs there is no meaningful interpolation between the 28th and the 29th.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1) - 1, sorted.length - 1)] ?? 0;
}

function ms(value: number): string {
  return `${value.toFixed(2)} ms`.padStart(11);
}
