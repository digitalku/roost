import type { Compare } from "./ast.js";
import { queryError } from "./error.js";

/**
 * Parsing the value half of a term: comparators, sizes, durations, dates.
 */

/** How a value should be turned into a number. */
export type Unit = "plain" | "bytes" | "milliseconds" | "date";

const SECONDS_PER_DAY = 86_400;

/**
 * Parses `>=4`, `10mb`, `2024-01-01..2024-12-31`, and the rest.
 *
 * A bare value means equality — except for a date. `created:2024-03-01` means
 * "some time that day", not "at midnight exactly", which is the only reading
 * that ever returns anything.
 */
export function compare(raw: string, unit: Unit, at: number, field: string): Compare {
  if (raw === "") throw queryError("missing-value", `${field}: needs a value`, at, { field });

  const [op, rest] = splitOperator(raw);

  const range = splitRange(rest);
  if (range !== undefined) {
    const [low, high] = range;
    if (low === "" || high === "") {
      throw queryError("incomplete-range", `${field}: a range needs both ends`, at, { field });
    }
    // A date range covers whole days at both ends, so `..2024-12-31` includes
    // everything up to that day's last second.
    return {
      op: "between",
      low: number(low, unit, at, field),
      high: spanEnd(high, unit, at, field),
    };
  }

  const value = number(rest, unit, at, field);
  const isDate = unit === "date";

  switch (op) {
    case "eq":
      return isDate
        ? { op: "between", low: value, high: spanEnd(rest, unit, at, field) }
        : { op: "eq", value };
    case "lt":
      return { op: "lt", value };
    case "ge":
      return { op: "ge", value };
    // `<= a date` and `> a date` are about the *end* of that day: everything up
    // to and including it, and everything strictly after it.
    case "le":
      return { op: "le", value: isDate ? spanEnd(rest, unit, at, field) : value };
    case "gt":
      return { op: "gt", value: isDate ? spanEnd(rest, unit, at, field) : value };
  }
}

type Op = "eq" | "lt" | "le" | "gt" | "ge";

function splitOperator(raw: string): [Op, string] {
  if (raw.startsWith(">=")) return ["ge", raw.slice(2)];
  if (raw.startsWith("<=")) return ["le", raw.slice(2)];
  if (raw.startsWith(">")) return ["gt", raw.slice(1)];
  if (raw.startsWith("<")) return ["lt", raw.slice(1)];
  if (raw.startsWith("=")) return ["eq", raw.slice(1)];
  return ["eq", raw];
}

/** Splits on the **first** `..`, so a date's own hyphens are untouched. */
function splitRange(raw: string): [string, string] | undefined {
  const found = raw.indexOf("..");
  return found === -1 ? undefined : [raw.slice(0, found), raw.slice(found + 2)];
}

function number(raw: string, unit: Unit, at: number, field: string): number {
  switch (unit) {
    case "plain": {
      // `Number` reads `""`, `" "`, `0x10`, and `1e3` as numbers; a query
      // language should not. Digits with an optional sign, and nothing else.
      if (!/^-?\d+$/.test(raw.trim())) {
        throw queryError("not-a-number", `${field}: ${raw} is not a whole number`, at, {
          field,
          value: raw,
        });
      }
      return Number(raw.trim());
    }
    case "bytes":
      return bytes(raw, at, field);
    case "milliseconds":
      return milliseconds(raw, at, field);
    case "date":
      return dateStart(raw, at, field);
  }
}

/** The last unix second a value covers. Only dates span more than an instant. */
function spanEnd(raw: string, unit: Unit, at: number, field: string): number {
  return unit === "date"
    ? dateStart(raw, at, field) + SECONDS_PER_DAY - 1
    : number(raw, unit, at, field);
}

/** `10`, `10b`, `10kb`, `10mb`, `10gb`. Binary multiples: `mb` is 1024². */
function bytes(raw: string, at: number, field: string): number {
  const [digits, multiplier] = splitSuffix(raw.toLowerCase(), [
    ["gib", 1024 ** 3],
    ["gb", 1024 ** 3],
    ["mib", 1024 ** 2],
    ["mb", 1024 ** 2],
    ["kib", 1024],
    ["kb", 1024],
    ["b", 1],
  ]);

  const value = decimal(digits);
  if (value === undefined || value < 0) {
    throw queryError("not-a-size", `${field}: ${raw} is not a size`, at, { field, value: raw });
  }
  // Sizes are commonly written as `1.5mb`, so the value is read as a decimal
  // and rounded once, here, rather than left to surprise the comparison.
  return Math.round(value * multiplier);
}

/**
 * `30s`, `500ms`, `2m`, `1h`. A bare number is **seconds**, because that is
 * what people mean by `duration:>30`.
 */
function milliseconds(raw: string, at: number, field: string): number {
  const lower = raw.toLowerCase();
  const [digits, suffixMultiplier] = splitSuffix(lower, [
    ["ms", 1],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1_000],
  ]);
  const multiplier = digits.length === lower.length ? 1_000 : suffixMultiplier;

  const value = decimal(digits);
  if (value === undefined || value < 0) {
    throw queryError("not-a-duration", `${field}: ${raw} is not a duration`, at, {
      field,
      value: raw,
    });
  }
  return Math.round(value * multiplier);
}

/** A plain decimal, with no exponent, hex, or infinity. */
function decimal(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

function splitSuffix(value: string, suffixes: readonly [string, number][]): [string, number] {
  for (const [suffix, multiplier] of suffixes) {
    if (value.endsWith(suffix)) return [value.slice(0, -suffix.length), multiplier];
  }
  return [value, 1];
}

/**
 * `YYYY-MM-DD` at UTC midnight.
 *
 * UTC, not local time, because the stored timestamps are UTC: reading the query
 * in local time would shift every boundary by the offset and quietly return the
 * wrong day.
 */
function dateStart(raw: string, at: number, field: string): number {
  const bad = (): never => {
    throw queryError("not-a-date", `${field}: ${raw} is not a date (YYYY-MM-DD)`, at, {
      field,
      value: raw,
    });
  };

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) return bad();

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const stamp = Date.UTC(year, month - 1, day);

  // `Date.UTC` rolls an impossible date forward rather than refusing it, so
  // `2024-02-31` would silently become the 2nd of March. Reading the parts back
  // is what catches that.
  const back = new Date(stamp);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return bad();
  }

  return Math.floor(stamp / 1000);
}
