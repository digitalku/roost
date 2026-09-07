import { queryError } from "./error.js";

/**
 * Turning query text into tokens.
 *
 * Deliberately forgiving about what a bare word may contain: a filename
 * fragment is a perfectly good search, and rejecting `logo-v2.final` for its
 * punctuation would be worse than useless. Only whitespace, parentheses, and
 * quotes end a word.
 */

/**
 * Every token carries where it starts and where it ends.
 *
 * `at` is what a parse error points at. `end` is what lets a caller take a
 * **slice of the source** rather than reprinting an expression — which the AST
 * cannot do, because its values are already normalised (`facets.ts`).
 */
export type Token =
  | {
      readonly type: "open" | "close" | "or" | "and" | "not";
      readonly at: number;
      readonly end: number;
    }
  | {
      readonly type: "word";
      /** `field:value`, or a bare word or quoted phrase with no field. */
      readonly field: string | undefined;
      readonly value: string;
      /**
       * True when the value came from quotes. A quoted value is never
       * reinterpreted as a keyword, so `"or"` searches for the word.
       */
      readonly quoted: boolean;
      readonly at: number;
      readonly end: number;
    };

const isSpace = (character: string): boolean => /\s/.test(character);

/** Splits `input` into tokens. */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;

  while (at < input.length) {
    const character = input[at] ?? "";

    if (isSpace(character)) {
      at += 1;
      continue;
    }

    if (character === "(" || character === ")") {
      tokens.push({ type: character === "(" ? "open" : "close", at, end: at + 1 });
      at += 1;
      continue;
    }

    // A `-` only negates when it leads a term. Mid-word it is just a hyphen,
    // which filenames are full of — and mid-word is never seen here, because
    // `readWord` consumes to the end of the word in one step.
    if (character === "-" && at + 1 < input.length && !isSpace(input[at + 1] ?? "")) {
      tokens.push({ type: "not", at, end: at + 1 });
      at += 1;
      continue;
    }

    const [token, next] = readWord(input, at);
    tokens.push(token);
    at = next;
  }

  return tokens;
}

/** Reads one `field:value`, bare word, or quoted phrase starting at `start`. */
function readWord(input: string, start: number): [Token, number] {
  if (input[start] === '"') {
    const [value, next] = readQuoted(input, start);
    return [{ type: "word", field: undefined, value, quoted: true, at: start, end: next }, next];
  }

  let at = start;
  while (at < input.length) {
    const character = input[at] ?? "";
    if (isSpace(character) || character === "(" || character === ")") break;

    // The **first** colon splits field from value. Later colons belong to the
    // value, so a Windows path or a URL fragment survives being searched for.
    if (character === ":") {
      const field = input.slice(start, at).toLowerCase();
      at += 1;

      if (input[at] === '"') {
        const [value, next] = readQuoted(input, at);
        return [{ type: "word", field, value, quoted: true, at: start, end: next }, next];
      }

      const valueStart = at;
      while (at < input.length) {
        const next = input[at] ?? "";
        if (isSpace(next) || next === "(" || next === ")") break;
        at += 1;
      }
      return [
        {
          type: "word",
          field,
          value: input.slice(valueStart, at),
          quoted: false,
          at: start,
          end: at,
        },
        at,
      ];
    }
    at += 1;
  }

  const raw = input.slice(start, at);
  switch (raw.toLowerCase()) {
    case "or":
      return [{ type: "or", at: start, end: at }, at];
    case "and":
      return [{ type: "and", at: start, end: at }, at];
    case "not":
      return [{ type: "not", at: start, end: at }, at];
    default:
      return [
        { type: "word", field: undefined, value: raw, quoted: false, at: start, end: at },
        at,
      ];
  }
}

/** Reads a `"..."` literal, where `""` is an escaped quote. */
function readQuoted(input: string, start: number): [string, number] {
  let at = start + 1;
  let value = "";

  while (at < input.length) {
    if (input[at] === '"') {
      if (input[at + 1] === '"') {
        value += '"';
        at += 2;
        continue;
      }
      return [value, at + 1];
    }
    // Whole code points, so a surrogate pair is never split down the middle.
    const character = String.fromCodePoint(input.codePointAt(at) ?? 0);
    value += character;
    at += character.length;
  }

  throw queryError("unclosed-quote", "A quoted value was opened and never closed", start);
}
