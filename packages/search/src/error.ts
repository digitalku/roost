import { RoostError } from "@roost/core";

/**
 * Why a query could not be parsed.
 *
 * One error class with a `kind`, rather than fifteen codes in
 * `@roost/core`'s registry: the code answers "what kind of failure is this" for
 * a log or an IPC boundary, and the kind answers "what exactly was wrong" for
 * the person who typed it. Both survive `toWire()`.
 */
export const QUERY_ERROR_KINDS = [
  "empty",
  "expected-term",
  "incomplete-range",
  "missing-value",
  "not-a-date",
  "not-a-duration",
  "not-a-number",
  "not-a-size",
  "rating-out-of-range",
  "too-deep",
  "unclosed-quote",
  "unknown-field",
  "unknown-flag",
  "unmatched-paren",
] as const;

export type QueryErrorKind = (typeof QUERY_ERROR_KINDS)[number];

export interface QueryErrorDetail {
  readonly kind: QueryErrorKind;
  /**
   * Where in the query text, as a **JavaScript string index**.
   *
   * The Rust implementation reports a byte offset. This one cannot: the caret
   * that highlights the mistake lives in a text input measured in UTF-16 code
   * units, and a byte offset would point at the wrong character the moment a
   * query contains anything outside ASCII. `undefined` where the failure has no
   * position — an empty query has nowhere to point.
   */
  readonly at?: number;
  readonly field?: string;
  readonly value?: string;
}

export class QueryError extends RoostError {
  readonly code = "invalid_query";

  readonly kind: QueryErrorKind;
  readonly at: number | undefined;

  constructor(message: string, detail: QueryErrorDetail) {
    super(message, {
      kind: detail.kind,
      at: detail.at ?? null,
      ...(detail.field === undefined ? {} : { field: detail.field }),
      ...(detail.value === undefined ? {} : { value: detail.value }),
    });
    this.kind = detail.kind;
    this.at = detail.at;
  }
}

export function queryError(
  kind: QueryErrorKind,
  message: string,
  at?: number,
  extra: { field?: string; value?: string } = {},
): QueryError {
  return new QueryError(message, { kind, ...(at === undefined ? {} : { at }), ...extra });
}
