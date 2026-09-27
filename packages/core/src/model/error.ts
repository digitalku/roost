/**
 * Every error Roost raises carries a stable machine-readable code. Codes are
 * added here, never invented at a throw site: they appear in logs, in bug
 * reports, and in the renderer's error states (`UI_SPEC.md` §8), so they are
 * part of the interface rather than a debugging aid.
 */
export const ERROR_CODES = [
  "already_a_library",
  "ambiguous_folder_name",
  "ambiguous_id",
  "dangling_reference",
  "duplicate_folder_name",
  "edit_too_large",
  "empty_comment",
  "empty_name",
  "folder_cycle",
  "invalid_asset_id",
  "invalid_content_hash",
  "invalid_library_name",
  "invalid_moment",
  "invalid_query",
  "invalid_rating",
  "invalid_timestamp",
  "io",
  "library_busy",
  "library_not_found",
  "library_too_new",
  "malformed_record",
  "migration_failed",
  "not_a_library",
  "not_an_eagle_library",
  "not_a_video",
  "not_editable",
  "same_library",
  "schema_too_new",
  "transfer_running",
  "unknown_asset",
  "unknown_comment",
  "unknown_folder",
  "unknown_folder_path",
  "unknown_smart_folder",
  "unknown_tag_group",
  "unreadable_schema_version",
  "unsound_reclaim",
  "unsupported_platform",
  "remote", // an error that crossed a process boundary; see fromWire()
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}

/** What an error's `detail` may carry. It has to survive JSON, so: no nesting. */
export type ErrorDetail = Readonly<Record<string, string | number | boolean | null>>;

/**
 * The form an error takes when it crosses a process boundary.
 *
 * This exists because `structuredClone` does **not** preserve an Error
 * subclass. The algorithm clones `name`, `message`, `stack`, and `cause`, and
 * discards the prototype along with every own property the subclass added — so
 * a `RoostError` arriving at the far end of a `MessagePort` would still be an
 * error, and would have lost the `code` that made it actionable. There is a
 * test asserting exactly that, so the reason for this type stays visible.
 */
export interface WireError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly detail: ErrorDetail;
}

export abstract class RoostError extends Error {
  abstract readonly code: ErrorCode;

  readonly detail: ErrorDetail;

  constructor(message: string, detail: ErrorDetail = {}) {
    super(message);
    // `new.target` rather than a hard-coded string: a subclass that forgets to
    // set its own name is the common case, and the class name is what a log
    // reader recognises.
    this.name = new.target.name;
    this.detail = detail;
  }

  toWire(): WireError {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

/**
 * Something that is not an id was handed to something that needed one.
 *
 * The value can be arbitrary input of arbitrary length, so only a bounded
 * prefix reaches the detail — enough to recognise, not enough to fill a log.
 */
export class InvalidAssetIdError extends RoostError {
  readonly code = "invalid_asset_id";

  constructor(value: string) {
    super("Not an asset id: expected 12 characters of Crockford base32, upper case", {
      length: value.length,
      prefix: value.slice(0, 16),
    });
  }
}

export class InvalidContentHashError extends RoostError {
  readonly code = "invalid_content_hash";

  constructor(value: string) {
    super("Not a content hash: expected 64 lowercase hex characters", {
      length: value.length,
      // The value itself can be arbitrary user input of arbitrary length, so
      // only a bounded prefix goes in the detail. Enough to recognise, not
      // enough to fill a log line.
      prefix: value.slice(0, 16),
    });
  }
}

/**
 * A filesystem operation failed. The path is in the detail rather than only in
 * the message, because a caller deciding whether to retry needs it structured,
 * and because the message is what a user sees.
 *
 * `syscall` and `errno` are Node's, carried through verbatim: `ENOENT` and
 * `EACCES` mean different things to a caller and both would otherwise be
 * flattened into prose.
 */
export class IoError extends RoostError {
  readonly code = "io";

  constructor(operation: string, path: string, cause: unknown) {
    const errno = cause instanceof Error && "code" in cause ? String(cause.code) : "unknown";
    super(`${operation} failed on ${path}: ${errno}`, { operation, path, errno });
  }
}

/**
 * A timestamp that cannot be a point in time. Journal records are keyed into
 * monthly files by their own `ts`, so one that does not convert is a record
 * with nowhere to go.
 */
export class InvalidTimestampError extends RoostError {
  readonly code = "invalid_timestamp";

  constructor(ts: number) {
    super(`Not a usable unix timestamp: ${ts}`, { ts });
  }
}

export class UnsupportedPlatformError extends RoostError {
  readonly code = "unsupported_platform";

  constructor(operation: string) {
    super(`${operation} is not implemented on ${process.platform}`, {
      operation,
      platform: process.platform,
    });
  }
}

/**
 * A migration failed partway. The transaction it ran in is already rolled back,
 * so the database is still at the previous version — which is why the version
 * is worth reporting: it says where a fix has to start.
 */
export class MigrationFailedError extends RoostError {
  readonly code = "migration_failed";

  constructor(version: number, name: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Migration ${version} (${name}) failed: ${reason}`, { version, name, reason });
  }
}

/**
 * The library was written by a build that knows a later schema.
 *
 * Refused rather than opened read-only or migrated backwards: this build cannot
 * know what a table it has never seen means, and guessing risks writing a
 * journal the newer build then misreads. There are no down-migrations.
 */
export class SchemaTooNewError extends RoostError {
  readonly code = "schema_too_new";

  constructor(found: number, supported: number) {
    super(`Library is at schema v${found}; this build understands up to v${supported}`, {
      found,
      supported,
    });
  }
}

/**
 * A `meta` table with no usable `schema_version`.
 *
 * Reported rather than treated as version 0: a zero would re-run migration 1
 * over tables that already exist, and the failure would name a `CREATE TABLE`
 * instead of the real problem.
 */
export class UnreadableSchemaVersionError extends RoostError {
  readonly code = "unreadable_schema_version";

  constructor(value: string) {
    super(`meta.schema_version is not a version number: ${value}`, { value });
  }
}

/**
 * An error that was raised in another process. It is not the original class —
 * that cannot be recovered — but it keeps the code, the message, and the
 * detail, which is everything a caller can act on.
 */
export class RemoteError extends RoostError {
  readonly code: ErrorCode;

  constructor(wire: WireError) {
    super(wire.message, wire.detail);
    this.code = wire.code;
  }
}

export function isWireError(value: unknown): value is WireError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.code === "string" &&
    isErrorCode(candidate.code) &&
    typeof candidate.message === "string" &&
    typeof candidate.detail === "object" &&
    candidate.detail !== null
  );
}

/** Rebuild a usable error from what came across the boundary. */
export function fromWire(wire: WireError): RoostError {
  return new RemoteError(wire);
}

/**
 * Reduce anything thrown to something that can be sent, logged, or shown.
 * Handlers catch `unknown`; this is what turns that back into a `code`.
 */
export function toWire(thrown: unknown): WireError {
  if (thrown instanceof RoostError) return thrown.toWire();
  if (isWireError(thrown)) return thrown;
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return { code: "remote", message, detail: {} };
}
