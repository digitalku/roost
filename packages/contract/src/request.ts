import {
  bad,
  type Checked,
  isRecord,
  ok,
  readBoolean,
  readHash,
  readHashArray,
  readInteger,
  readNonEmpty,
  readNullable,
  readString,
  readStringArray,
  within,
} from "./checked.js";
import type {
  AssetPage,
  LibraryStats,
  LibrarySummary,
  QueryCheck,
  WireAssetDetail,
  WireCursor,
  WireSidebar,
} from "./dto.js";

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
  /** The navigation pane: places, folders, smart folders, tags. */
  | { readonly type: "library:sidebar" }
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
   * How many assets a query matches.
   *
   * Separate from a page because it is separate work: a page is one screen and
   * a count is every row. The status bar asks for it once per query, not once
   * per scroll.
   */
  | { readonly type: "assets:count"; readonly query: string }
  /**
   * Whether a query parses, and where it stopped.
   *
   * The renderer cannot answer this itself: the grammar lives in
   * `@roost/search`, and the renderer's only import is the contract. A half
   * typed query is checked here rather than being sent to the grid and
   * bouncing (`UI_SPEC.md` §5).
   */
  | { readonly type: "query:check"; readonly query: string }
  /**
   * Everything the inspector shows about one asset.
   *
   * `null` rather than a failure when the hash is not in the library: a
   * selection can outlive the asset it points at — another window removed it,
   * or a rebuild dropped a row — and an empty inspector is the right answer to
   * that, not an error dialog.
   */
  | { readonly type: "asset:detail"; readonly hash: string }
  /**
   * Set or clear a rating on every selected asset.
   *
   * `null` clears. Not zero: unrated and rated-zero are different states in the
   * schema, and a wire that could not say so would lose the difference
   * (`DATA_MODEL.md`).
   */
  | {
      readonly type: "asset:rate";
      readonly hashes: readonly string[];
      readonly rating: number | null;
    }
  | {
      readonly type: "asset:favorite";
      readonly hashes: readonly string[];
      readonly favorite: boolean;
    }
  /** `null` clears the note, and so does an all-whitespace one. */
  | { readonly type: "asset:note"; readonly hash: string; readonly note: string | null }
  /** Renames what the library shows. Nothing under `originals/` is touched. */
  | { readonly type: "asset:rename"; readonly hash: string; readonly name: string }
  | {
      readonly type: "asset:tagAdd";
      readonly hashes: readonly string[];
      readonly tags: readonly string[];
    }
  | {
      readonly type: "asset:tagRemove";
      readonly hashes: readonly string[];
      readonly tags: readonly string[];
    }
  /**
   * Hand an asset to the desktop's own handler.
   *
   * Answered by **main**: it needs `shell.openPath`, and the engine has no
   * desktop. `CONCEPT.md` §5 — a library holds anything, so a format Roost
   * cannot draw must not be a dead end.
   */
  | { readonly type: "asset:openExternally"; readonly hash: string }
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
  "library:sidebar": WireSidebar;
  "assets:page": AssetPage;
  "assets:count": number;
  "query:check": QueryCheck;
  "asset:detail": WireAssetDetail | null;
  /**
   * Every edit answers with `null` and the inspector re-reads.
   *
   * `UI_SPEC.md` asks each edit to read the record back rather than trust what
   * it sent, and an edit that returned its own idea of the new state would be
   * exactly the trust it is avoiding — the engine normalises names, drops an
   * all-whitespace note, and deduplicates tags.
   */
  "asset:rate": null;
  "asset:favorite": null;
  "asset:note": null;
  "asset:rename": null;
  "asset:tagAdd": null;
  "asset:tagRemove": null;
  /** `false` when the desktop had no handler for it. */
  "asset:openExternally": boolean;
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
  "library:sidebar": () => ok({ type: "library:sidebar" }),

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
  "assets:count": (source) => {
    const query = readString(source, "query");
    return query.ok ? ok({ type: "assets:count", query: query.value }) : query;
  },

  "query:check": (source) => {
    const query = readString(source, "query");
    return query.ok ? ok({ type: "query:check", query: query.value }) : query;
  },

  "asset:detail": (source) => {
    const hash = readHash(source, "hash");
    return hash.ok ? ok({ type: "asset:detail", hash: hash.value }) : hash;
  },

  "asset:rate": (source) => {
    const hashes = readHashArray(source, "hashes");
    if (!hashes.ok) return hashes;
    const rating = readNullable(source, "rating", readInteger);
    if (!rating.ok) return rating;
    // The range is checked by the engine, which owns `MAX_RATING`. What is
    // checked here is that it is an integer or an explicit null — the shape,
    // not the rule.
    return ok({ type: "asset:rate", hashes: hashes.value, rating: rating.value });
  },

  "asset:favorite": (source) => {
    const hashes = readHashArray(source, "hashes");
    if (!hashes.ok) return hashes;
    const favorite = readBoolean(source, "favorite");
    if (!favorite.ok) return favorite;
    return ok({ type: "asset:favorite", hashes: hashes.value, favorite: favorite.value });
  },

  "asset:note": (source) => {
    const hash = readHash(source, "hash");
    if (!hash.ok) return hash;
    const note = readNullable(source, "note", readString);
    if (!note.ok) return note;
    return ok({ type: "asset:note", hash: hash.value, note: note.value });
  },

  "asset:rename": (source) => {
    const hash = readHash(source, "hash");
    if (!hash.ok) return hash;
    const name = readNonEmpty(source, "name");
    if (!name.ok) return name;
    return ok({ type: "asset:rename", hash: hash.value, name: name.value });
  },

  "asset:tagAdd": (source) => {
    const hashes = readHashArray(source, "hashes");
    if (!hashes.ok) return hashes;
    const tags = readStringArray(source, "tags");
    if (!tags.ok) return tags;
    return ok({ type: "asset:tagAdd", hashes: hashes.value, tags: tags.value });
  },

  "asset:tagRemove": (source) => {
    const hashes = readHashArray(source, "hashes");
    if (!hashes.ok) return hashes;
    const tags = readStringArray(source, "tags");
    if (!tags.ok) return tags;
    return ok({ type: "asset:tagRemove", hashes: hashes.value, tags: tags.value });
  },

  "asset:openExternally": (source) => {
    const hash = readHash(source, "hash");
    return hash.ok ? ok({ type: "asset:openExternally", hash: hash.value }) : hash;
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
