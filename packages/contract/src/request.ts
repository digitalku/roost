import { bad, type Checked, isRecord, ok, readNonEmpty, readString, within } from "./checked.js";
import type { LibraryStats, LibrarySummary } from "./dto.js";

/**
 * Every request the renderer can make, and what each one answers with.
 *
 * Adding a command means adding a member here, its response, its validator, and
 * its handler — **in one change**, because the mapped type below does not
 * compile without all four (ADR-0007). Members arrive with the feature that
 * needs them; a contract written ahead of its handlers is a contract that
 * describes something nobody built.
 */
export type Request =
  /** Open an existing library. Refused if the directory holds no `library.json`. */
  | { readonly type: "library:open"; readonly path: string }
  /** Create a library and open it. Refused if one is already there. */
  | { readonly type: "library:create"; readonly path: string; readonly name: string }
  /** The library this engine currently holds, if any. */
  | { readonly type: "library:current" }
  /** Release the library, its journal, and its lock. */
  | { readonly type: "library:close" }
  /** The counts behind the library view. */
  | { readonly type: "library:stats" };

export type RequestType = Request["type"];

/** The member of {@link Request} named by `T`. */
export type RequestOf<T extends RequestType> = Extract<Request, { type: T }>;

/**
 * The response to each request.
 *
 * `null` where there is nothing to say: an explicit null round-trips through
 * `structuredClone` and through a validator, and `undefined` does not survive
 * every path it would have to take.
 */
export interface Responses {
  "library:open": LibrarySummary;
  "library:create": LibrarySummary;
  "library:current": LibrarySummary | null;
  "library:close": null;
  "library:stats": LibraryStats;
}

export type ResponseOf<T extends RequestType> = Responses[T];

/** A validator per member. A member without one does not compile. */
export const REQUEST_VALIDATORS: {
  readonly [T in RequestType]: (source: Record<string, unknown>) => Checked<RequestOf<T>>;
} = {
  "library:open": (source) => {
    const path = readNonEmpty(source, "path");
    if (!path.ok) return path;
    return ok({ type: "library:open", path: path.value });
  },

  "library:create": (source) => {
    const path = readNonEmpty(source, "path");
    if (!path.ok) return path;
    // A name may be blank on the wire; the engine falls back to the directory's
    // own name, which is what the CLI does and what a user expects.
    const name = readString(source, "name");
    if (!name.ok) return name;
    return ok({ type: "library:create", path: path.value, name: name.value });
  },

  "library:current": () => ok({ type: "library:current" }),
  "library:close": () => ok({ type: "library:close" }),
  "library:stats": () => ok({ type: "library:stats" }),
};

export const REQUEST_TYPES = Object.keys(REQUEST_VALIDATORS) as RequestType[];

export function isRequestType(value: string): value is RequestType {
  return Object.hasOwn(REQUEST_VALIDATORS, value);
}

/**
 * Validates one request from an untrusted value.
 *
 * The `type` is read first so an unknown one is reported as itself rather than
 * as a missing field of whatever member happened to be tried.
 */
export function checkRequest(value: unknown): Checked<Request> {
  if (!isRecord(value)) return bad("expected an object");
  const type = value["type"];
  if (typeof type !== "string") return bad("type: expected a string");
  if (!isRequestType(type)) return bad(`type: unknown request "${type}"`);
  // Every validator returns its own member, and every member is a `Request`.
  return within(type, REQUEST_VALIDATORS[type](value) as Checked<Request>);
}
