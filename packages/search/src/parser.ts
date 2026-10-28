import type { Compare, Expr, Flag, Term } from "./ast.js";
import { queryError } from "./error.js";
import { type Token, tokenize } from "./lexer.js";
import { compare, type Unit } from "./value.js";

/**
 * Recursive descent over the token stream.
 *
 * Precedence, loosest first: `OR`, then `AND` (implicit between adjacent
 * terms), then negation, then a parenthesised group or a single term.
 */

/**
 * How deep parentheses may nest.
 *
 * Recursive descent uses the machine stack, so ten thousand open parentheses
 * would overflow it — and this parser is reachable from a search box and from a
 * saved smart folder, both of which are user input. Refusing is the only safe
 * answer, and 64 is far past any query a person writes.
 */
export const MAX_DEPTH = 64;

/** Parses query text into an expression tree. */
export function parse(input: string): Expr {
  const tokens = tokenize(input);
  if (tokens.length === 0) throw queryError("empty", "The query is empty");

  const parser = new Parser(tokens);
  const expr = parser.orExpr();

  const trailing = parser.peek();
  if (trailing !== undefined) {
    throw queryError("unmatched-paren", "A closing parenthesis has nothing to close", trailing.at);
  }
  return expr;
}

class Parser {
  readonly #tokens: readonly Token[];
  #pos = 0;
  #depth = 0;

  constructor(tokens: readonly Token[]) {
    this.#tokens = tokens;
  }

  peek(): Token | undefined {
    return this.#tokens[this.#pos];
  }

  #advance(): Token | undefined {
    const token = this.#tokens[this.#pos];
    if (token !== undefined) this.#pos += 1;
    return token;
  }

  orExpr(): Expr {
    const branches: Expr[] = [this.#andExpr()];
    for (;;) {
      const token = this.peek();
      if (token?.type !== "or") break;
      this.#advance();
      if (this.peek() === undefined) {
        throw queryError("expected-term", "OR needs something after it", token.at);
      }
      branches.push(this.#andExpr());
    }
    return branches.length === 1 ? (branches[0] as Expr) : { kind: "or", branches };
  }

  #andExpr(): Expr {
    const branches: Expr[] = [this.#unary()];

    for (;;) {
      const token = this.peek();
      if (token === undefined) break;

      // An explicit AND is optional; adjacency means the same thing.
      if (token.type === "and") {
        this.#advance();
        if (this.peek() === undefined) {
          throw queryError("expected-term", "AND needs something after it", token.at);
        }
        branches.push(this.#unary());
        continue;
      }
      if (token.type === "not" || token.type === "open" || token.type === "word") {
        branches.push(this.#unary());
        continue;
      }
      break;
    }

    return branches.length === 1 ? (branches[0] as Expr) : { kind: "and", branches };
  }

  #unary(): Expr {
    const token = this.peek();
    if (token?.type === "not") {
      this.#advance();
      if (this.peek() === undefined) {
        throw queryError("expected-term", "A negation needs something after it", token.at);
      }
      return { kind: "not", expr: this.#unary() };
    }
    return this.#primary();
  }

  #primary(): Expr {
    const token = this.#advance();
    if (token === undefined) throw queryError("empty", "The query ended early");

    switch (token.type) {
      case "open": {
        this.#depth += 1;
        if (this.#depth > MAX_DEPTH) {
          throw queryError("too-deep", `Parentheses nest deeper than ${MAX_DEPTH}`, token.at);
        }
        if (this.peek() === undefined) {
          throw queryError("expected-term", "An open parenthesis has nothing in it", token.at);
        }
        const inner = this.orExpr();
        if (this.#advance()?.type !== "close") {
          throw queryError(
            "unmatched-paren",
            "A parenthesis was opened and never closed",
            token.at,
          );
        }
        this.#depth -= 1;
        return inner;
      }
      case "close":
        throw queryError("unmatched-paren", "A closing parenthesis has nothing to close", token.at);
      case "word":
        return { kind: "term", term: toTerm(token.field, token.value, token.at, token.quoted) };
      default:
        // A keyword with no term before it.
        throw queryError("expected-term", "An operator needs a term before it", token.at);
    }
  }
}

/** Builds one term, resolving its field and normalising its value. */
function toTerm(field: string | undefined, value: string, at: number, quoted: boolean): Term {
  if (field === undefined) {
    // No field: free text, one phrase either way. Quotes are what keep its
    // last word whole rather than a prefix (ADR-0057 §7).
    return { field: "text", value, exact: quoted };
  }

  if (value === "") {
    throw queryError("missing-value", `${field}: needs a value`, at, { field });
  }

  const numeric = (unit: Unit): Compare => compare(value, unit, at, field);

  switch (field) {
    case "tag":
    case "folder":
    case "infolder":
    case "group":
      return { field, value };
    case "ext":
      return { field: "ext", value: value.replace(/^\.+/, "").toLowerCase() };
    case "size":
      return { field: "size", compare: numeric("bytes") };
    case "w":
    case "width":
      return { field: "width", compare: numeric("plain") };
    case "h":
    case "height":
      return { field: "height", compare: numeric("plain") };
    case "duration":
      return { field: "duration", compare: numeric("milliseconds") };
    case "created":
      return { field: "created", compare: numeric("date") };
    case "imported":
      return { field: "imported", compare: numeric("date") };
    case "rating": {
      const rating = numeric("plain");
      checkRating(rating, at);
      return { field: "rating", compare: rating };
    }
    case "is":
      return { field: "flag", flag: toFlag(value, at) };
    default:
      // An unknown field must not quietly become free text: the user asked a
      // question this build cannot answer, and an empty grid would not say so.
      throw queryError("unknown-field", `There is no "${field}" to search on`, at, { field });
  }
}

/**
 * Rejects a rating the schema could never hold.
 *
 * Returning nothing would be defensible, but a query that cannot match is
 * almost always a typo, and saying so beats an empty grid with no explanation.
 */
function checkRating(rating: Compare, at: number): void {
  const outOfRange = (value: number): boolean => value < 1 || value > 5;
  const bad =
    rating.op === "eq" && outOfRange(rating.value)
      ? rating.value
      : rating.op === "between" && (outOfRange(rating.low) || outOfRange(rating.high))
        ? rating.low
        : undefined;

  if (bad !== undefined) {
    throw queryError("rating-out-of-range", `Ratings run from 1 to 5, not ${bad}`, at, {
      value: String(bad),
    });
  }
}

function toFlag(value: string, at: number): Flag {
  switch (value.toLowerCase()) {
    // Both spellings, because English differs and a search box should not.
    case "favorite":
    case "favourite":
      return "favorite";
    case "tagged":
      return "tagged";
    case "untagged":
      return "untagged";
    case "rated":
      return "rated";
    case "unrated":
      return "unrated";
    case "trashed":
    case "trash":
      return "trashed";
    case "subtitle":
    case "subtitles":
      return "subtitle";
    case "captioned":
      return "captioned";
    default:
      throw queryError("unknown-flag", `There is no "is:${value}"`, at, { value });
  }
}
