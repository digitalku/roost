/**
 * Every error Roost raises carries a stable machine-readable code. Codes are
 * added here, never invented at a throw site: they appear in logs, in bug
 * reports, and in the renderer's error states (`UI_SPEC.md` §8), so they are
 * part of the interface rather than a debugging aid.
 */
export const ERROR_CODES = [
  "invalid_content_hash",
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
