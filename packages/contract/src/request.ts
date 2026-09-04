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
  readOneOf,
  readString,
  readStringArray,
  within,
} from "./checked.js";
import type {
  AssetPage,
  LibraryStats,
  LibrarySummary,
  QueryCheck,
  StorageMode,
  WireAssetDetail,
  WireCreated,
  WireCursor,
  WireDeriveStatus,
  WireExportReport,
  WireImportReport,
  WirePasted,
  WireRecentLibrary,
  WireSelectionSummary,
  WireSidebar,
} from "./dto.js";
import { STORAGE_MODES } from "./dto.js";

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
  /**
   * The libraries this machine has opened, pinned first and then newest.
   *
   * Application state rather than library state, for the plainest of the three
   * reasons ADR-0019 gives: this list is what *finds* a library, so it cannot
   * live inside one.
   */
  | { readonly type: "recent:list" }
  /** Drops one entry from the recent list, and answers with what is left. */
  | { readonly type: "recent:forget"; readonly root: string }
  /** Pins or unpins one entry. A pinned entry is never evicted by the limit. */
  | { readonly type: "recent:pin"; readonly root: string; readonly pinned: boolean }
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
   * What a selection of several assets shares, and what it does not.
   *
   * Asked instead of `asset:detail` once more than one asset is selected. The
   * inspector cannot fetch a detail each: a selection is routinely hundreds of
   * rows, and what it draws is a summary of them rather than each of them.
   */
  | { readonly type: "asset:summary"; readonly hashes: readonly string[] }
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
  /**
   * Pin a video's thumbnail to a moment, or let it go back to the default
   * (ADR-0024 stage 4).
   *
   * `atMs` is milliseconds into the video; `null` restores the default frame,
   * which is not the first one — the backend takes a frame a tenth of the way
   * in, because a first frame tends to be a slate. Clearing is this request
   * with the value absent rather than a request of its own.
   *
   * The engine refuses it for anything that is not a video, and pinning the
   * moment it is already pinned to writes nothing.
   */
  | { readonly type: "asset:poster"; readonly hash: string; readonly atMs: number | null }
  /**
   * Creates an asset from text the window holds, under a name the user chose
   * (ADR-0026 §4).
   *
   * **New File** is a draft until this: a name and a buffer with no row behind
   * them. Empty is refused, because every empty file has one hash and
   * `assets.hash` is the primary key — an empty `notes.txt` and an empty
   * `notes.md` cannot both exist, so a file becomes an asset at the moment it
   * has bytes that make it itself.
   *
   * Answers the hash and whether it is new; identical bytes are one asset, so a
   * file that already exists comes back with `created: false`.
   */
  | { readonly type: "asset:create"; readonly name: string; readonly text: string }
  /**
   * Reads the clipboard and does what its contents deserve (ADR-0026 §5).
   *
   * Answered in **main**: the clipboard is the desktop's, the renderer has no
   * ambient authority (invariant 11), and the engine has no shell. File paths
   * are imported, image bytes are imported under a synthesised name, text comes
   * back for a draft, and a URL is left alone — pasting never fetches.
   */
  | { readonly type: "clipboard:paste"; readonly mode: StorageMode }
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
   * Add a comment to one asset, at a moment or about the whole of it (ADR-0023).
   *
   * `atMs` is milliseconds into the medium; `null` is a comment about the
   * asset, which is what lets a `.zip` carry one. One hash rather than the
   * selection: a comment is a paragraph about one thing, for the reason
   * `UI_SPEC.md` §3.2 keeps the note off a multi-selection.
   *
   * The id is minted and journalled by the engine, so it is neither sent nor
   * answered with — the caller re-reads the asset, like every other edit.
   */
  | {
      readonly type: "comment:add";
      readonly hash: string;
      readonly atMs: number | null;
      readonly body: string;
    }
  /**
   * Edit a comment in place, keeping its identity and its place in the list.
   *
   * By id rather than by hash and index: an index would name a different
   * comment the moment another window added one, and the id is what the
   * journal already carries.
   */
  | {
      readonly type: "comment:set";
      readonly id: number;
      readonly atMs: number | null;
      readonly body: string;
    }
  | { readonly type: "comment:remove"; readonly id: number }
  /**
   * Hand an asset to the desktop's own handler.
   *
   * Answered by **main**: it needs `shell.openPath`, and the engine has no
   * desktop. `CONCEPT.md` §5 — a library holds anything, so a format Roost
   * cannot draw must not be a dead end.
   */
  | { readonly type: "asset:openExternally"; readonly hash: string }
  /**
   * Show one asset in the desktop's file manager, selected.
   *
   * Answered by **main**, for the reason `asset:openExternally` gives, and with
   * the same rule: the renderer asks by hash and learns only whether the
   * desktop did something. A path is what main acts on, never what the renderer
   * receives.
   */
  | { readonly type: "asset:reveal"; readonly hash: string }
  /**
   * Put the selection's paths on the clipboard, one per line.
   *
   * Answered by **main**, which owns the clipboard. This is deliberately the
   * one way a path leaves the engine to somewhere a person can read it: the
   * user asked for it, it goes to them rather than to the renderer, and the
   * renderer learns only whether anything was copied.
   */
  | { readonly type: "asset:copyPath"; readonly hashes: readonly string[] }
  /**
   * Move the selection to the trash, or bring it back out (ADR-0022).
   *
   * Reversible, and the only thing `Delete` does. Nothing on disk moves and no
   * metadata is lost — a trashed asset keeps its tags, rating, note, and folder
   * memberships, and simply stops matching every query but `is:trashed`.
   */
  | { readonly type: "assets:trash"; readonly hashes: readonly string[] }
  | { readonly type: "assets:restore"; readonly hashes: readonly string[] }
  /**
   * Remove the selection from the library, permanently.
   *
   * What "Delete permanently" sends. Not reversible: the row and everything
   * hanging off it are gone, and only the bytes survive for a deliberate
   * `roost doctor --reclaim`.
   */
  | { readonly type: "assets:remove"; readonly hashes: readonly string[] }
  /**
   * Remove everything the trash holds, and answer with how many.
   *
   * The count comes back because the renderer cannot compute it: emptying is
   * over what the *engine* sees in the trash, not over a selection, and the
   * status bar has to be able to say what happened.
   */
  | { readonly type: "assets:emptyTrash" }
  /**
   * Copy the selection's originals into a directory the user chose.
   *
   * The one place Roost writes into a user's directory, and it does so only
   * because the user picked the directory in a dialog and asked for it by name.
   * Nothing under `originals/` is moved, modified, or removed — an export is a
   * copy out (`STORAGE_SPEC.md` invariant 6 is about the reverse direction).
   */
  | {
      readonly type: "assets:export";
      readonly hashes: readonly string[];
      readonly destination: string;
    }
  /**
   * Import files and directories into the open library.
   *
   * Paths, not bytes: the renderer gets a path for a dropped file from the
   * preload and never reads one. Directories are walked by the engine, which
   * is the side with a filesystem.
   *
   * Originals are never moved, modified, or deleted (`STORAGE_SPEC.md`
   * invariant 8), and in `referenced` mode nothing is written into the user's
   * directories at all.
   */
  | {
      readonly type: "import:paths";
      readonly paths: readonly string[];
      readonly mode: StorageMode;
      /** Applied to everything imported in this run. */
      readonly tags: readonly string[];
    }
  /**
   * What the derive queue is holding, and what this machine can draw.
   *
   * Asked when the window opens a library and after a run finishes, so an
   * empty cell can say why it is empty rather than looking broken.
   */
  | { readonly type: "derive:status" }
  /**
   * Offer parked work again, now that a missing tool may exist.
   *
   * `reason` names which parked work to release — `missing:ffmpeg` after
   * installing it — or `null` for all of it. Releasing everything would also
   * retry formats this build genuinely cannot draw, which costs a full pass to
   * reach the same answer.
   */
  | { readonly type: "derive:retry"; readonly reason: string | null }
  /** Ask the user for files and folders to import. Answered by main. */
  | { readonly type: "dialog:chooseImport" }
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
  "recent:list": readonly WireRecentLibrary[];
  /** The new list, so one round trip answers "and now?". */
  "recent:forget": readonly WireRecentLibrary[];
  "recent:pin": readonly WireRecentLibrary[];
  "library:close": null;
  "library:stats": LibraryStats;
  "library:sidebar": WireSidebar;
  "assets:page": AssetPage;
  "assets:count": number;
  "query:check": QueryCheck;
  "asset:detail": WireAssetDetail | null;
  "asset:summary": WireSelectionSummary;
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
  "asset:poster": null;
  "asset:rename": null;
  "asset:create": WireCreated;
  "clipboard:paste": WirePasted;
  "asset:tagAdd": null;
  "asset:tagRemove": null;
  "comment:add": null;
  "comment:set": null;
  "comment:remove": null;
  /** `false` when the desktop had no handler for it. */
  "asset:openExternally": boolean;
  /** `false` when the bytes are not on this machine. */
  "asset:reveal": boolean;
  /** `false` when nothing could be located, so nothing was put on the clipboard. */
  "asset:copyPath": boolean;
  "assets:trash": null;
  "assets:restore": null;
  "assets:remove": null;
  /** How many assets emptying removed. */
  "assets:emptyTrash": number;
  "assets:export": WireExportReport;
  "import:paths": WireImportReport;
  "derive:status": WireDeriveStatus;
  /** The status after the retry, so one round trip answers "and now?". */
  "derive:retry": WireDeriveStatus;
  /** `null` when the user cancelled; an empty array is not a thing a dialog returns. */
  "dialog:chooseImport": readonly string[] | null;
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

  "recent:list": () => ok({ type: "recent:list" }),

  "recent:forget": (source) => {
    const root = readNonEmpty(source, "root");
    if (!root.ok) return root;
    return ok({ type: "recent:forget", root: root.value });
  },

  "recent:pin": (source) => {
    const root = readNonEmpty(source, "root");
    if (!root.ok) return root;
    const pinned = readBoolean(source, "pinned");
    if (!pinned.ok) return pinned;
    return ok({ type: "recent:pin", root: root.value, pinned: pinned.value });
  },
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

  "asset:summary": (source) => {
    const hashes = readHashArray(source, "hashes");
    if (!hashes.ok) return hashes;
    return ok({ type: "asset:summary", hashes: hashes.value });
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

  "asset:poster": (source) => {
    const hash = readHash(source, "hash");
    if (!hash.ok) return hash;
    const atMs = readMoment(source);
    if (!atMs.ok) return atMs;
    return ok({ type: "asset:poster", hash: hash.value, atMs: atMs.value });
  },

  "asset:create": (source) => {
    const name = readNonEmpty(source, "name");
    if (!name.ok) return name;
    // `readString`: an empty draft is refused by the engine with a sentence
    // about *why*, which is better than a validator saying "expected a
    // non-empty string" about a file somebody meant to make.
    const text = readString(source, "text");
    if (!text.ok) return text;
    return ok({ type: "asset:create", name: name.value, text: text.value });
  },

  "clipboard:paste": (source) => {
    const mode = readOneOf(source, "mode", STORAGE_MODES);
    return mode.ok ? ok({ type: "clipboard:paste", mode: mode.value }) : mode;
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

  "comment:add": (source) => {
    const hash = readHash(source, "hash");
    if (!hash.ok) return hash;
    const atMs = readMoment(source);
    if (!atMs.ok) return atMs;
    const body = readNonEmpty(source, "body");
    if (!body.ok) return body;
    return ok({ type: "comment:add", hash: hash.value, atMs: atMs.value, body: body.value });
  },

  "comment:set": (source) => {
    const id = readInteger(source, "id");
    if (!id.ok) return id;
    const atMs = readMoment(source);
    if (!atMs.ok) return atMs;
    const body = readNonEmpty(source, "body");
    if (!body.ok) return body;
    return ok({ type: "comment:set", id: id.value, atMs: atMs.value, body: body.value });
  },

  "comment:remove": (source) => {
    const id = readInteger(source, "id");
    return id.ok ? ok({ type: "comment:remove", id: id.value }) : id;
  },

  "asset:openExternally": (source) => {
    const hash = readHash(source, "hash");
    return hash.ok ? ok({ type: "asset:openExternally", hash: hash.value }) : hash;
  },

  "asset:reveal": (source) => {
    const hash = readHash(source, "hash");
    return hash.ok ? ok({ type: "asset:reveal", hash: hash.value }) : hash;
  },

  "asset:copyPath": (source) => {
    const hashes = readHashArray(source, "hashes");
    return hashes.ok ? ok({ type: "asset:copyPath", hashes: hashes.value }) : hashes;
  },

  "assets:trash": (source) => {
    const hashes = readHashArray(source, "hashes");
    return hashes.ok ? ok({ type: "assets:trash", hashes: hashes.value }) : hashes;
  },

  "assets:restore": (source) => {
    const hashes = readHashArray(source, "hashes");
    return hashes.ok ? ok({ type: "assets:restore", hashes: hashes.value }) : hashes;
  },

  "assets:remove": (source) => {
    const hashes = readHashArray(source, "hashes");
    return hashes.ok ? ok({ type: "assets:remove", hashes: hashes.value }) : hashes;
  },

  "assets:emptyTrash": () => ok({ type: "assets:emptyTrash" }),

  "assets:export": (source) => {
    const hashes = readHashArray(source, "hashes");
    if (!hashes.ok) return hashes;
    const destination = readNonEmpty(source, "destination");
    if (!destination.ok) return destination;
    return ok({ type: "assets:export", hashes: hashes.value, destination: destination.value });
  },

  "import:paths": (source) => {
    const paths = readStringArray(source, "paths");
    if (!paths.ok) return paths;
    if (paths.value.length === 0) return bad("paths: expected at least one");
    if (paths.value.some((path) => path.trim() === "")) {
      return bad("paths: expected non-empty strings");
    }
    const mode = readOneOf(source, "mode", STORAGE_MODES);
    if (!mode.ok) return mode;
    const tags = readStringArray(source, "tags");
    if (!tags.ok) return tags;
    return ok({ type: "import:paths", paths: paths.value, mode: mode.value, tags: tags.value });
  },

  "derive:status": () => ok({ type: "derive:status" }),

  "derive:retry": (source) => {
    // `null` releases everything parked; a string releases only what is parked
    // on that reason.
    const reason = readNullable(source, "reason", readNonEmpty);
    if (!reason.ok) return reason;
    return ok({ type: "derive:retry", reason: reason.value });
  },

  "dialog:chooseImport": () => ok({ type: "dialog:chooseImport" }),

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

/**
 * A moment into a medium: milliseconds, or `null` for a comment about the asset.
 *
 * Refused here rather than left to the engine, unlike a rating's range: a
 * negative offset is not a value out of bounds but a number that cannot mean
 * anything, and the same check runs again where the journal is written
 * (`op.ts`) because that is the side that has to survive a replay.
 */
function readMoment(source: Record<string, unknown>): Checked<number | null> {
  const at = readNullable(source, "atMs", readInteger);
  if (!at.ok) return at;
  if (at.value !== null && at.value < 0) return bad("atMs: expected zero or more milliseconds");
  return at;
}

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
