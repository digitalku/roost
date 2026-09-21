/**
 * Reading untrusted values, without a schema library and without `any`.
 *
 * Every message crossing a process boundary arrives here as `unknown` and
 * leaves as a type or as a reason it is not one. **The validator, not the type,
 * is the contract** (ADR-0007): types are erased at run time, and a sandbox is
 * only worth having if the process behind it distrusts what comes through.
 *
 * A failure carries a reason rather than a bare `false`, because the receiving
 * end logs it and "invalid payload" is not a thing anyone can act on.
 */

export type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export function ok<T>(value: T): Checked<T> {
  return { ok: true, value };
}

export function bad<T>(reason: string): Checked<T> {
  return { ok: false, reason };
}

/** Fails with the field name in front of the reason, so a nested one reads as a path. */
export function within<T>(field: string, checked: Checked<T>): Checked<T> {
  return checked.ok ? checked : bad(`${field}: ${checked.reason}`);
}

/**
 * A plain object.
 *
 * Arrays are refused: `Array.isArray` is the only reliable way to tell them
 * apart from records here, and a message that arrived as an array is not one
 * this build wrote.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(source: Record<string, unknown>, field: string): Checked<string> {
  const value = source[field];
  return typeof value === "string" ? ok(value) : bad(`${field}: expected a string`);
}

/**
 * A string with something in it.
 *
 * Separate from {@link readString} because most of the strings on this boundary
 * are paths and names, where an empty one is a mistake rather than a value.
 */
export function readNonEmpty(source: Record<string, unknown>, field: string): Checked<string> {
  const value = source[field];
  if (typeof value !== "string") return bad(`${field}: expected a string`);
  return value.trim() === "" ? bad(`${field}: expected a non-empty string`) : ok(value);
}

export function readInteger(source: Record<string, unknown>, field: string): Checked<number> {
  const value = source[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    // A float, a NaN, or an integer past 2^53 all land here. The last matters:
    // it is where a JSON number stops round-tripping.
    return bad(`${field}: expected a safe integer`);
  }
  return ok(value);
}

export function readBoolean(source: Record<string, unknown>, field: string): Checked<boolean> {
  const value = source[field];
  return typeof value === "boolean" ? ok(value) : bad(`${field}: expected a boolean`);
}

export function readStringArray(source: Record<string, unknown>, field: string): Checked<string[]> {
  const value = source[field];
  if (!Array.isArray(value)) return bad(`${field}: expected an array`);
  if (value.some((item) => typeof item !== "string")) {
    return bad(`${field}: expected an array of strings`);
  }
  return ok(value as string[]);
}

/** `null` passes through; anything else must satisfy `read`. */
export function readNullable<T>(
  source: Record<string, unknown>,
  field: string,
  read: (source: Record<string, unknown>, field: string) => Checked<T>,
): Checked<T | null> {
  return source[field] === null ? ok(null) : read(source, field);
}

/**
 * A member of a fixed vocabulary.
 *
 * The allowed values are listed in the failure, because the caller that got
 * this wrong is a program and the person reading the log is looking for the
 * spelling.
 */
export function readOneOf<const T extends readonly string[]>(
  source: Record<string, unknown>,
  field: string,
  allowed: T,
): Checked<T[number]> {
  const value = source[field];
  if (typeof value !== "string" || !allowed.includes(value)) {
    return bad(`${field}: expected one of ${allowed.join(", ")}`);
  }
  return ok(value);
}

/**
 * An asset id: twelve characters of Crockford base32, upper case (RL-14).
 *
 * **The validator is the contract** (ADR-0007), and this is the shape it
 * enforces now — version 1's sixty-four hex characters are not an id, and are
 * rejected here rather than reaching a query that would answer nothing. The
 * alphabet leaves out `I`, `L`, `O` and `U`, so this is a character class
 * rather than `[0-9A-Z]`.
 */
export function readAssetId(source: Record<string, unknown>, field: string): Checked<string> {
  const value = source[field];
  if (typeof value !== "string" || !ASSET_ID.test(value)) {
    return bad(`${field}: expected an asset id`);
  }
  return ok(value);
}

export function readAssetIdArray(
  source: Record<string, unknown>,
  field: string,
): Checked<string[]> {
  const value = source[field];
  if (!Array.isArray(value)) return bad(`${field}: expected an array`);
  for (const item of value) {
    if (typeof item !== "string" || !ASSET_ID.test(item)) {
      return bad(`${field}: expected an array of asset ids`);
    }
  }
  return ok(value as string[]);
}

const ASSET_ID = /^[0-9A-HJKMNP-TV-Z]{12}$/;
