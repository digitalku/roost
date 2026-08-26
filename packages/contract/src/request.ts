import { bad, type Checked, isRecord, ok, readNonEmpty, within } from "./checked.js";
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
  /**
   * Create a library called `name` inside `parent`, and open it.
   *
   * The two are sent apart rather than joined, because joining them is path
   * work and the renderer has no `node:path` — nor any business doing it. The
   * engine composes `<parent>/<name>.roost` and validates the name on the way
   * (ADR-0014).
   */
  | { readonly type: "library:create"; readonly parent: string; readonly name: string }
  /** The library this engine currently holds, if any. */
  | { readonly type: "library:current" }
  /** Release the library, its journal, and its lock. */
  | { readonly type: "library:close" }
  /** The counts behind the library view. */
  | { readonly type: "library:stats" }
  /**
   * Ask the user for an existing library directory.
   *
   * Answered by **main**, not the engine: a dialog belongs to a window, and the
   * engine has none. It is a request like any other so that the renderer has
   * exactly one way to ask for anything.
   */
  | { readonly type: "dialog:openLibrary" }
  /** Ask the user where a new library should go. Answered by main. */
  | { readonly type: "dialog:chooseLocation" };

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
  /** `null` when the user cancelled, which is an outcome rather than a failure. */
  "dialog:openLibrary": string | null;
  "dialog:chooseLocation": string | null;
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
    const parent = readNonEmpty(source, "parent");
    if (!parent.ok) return parent;
    // Non-empty is all this end knows: a library has to be called something.
    // What a filesystem will actually accept is the engine's question, and it
    // asks it before turning the name into a path.
    const name = readNonEmpty(source, "name");
    if (!name.ok) return name;
    return ok({ type: "library:create", parent: parent.value, name: name.value });
  },

  "library:current": () => ok({ type: "library:current" }),
  "library:close": () => ok({ type: "library:close" }),
  "library:stats": () => ok({ type: "library:stats" }),
  "dialog:openLibrary": () => ok({ type: "dialog:openLibrary" }),
  "dialog:chooseLocation": () => ok({ type: "dialog:chooseLocation" }),
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
