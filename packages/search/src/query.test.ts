import { MATCH_LIVE } from "@roost/core";
import { describe, expect, it } from "vitest";
import {
  buildQuery,
  compileQuery,
  type Expr,
  NO_FOLDERS,
  parse,
  QueryError,
  quoteValue,
  type Term,
} from "./index.js";

/**
 * The grammar, and the promise that no user input reaches SQL as text.
 *
 * Carried over from `../roost-old/crates/search/tests/parse_and_compile.rs`
 * before a line of this parser was written, so the grammar is **reproduced**
 * rather than reinvented. A smart folder stores its query text; a query this
 * build cannot parse the same way is a folder the user loses.
 */

function term(input: string): Term {
  const expr = parse(input);
  if (expr.kind !== "term") throw new Error(`${input} parsed to ${expr.kind}, expected one term`);
  return expr.term;
}

function kindOf(input: string): string {
  try {
    parse(input);
  } catch (error) {
    if (error instanceof QueryError) return error.kind;
    throw error;
  }
  throw new Error(`${input} parsed, but should not have`);
}

describe("structure", () => {
  it("ands adjacent terms, and OR binds looser", () => {
    // `a b OR c` is `(a AND b) OR c`, the reading every search box uses.
    const expr = parse("tag:a tag:b OR tag:c");
    expect(expr.kind).toBe("or");
    if (expr.kind !== "or") return;
    expect(expr.branches).toHaveLength(2);
    expect(expr.branches[0]?.kind).toBe("and");
    expect(expr.branches[1]).toEqual({ kind: "term", term: { field: "tag", value: "c" } });
  });

  it("lets parentheses override precedence", () => {
    const expr = parse("tag:a (tag:b OR tag:c)");
    expect(expr.kind).toBe("and");
    if (expr.kind !== "and") return;
    expect(expr.branches[1]?.kind).toBe("or");
  });

  it("negates on a leading dash, but not on one inside a word", () => {
    expect(parse("-tag:wip").kind).toBe("not");
    // Filenames are full of hyphens, and `logo-v2` is one search term.
    expect(term("logo-v2")).toEqual({ field: "text", value: "logo-v2" });
  });

  it("treats an explicit AND and adjacency as the same thing", () => {
    expect(parse("tag:a AND tag:b")).toEqual(parse("tag:a tag:b"));
  });
});

describe("values", () => {
  it("keeps quoted spaces and never reads a quoted word as a keyword", () => {
    expect(term('tag:"brand assets"')).toEqual({ field: "tag", value: "brand assets" });
    // Bare `or` is an operator; quoted, it is what the user is looking for.
    expect(term('"or"')).toEqual({ field: "text", value: "or" });
    expect(term('"say ""hi"""')).toEqual({ field: "text", value: 'say "hi"' });
  });

  it("keeps a colon inside a value, so a path or a URL survives", () => {
    // Only the first colon splits field from value.
    expect(term("tag:a:b")).toEqual({ field: "tag", value: "a:b" });
  });

  it("resolves comparators and units to numbers", () => {
    expect(term("size:>10mb")).toEqual({
      field: "size",
      compare: { op: "gt", value: 10 * 1024 * 1024 },
    });
    expect(term("size:1.5kb")).toEqual({ field: "size", compare: { op: "eq", value: 1536 } });
    expect(term("w:>2000")).toEqual({ field: "width", compare: { op: "gt", value: 2000 } });
    expect(term("h:<=1080")).toEqual({ field: "height", compare: { op: "le", value: 1080 } });
    expect(term("rating:>=4")).toEqual({ field: "rating", compare: { op: "ge", value: 4 } });
  });

  it("reads a bare duration as seconds", () => {
    // Because `duration:>30` means half a minute, not thirty milliseconds.
    expect(term("duration:>30")).toEqual({
      field: "duration",
      compare: { op: "gt", value: 30_000 },
    });
    expect(term("duration:>30s")).toEqual({
      field: "duration",
      compare: { op: "gt", value: 30_000 },
    });
    expect(term("duration:500ms")).toEqual({
      field: "duration",
      compare: { op: "eq", value: 500 },
    });
    expect(term("duration:>2m")).toEqual({
      field: "duration",
      compare: { op: "gt", value: 120_000 },
    });
  });

  it("covers the whole day for a bare date", () => {
    // Midnight-exactly would match nothing, which is never what was meant.
    const created = term("created:2024-03-01");
    expect(created.field).toBe("created");
    if (created.field !== "created" || created.compare.op !== "between") throw new Error("range");
    expect(created.compare.high - created.compare.low).toBe(86_399);

    const imported = term("imported:2024-01-01..2024-12-31");
    if (imported.field !== "imported" || imported.compare.op !== "between")
      throw new Error("range");
    // 2024 is a leap year.
    expect(imported.compare.high - imported.compare.low).toBe(366 * 86_400 - 1);
  });

  it("reads a date comparison against the end of that day where it should", () => {
    // `<= a day` includes all of it; `> a day` starts after it.
    const le = term("created:<=2024-03-01");
    const gt = term("created:>2024-03-01");
    if (le.field !== "created" || gt.field !== "created") throw new Error("field");
    if (le.compare.op !== "le" || gt.compare.op !== "gt") throw new Error("op");
    expect(le.compare.value).toBe(gt.compare.value);
    expect(le.compare.value % 86_400).toBe(86_399);
  });

  it("normalises extensions the way the index stores them", () => {
    expect(term("ext:PNG")).toEqual({ field: "ext", value: "png" });
    expect(term("ext:.png")).toEqual({ field: "ext", value: "png" });
  });

  it("accepts both spellings where English differs", () => {
    expect(term("is:favorite")).toEqual({ field: "flag", flag: "favorite" });
    expect(term("is:favourite")).toEqual({ field: "flag", flag: "favorite" });
    expect(term("is:partial-hash")).toEqual({ field: "flag", flag: "partial-hash" });
  });

  it("refuses a number a query language should not accept", () => {
    // `Number` reads all of these; a search box should not.
    expect(kindOf("w:0x10")).toBe("not-a-number");
    expect(kindOf("w:1e3")).toBe("not-a-number");
    // `w: ` is not a bad number, it is no number: whitespace ends the word, so
    // the value is empty and the message should say that rather than quibble
    // about digits.
    expect(kindOf("w: ")).toBe("missing-value");
    expect(kindOf("size:Infinity")).toBe("not-a-size");
  });

  it("refuses a date that does not exist", () => {
    // `Date.UTC` rolls 31 February forward to 2 March rather than refusing it.
    expect(kindOf("created:2024-02-31")).toBe("not-a-date");
    expect(kindOf("created:2024-3-1")).toBe("not-a-date");
    expect(kindOf("created:yesterday")).toBe("not-a-date");
  });
});

describe("mistakes are reported with a position rather than ignored", () => {
  it("names each kind of failure", () => {
    // An unknown field must not silently become free text: the user asked a
    // question this build cannot answer, and an empty grid would not say so.
    expect(kindOf("colour:red")).toBe("unknown-field");
    expect(kindOf("is:sparkly")).toBe("unknown-flag");
    expect(kindOf("rating:9")).toBe("rating-out-of-range");
    expect(kindOf("tag:")).toBe("missing-value");
    expect(kindOf('"open')).toBe("unclosed-quote");
    expect(kindOf("(tag:a")).toBe("unmatched-paren");
    expect(kindOf("tag:a)")).toBe("unmatched-paren");
    expect(kindOf("tag:a OR")).toBe("expected-term");
    expect(kindOf("   ")).toBe("empty");
    expect(kindOf("size:1..")).toBe("incomplete-range");
  });

  it("points at the character that caused it", () => {
    try {
      parse("tag:a colour:red");
      throw new Error("should not parse");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryError);
      expect((error as QueryError).at).toBe(6);
    }
  });

  it("bounds nesting, so a pathological query cannot overflow the stack", () => {
    const deep = `${"(".repeat(5_000)}tag:a${")".repeat(5_000)}`;
    expect(kindOf(deep)).toBe("too-deep");
  });
});

describe("compiling", () => {
  it("binds every value the user typed and writes none of them into SQL", () => {
    const hostile = `tag:"x'); DROP TABLE assets; --" ext:"a' OR '1'='1" "quote"" here"`;
    const filter = buildQuery(hostile);

    // The compiled text may contain only SQL this package chose. If any
    // fragment of the input appears in it, a value was interpolated.
    for (const fragment of ["DROP", "--", "'1'='1", "x')"]) {
      expect(filter.sql).not.toContain(fragment);
    }
    expect(filter.sql.split("?").length - 1).toBe(filter.params.length);
    expect(filter.params.length).toBeGreaterThanOrEqual(3);
  });

  it("answers a folder nobody created with an empty match, not an error", () => {
    const filter = buildQuery("folder:Nowhere");
    expect(filter.sql).toBe("(0) AND a.trashed_at IS NULL AND a.superseded_by IS NULL");
    expect(filter.params).toEqual([]);
  });

  it("expands a folder subtree into bound ids", () => {
    const filter = buildQuery("folder:Design", { subtree: () => [3, 4, 5] });
    expect(filter.sql).toContain("af.folder_id IN (?, ?, ?)");
    expect(filter.params).toEqual([3, 4, 5]);
  });

  it("searches free text as one phrase", () => {
    // FTS5's MATCH argument is a query language of its own, so raw text would
    // let AND, NEAR, or `*` change the search into something else.
    const filter = buildQuery("beach OR sunset");
    expect(filter.params).toEqual(['"beach"', '"sunset"']);
  });

  it("makes negation total", () => {
    // `-tag:wip` is NOT over the whole library, so it includes assets with no
    // tags at all.
    expect(buildQuery("-tag:wip").sql.startsWith("(NOT (")).toBe(true);
  });

  it("compiles a flag without binding anything it did not have to", () => {
    expect(compileQuery(parse("is:favorite"), NO_FOLDERS)).toEqual({
      sql: "(a.is_favorite = 1) AND a.trashed_at IS NULL AND a.superseded_by IS NULL",
      params: [],
    });
    // Except the two that name a column value, which stay bound like any other.
    expect(buildQuery("is:managed").params).toEqual(["managed"]);
  });

  it("scopes every query to live, current assets", () => {
    // Trash is a state, not a place (ADR-0022), so a trashed asset is still a
    // row `tag:wip` would otherwise match. The scoping is what makes deleting
    // something mean it stops turning up — and superseding is the same argument
    // about editing (ADR-0026): every intermediate save would otherwise be in
    // every result.
    for (const query of ["tag:wip", "is:favorite", "rating:>=4", "beach", "-tag:wip"]) {
      expect(
        buildQuery(query).sql.endsWith(" AND a.trashed_at IS NULL AND a.superseded_by IS NULL"),
      ).toBe(true);
    }
  });

  it("spells the scope exactly as the partial indexes require", () => {
    // Migrations 0007 and 0010 made every grid index partial on this predicate,
    // and SQLite uses a partial index only when the query's WHERE contains a
    // term implying the index's. So the wording and the order are part of the
    // schema, and `MATCH_LIVE` is the copy the listings use — the two must not
    // drift, or a grid stops seeking and starts scanning with nothing failing.
    expect(buildQuery("tag:wip").sql.endsWith(` AND ${MATCH_LIVE.sql}`)).toBe(true);
  });

  it("lets a scope flag out of its own rule and no other", () => {
    // `is:trashed` opts out of the trash half. The superseded half stays: a
    // superseded row in the trash is still a version rather than something
    // somebody deleted.
    expect(buildQuery("is:trashed").sql).toBe(
      "(a.trashed_at IS NOT NULL) AND a.superseded_by IS NULL",
    );
    expect(buildQuery("is:superseded").sql).toBe(
      "(a.superseded_by IS NOT NULL) AND a.trashed_at IS NULL",
    );
    // Both named, and the query is scoped by neither.
    expect(buildQuery("is:trashed AND is:superseded").sql).not.toContain("IS NULL");
    // Nested, so that the check is over the whole tree rather than the root.
    expect(buildQuery("is:trashed AND tag:wip").sql).not.toContain("a.trashed_at IS NULL");
    // Negated, where the default scoping would have produced the same predicate
    // anyway — opting out must not be able to widen a query.
    expect(buildQuery("-is:trashed").sql).toBe(
      "(NOT (a.trashed_at IS NOT NULL)) AND a.superseded_by IS NULL",
    );
  });
});

describe("quoting a value back into a query", () => {
  it("round-trips every shape of name", () => {
    // Whatever `quoteValue` produces has to parse back to the value it was
    // given — the only property that matters, asserted rather than assumed.
    for (const value of [
      "wood",
      "two words",
      'quote"inside',
      "colon:inside",
      "(parens)",
      "trailing ",
      "-leading-dash",
    ]) {
      const parsed = parse(`tag:${quoteValue(value)}`);
      expect(parsed).toEqual({ kind: "term", term: { field: "tag", value } } satisfies Expr);
    }
  });
});
