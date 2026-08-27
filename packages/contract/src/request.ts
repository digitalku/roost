import {
  bad,
  type Checked,
  isRecord,
  ok,
  readHash,
  readInteger,
  readNonEmpty,
  readString,
  within,
} from "./checked.js";
import type { AssetPage, LibraryStats, LibrarySummary, WireCursor } from "./dto.js";

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
   * One page of the grid.
   *
   * `query` is RQL, or empty for the whole library — the engine decides what
   * empty means, because two frontends deciding separately is how they come to
   * disagree. `after` is a cursor a previous page handed back, or `null` to
   * start at the newest asset.
   */
  | {
      readonly type: "assets:page";
      readonly query: string;
      readonly limit: number;
      readonly after: WireCursor | null;
    }
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
  "assets:page": AssetPage;
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

  "assets:page": (source) => {
    // An empty query is legal and means the whole library, so this is
    // `readString` rather than `readNonEmpty`.
    const query = readString(source, "query");
    if (!query.ok) return query;

    const limit = readInteger(source, "limit");
    if (!limit.ok) return limit;
    // A limit is bounded at both ends here rather than clamped, because a
    // renderer asking for a million rows is a bug and answering it politely
    // would hide the bug behind a slow window.
    if (limit.value < 1 || limit.value > MAX_PAGE_LIMIT) {
      return bad(`limit: expected 1 to ${MAX_PAGE_LIMIT}`);
    }

    const after = readCursor(source["after"]);
    if (!after.ok) return within("after", after);

    return ok({ type: "assets:page", query: query.value, limit: limit.value, after: after.value });
  },
  "dialog:openLibrary": () => ok({ type: "dialog:openLibrary" }),
  "dialog:chooseLocation": () => ok({ type: "dialog:chooseLocation" }),
};

/**
 * The most rows one request may ask for.
 *
 * Not a performance guess: `DEFAULT_PAGE_LIMIT` is 100, a screen of grid with
 * room to scroll into, and this is two orders above it. Anything larger is a
 * caller that meant to page and did not.
 */
export const MAX_PAGE_LIMIT = 10_000;

/** A cursor as it arrives: `null`, or the two fields a previous page handed out. */
function readCursor(value: unknown): Checked<WireCursor | null> {
  if (value === null) return ok(null);
  if (!isRecord(value)) return bad("expected null or an object");
  const importedAt = readInteger(value, "importedAt");
  if (!importedAt.ok) return importedAt;
  const hash = readHash(value, "hash");
  if (!hash.ok) return hash;
  return ok({ importedAt: importedAt.value, hash: hash.value });
}

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
