import { describe, expect, it } from "vitest";
import { compileQuery, NO_FOLDERS, parse, QueryError } from "./index.js";

/**
 * The parser is the one place user input becomes SQL, so it is **property**
 * tested rather than only example tested (`DATA_MODEL.md` §3).
 *
 * Two properties, for every input whatsoever:
 *
 * 1. It either produces an AST or a `QueryError` that can be described and
 *    points inside the input. Never anything else, and never a crash.
 * 2. If it produces an AST, the compiled SQL holds one `?` per bound value and
 *    no character that could only have come from the user.
 *
 * The generator is a seeded xorshift rather than a property-testing library: it
 * costs no dependency, and a failure is reproducible from the seed printed in
 * the assertion instead of from a shrink log.
 */

/** Deterministic, so a failing case is a fixed seed and not a lucky run. */
class Rng {
  #state: number;

  constructor(seed: number) {
    // Never zero: xorshift is stuck there.
    this.#state = seed >>> 0 === 0 ? 0x9e3779b9 : seed >>> 0;
  }

  next(): number {
    let x = this.#state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.#state = x >>> 0;
    return this.#state;
  }

  below(bound: number): number {
    return bound === 0 ? 0 : this.next() % bound;
  }

  pick<T>(options: readonly T[]): T {
    return options[this.below(options.length)] as T;
  }
}

const QUOTE = String.fromCharCode(34);
const APOSTROPHE = String.fromCharCode(39);
const BACKSLASH = String.fromCharCode(92);

/** Fragments chosen to collide with the grammar rather than avoid it. */
const PIECES: readonly string[] = [
  "tag:",
  "folder:",
  "group:",
  "ext:",
  "size:",
  "w:",
  "h:",
  "duration:",
  "rating:",
  "created:",
  "imported:",
  "is:",
  "colour:",
  ":",
  "::",
  "a",
  "wood",
  "logo-v2",
  "brand assets",
  "0",
  "9",
  "-1",
  "1.5",
  "1e3",
  "0x10",
  ">",
  "<",
  ">=",
  "<=",
  "=",
  "..",
  "-",
  "--",
  QUOTE,
  QUOTE + QUOTE,
  "(",
  ")",
  "((",
  "))",
  "OR",
  "AND",
  "NOT",
  "or",
  "and",
  "not",
  "2024-03-01",
  "2024-13-45",
  "10mb",
  "30s",
  "500ms",
  "favorite",
  "partial-hash",
  "sparkly",
  APOSTROPHE,
  ";",
  APOSTROPHE + "); DROP TABLE assets; --",
  "%",
  "_",
  "*",
  BACKSLASH,
  " ",
  // Outside ASCII on purpose: a byte offset would point at the wrong character
  // from here on, which is why errors carry a string index instead.
  "é",
  "\u{1F332}",
  "\t",
  "\n",
];

function assertSurvives(input: string, seed: number): void {
  const where = `seed ${seed}: ${JSON.stringify(input)}`;
  let expr: ReturnType<typeof parse>;

  try {
    expr = parse(input);
  } catch (error) {
    // An error must be one of ours, must say something, and must point inside
    // the input rather than past its end.
    expect(error, where).toBeInstanceOf(QueryError);
    const query = error as QueryError;
    expect(query.message.length, where).toBeGreaterThan(0);
    if (query.at !== undefined) {
      expect(query.at, where).toBeGreaterThanOrEqual(0);
      expect(query.at, where).toBeLessThanOrEqual(input.length);
    }
    return;
  }

  const filter = compileQuery(expr, NO_FOLDERS);

  // Whatever the input was, every value is behind a placeholder.
  expect(filter.sql.split("?").length - 1, `${where} -> ${filter.sql}`).toBe(filter.params.length);

  // The compiled text is assembled from fixed fragments only. A quote or a
  // semicolon in it means something was interpolated.
  for (const forbidden of [APOSTROPHE, ";"]) {
    expect(filter.sql, where).not.toContain(forbidden);
  }
}

const VALID = [
  `tag:wood -tag:wip (ext:png OR ext:jpg) rating:>=4 size:>2mb ${QUOTE}beach${QUOTE}`,
  "folder:Design/Icons is:favourite created:2024-01-01..2024-12-31",
  `group:Materials duration:>30s w:>2000 h:<=1080 ${QUOTE}logo v2${QUOTE}`,
];

describe("any input at all", () => {
  it("survives token soup", () => {
    const rng = new Rng(20260825);
    for (let round = 0; round < 4000; round += 1) {
      let input = "";
      for (let piece = 1 + rng.below(12); piece > 0; piece -= 1) {
        input += rng.pick(PIECES);
        if (rng.below(3) === 0) input += " ";
      }
      assertSurvives(input, 20260825 + round);
    }
  });

  it("survives arbitrary characters", () => {
    const rng = new Rng(7);
    for (let round = 0; round < 2000; round += 1) {
      let input = "";
      for (let length = rng.below(40); length > 0; length -= 1) {
        // The printable range, so quotes and parentheses appear often enough to
        // unbalance each other.
        input += String.fromCharCode(32 + rng.below(95));
      }
      assertSurvives(input, 7 + round);
    }
  });

  it("survives a valid query with one character changed", () => {
    // The interesting failures are near-misses, not noise: a query that almost
    // parses is what a person actually types.
    const rng = new Rng(99);

    for (const query of VALID) {
      // The originals must parse, or the mutations prove nothing.
      expect(() => parse(query)).not.toThrow();

      for (let round = 0; round < 1500; round += 1) {
        const characters = [...query];
        const at = rng.below(characters.length);
        const action = rng.below(3);
        if (action === 0) characters.splice(at, 1);
        else if (action === 1) characters.splice(at, 0, String.fromCharCode(32 + rng.below(95)));
        else characters[at] = String.fromCharCode(32 + rng.below(95));
        assertSurvives(characters.join(""), 99 + round);
      }
    }
  });

  it("refuses nesting rather than overflowing the stack", () => {
    for (const depth of [100, 1000, 10_000, 100_000]) {
      expect(() => parse("(".repeat(depth))).toThrow(QueryError);
    }
  });
});
