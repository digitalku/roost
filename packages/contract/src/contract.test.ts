import { describe, expect, it } from "vitest";
import { readHash, readHashArray, readOneOf } from "./checked.js";
import { STORAGE_MODES } from "./dto.js";
import { checkEventEnvelope, checkReplyEnvelope, checkRequestEnvelope } from "./envelope.js";
import { checkEvent } from "./event.js";
import { checkRequest, MAX_PAGE_LIMIT, REQUEST_TYPES } from "./request.js";

describe("validating a request", () => {
  it("accepts what the renderer is meant to send", () => {
    expect(checkRequest({ type: "library:create", parent: "/home/you", name: "Holiday" })).toEqual({
      ok: true,
      value: { type: "library:create", parent: "/home/you", name: "Holiday" },
    });
    expect(checkRequest({ type: "library:open", path: "/libraries/one" })).toEqual({
      ok: true,
      value: { type: "library:open", path: "/libraries/one" },
    });
    expect(checkRequest({ type: "library:stats" })).toEqual({
      ok: true,
      value: { type: "library:stats" },
    });
  });

  it("names the field and the request in the reason", () => {
    // The receiving end logs this and drops the message. "Invalid payload" is
    // not something anyone can act on; a path is.
    const missing = checkRequest({ type: "library:open" });
    expect(missing).toEqual({ ok: false, reason: "library:open: path: expected a string" });

    const blank = checkRequest({ type: "library:open", path: "   " });
    expect(blank).toEqual({
      ok: false,
      reason: "library:open: path: expected a non-empty string",
    });
  });

  it("refuses a request type it does not know, as itself", () => {
    // Reported as an unknown type rather than as a missing field of whichever
    // member happened to be tried first.
    expect(checkRequest({ type: "library:drop" })).toEqual({
      ok: false,
      reason: 'type: unknown request "library:drop"',
    });
    expect(checkRequest({ type: 7 })).toEqual({ ok: false, reason: "type: expected a string" });
  });

  it("refuses anything that is not an object, arrays included", () => {
    // An array reaching here is not a message this build wrote, and `typeof []`
    // is "object", so it has to be excluded deliberately.
    for (const value of [null, undefined, 4, "library:stats", [], [{ type: "library:stats" }]]) {
      expect(checkRequest(value).ok).toBe(false);
    }
  });

  it("ignores fields it was not asked about", () => {
    // Forward compatibility in one direction only: a newer renderer may send a
    // field this engine has no use for, and dropping the message over it would
    // make every addition a breaking change.
    expect(checkRequest({ type: "library:stats", verbose: true })).toEqual({
      ok: true,
      value: { type: "library:stats" },
    });

    // And the value handed on is built here, field by field, rather than being
    // the caller's object with a type assertion over it — so a field the engine
    // does not read cannot ride along to something that does.
    const smuggled = checkRequest({ type: "library:open", path: "/x", exclusive: true });
    expect(smuggled).toEqual({ ok: true, value: { type: "library:open", path: "/x" } });
  });

  it("has a validator for every request type", () => {
    // The mapped type is what actually enforces this — a member without a
    // validator does not compile. This asserts the list the engine dispatches
    // on is the same list, which a hand-maintained array would not be.
    expect(REQUEST_TYPES).toEqual([
      "library:open",
      "library:create",
      "library:current",
      "recent:list",
      "recent:forget",
      "recent:pin",
      "library:close",
      "app:quit",
      "app:about",
      "library:stats",
      "library:sidebar",
      "assets:page",
      "assets:count",
      "query:check",
      "query:split",
      "query:join",
      "query:subfolders",
      "settings:read",
      "settings:write",
      "asset:detail",
      "asset:summary",
      "asset:rate",
      "asset:note",
      "asset:source",
      "link:open",
      "asset:poster",
      "asset:create",
      "clipboard:paste",
      "asset:addSubtitle",
      "asset:subtitleDelete",
      "asset:rename",
      "asset:tagAdd",
      "asset:tagRemove",
      "asset:folderAdd",
      "asset:folderRemove",
      "folder:create",
      "folder:rename",
      "folder:move",
      "folder:delete",
      "comment:add",
      "comment:set",
      "comment:remove",
      "asset:openExternally",
      "asset:reveal",
      "asset:copyPath",
      "asset:copyFiles",
      "assets:trash",
      "assets:restore",
      "assets:remove",
      "assets:emptyTrash",
      "library:reclaimable",
      "library:reclaim",
      "assets:export",
      "import:paths",
      "import:fileDuplicates",
      "eagle:survey",
      "eagle:import",
      "derive:status",
      "derive:retry",
      "capability:install",
      "derive:failures",
      "clipboard:copyText",
      "dialog:chooseImport",
      "dialog:chooseSubtitle",
      "dialog:chooseEagle",
      "dialog:openLibrary",
      "dialog:chooseLocation",
    ]);
  });
});

describe("validating a page of the grid", () => {
  const page = (over: Record<string, unknown>): ReturnType<typeof checkRequest> =>
    checkRequest({ type: "assets:page", query: "", limit: 100, after: null, sort: null, ...over });

  it("accepts an empty query, which means the whole library", () => {
    expect(page({})).toEqual({
      ok: true,
      value: { type: "assets:page", query: "", limit: 100, after: null, sort: null },
    });
  });

  it("takes a cursor back only in the shape it handed one out", () => {
    const cursor = { key: 1_700_000_000, hash: "a".repeat(64) };
    expect(page({ after: cursor })).toEqual({
      ok: true,
      value: { type: "assets:page", query: "", limit: 100, after: cursor, sort: null },
    });

    // A key is a number or a string and nothing else, because that is what a
    // sort key can be (ADR-0039 §4) — the *meaning* is the engine's, and a
    // contract with an opinion about it would be a second one.
    expect(page({ after: { key: "asset-01.png", hash: "a".repeat(64) } }).ok).toBe(true);

    // Every field of it, checked. A cursor is used in a keyset predicate, and
    // the renderer is the process this build assumes may be compromised.
    expect(page({ after: { key: 1, hash: "not-a-hash" } })).toEqual({
      ok: false,
      reason: "assets:page: after: hash: expected 64 lowercase hex characters",
    });
    expect(page({ after: { hash: "a".repeat(64) } })).toEqual({
      ok: false,
      reason: "assets:page: after: key: expected a number or a string",
    });
    expect(page({ after: "resume-please" })).toEqual({
      ok: false,
      reason: "assets:page: after: expected null or an object",
    });
  });

  it("takes an order, and refuses one it does not have", () => {
    const sort = { key: "name", descending: false, seed: 0 };
    expect(page({ sort })).toEqual({
      ok: true,
      value: { type: "assets:page", query: "", limit: 100, after: null, sort },
    });

    expect(page({ sort: { key: "colour", descending: false, seed: 0 } }).ok).toBe(false);
    expect(page({ sort: { key: "name", descending: false, seed: -1 } })).toEqual({
      ok: false,
      reason: "assets:page: sort: seed: expected zero or more",
    });
    expect(page({ sort: { key: "name", seed: 0 } })).toEqual({
      ok: false,
      reason: "assets:page: sort: descending: expected a boolean",
    });
  });

  it("bounds the limit rather than clamping it", () => {
    // A renderer asking for a million rows is a bug. Answering it politely
    // would hide the bug behind a slow window.
    expect(page({ limit: 0 })).toEqual({
      ok: false,
      reason: `assets:page: limit: expected 1 to ${MAX_PAGE_LIMIT}`,
    });
    expect(page({ limit: MAX_PAGE_LIMIT + 1 })).toEqual({
      ok: false,
      reason: `assets:page: limit: expected 1 to ${MAX_PAGE_LIMIT}`,
    });
    expect(page({ limit: 1.5 })).toEqual({
      ok: false,
      reason: "assets:page: limit: expected a safe integer",
    });
    expect(page({ limit: MAX_PAGE_LIMIT }).ok).toBe(true);
  });
});

describe("validating a change of preferences", () => {
  /**
   * Every field is optional and absent means "leave it alone" (ADR-0019), so
   * the patch has to survive a build that knows one setting talking to one that
   * knows two — in both directions.
   */
  it("takes one setting, both, or neither", () => {
    expect(checkRequest({ type: "settings:write" })).toEqual({
      ok: true,
      value: { type: "settings:write" },
    });
    expect(checkRequest({ type: "settings:write", fitVideoToWindow: true })).toEqual({
      ok: true,
      value: { type: "settings:write", fitVideoToWindow: true },
    });
    expect(
      checkRequest({
        type: "settings:write",
        showSubfolderContents: true,
        fitVideoToWindow: false,
      }),
    ).toEqual({
      ok: true,
      value: { type: "settings:write", showSubfolderContents: true, fitVideoToWindow: false },
    });
  });

  it("still checks a key that is there", () => {
    // "Absent" and "not a boolean" are different answers, and only the first of
    // them is a request.
    expect(checkRequest({ type: "settings:write", fitVideoToWindow: "yes" })).toEqual({
      ok: false,
      reason: "settings:write: fitVideoToWindow: expected a boolean",
    });
  });

  it("bounds the volume on both sides, because the element does", () => {
    // A percent (ADR-0024 §9). `HTMLMediaElement.volume` throws outside 0–1, so
    // a window that sent 400 would be a window that cannot play the next file
    // it opens — which makes this the cheapest place to refuse it.
    expect(checkRequest({ type: "settings:write", mediaVolume: 0, mediaMuted: true })).toEqual({
      ok: true,
      value: { type: "settings:write", mediaMuted: true, mediaVolume: 0 },
    });
    expect(checkRequest({ type: "settings:write", mediaVolume: 100 })).toEqual({
      ok: true,
      value: { type: "settings:write", mediaVolume: 100 },
    });
    expect(checkRequest({ type: "settings:write", mediaVolume: 101 })).toEqual({
      ok: false,
      reason: "settings:write: mediaVolume: expected 0 to 100",
    });
    expect(checkRequest({ type: "settings:write", mediaVolume: -1 })).toEqual({
      ok: false,
      reason: "settings:write: mediaVolume: expected 0 to 100",
    });
    // Whole percent: a float is where the slider's own 0–1 would leak in.
    expect(checkRequest({ type: "settings:write", mediaVolume: 0.5 })).toEqual({
      ok: false,
      reason: "settings:write: mediaVolume: expected a safe integer",
    });
  });
});

describe("validating a thumbnail moment", () => {
  const HASH = "a".repeat(64);

  it("takes a moment and takes its absence", () => {
    expect(checkRequest({ type: "asset:poster", hash: HASH, atMs: 91_500 })).toMatchObject({
      ok: true,
    });
    // `null` is the default frame, which is not the first one — clearing is
    // this request with the value absent rather than a request of its own.
    expect(checkRequest({ type: "asset:poster", hash: HASH, atMs: null })).toMatchObject({
      ok: true,
    });
  });

  it("refuses a moment before the start", () => {
    expect(checkRequest({ type: "asset:poster", hash: HASH, atMs: -1 })).toMatchObject({
      ok: false,
    });
  });

  it("refuses a moment that is not whole milliseconds", () => {
    expect(checkRequest({ type: "asset:poster", hash: HASH, atMs: 1.5 })).toMatchObject({
      ok: false,
    });
  });
});

describe("validating the import chooser", () => {
  it("takes each subject", () => {
    for (const what of ["files", "folders"] as const) {
      expect(checkRequest({ type: "dialog:chooseImport", what })).toEqual({
        ok: true,
        value: { type: "dialog:chooseImport", what },
      });
    }
  });

  /**
   * The field decides which dialog main draws, and a request without one used
   * to be the whole request — so a stale renderer must fail here rather than
   * fall through to a default that quietly picks the wrong chooser.
   */
  it("refuses a request with no subject, and one with a subject it does not know", () => {
    expect(checkRequest({ type: "dialog:chooseImport" })).toMatchObject({ ok: false });
    expect(checkRequest({ type: "dialog:chooseImport", what: "both" })).toMatchObject({
      ok: false,
    });
  });
});

describe("validating an import's destination", () => {
  const paths = ["/pictures"];

  it("takes a folder, and an explicit null for no folder at all", () => {
    // ADR-0037: an import made outside a folder files nothing, which is an
    // answer rather than a missing field.
    expect(
      checkRequest({ type: "import:paths", paths, mode: "managed", tags: [], folder: 3 }),
    ).toEqual({
      ok: true,
      value: { type: "import:paths", paths, mode: "managed", tags: [], folder: 3 },
    });
    expect(
      checkRequest({ type: "import:paths", paths, mode: "managed", tags: [], folder: null }),
    ).toMatchObject({ ok: true, value: { folder: null } });
  });

  it("refuses a missing destination, and one that is not a folder id", () => {
    // Missing rather than null is a renderer that has not been rebuilt, and it
    // must fail here rather than fall through to "no folder".
    expect(checkRequest({ type: "import:paths", paths, mode: "managed", tags: [] })).toMatchObject({
      ok: false,
    });
    for (const folder of [0, -1, 1.5, "3"]) {
      expect(
        checkRequest({ type: "import:paths", paths, mode: "managed", tags: [], folder }),
      ).toMatchObject({ ok: false });
    }
  });

  it("needs a real folder to file the last run's duplicates into", () => {
    // No null here, unlike the import itself: the request exists to name
    // somewhere, and there is nothing to do without one.
    expect(checkRequest({ type: "import:fileDuplicates", folder: 7 })).toEqual({
      ok: true,
      value: { type: "import:fileDuplicates", folder: 7 },
    });
    expect(checkRequest({ type: "import:fileDuplicates", folder: null })).toMatchObject({
      ok: false,
    });
    expect(checkRequest({ type: "import:fileDuplicates" })).toMatchObject({ ok: false });
  });
});

describe("validating a comment", () => {
  const HASH = "a".repeat(64);

  it("takes a moment or an explicit null, and nothing in between", () => {
    expect(checkRequest({ type: "comment:add", hash: HASH, atMs: 91_500, body: "early" })).toEqual({
      ok: true,
      value: { type: "comment:add", hash: HASH, atMs: 91_500, body: "early" },
    });

    // `null` is a comment about the asset rather than about a moment in it,
    // which is what lets a `.zip` carry one (ADR-0023).
    expect(checkRequest({ type: "comment:add", hash: HASH, atMs: null, body: "x" })).toEqual({
      ok: true,
      value: { type: "comment:add", hash: HASH, atMs: null, body: "x" },
    });

    // An absent field is not the same as an explicit null on this boundary: it
    // is a caller that forgot, and forgetting must not silently mean "about the
    // whole asset".
    expect(checkRequest({ type: "comment:add", hash: HASH, body: "x" })).toEqual({
      ok: false,
      reason: "comment:add: atMs: expected a safe integer",
    });
  });

  it("refuses a moment that cannot mean anything", () => {
    expect(checkRequest({ type: "comment:add", hash: HASH, atMs: -1, body: "x" })).toEqual({
      ok: false,
      reason: "comment:add: atMs: expected zero or more milliseconds",
    });
    // Milliseconds are integers here, and a float would round differently on
    // the two sides of the wire.
    expect(checkRequest({ type: "comment:add", hash: HASH, atMs: 91.5, body: "x" })).toEqual({
      ok: false,
      reason: "comment:add: atMs: expected a safe integer",
    });
  });

  it("takes a folder by id, and refuses a number that was never one", () => {
    expect(checkRequest({ type: "asset:folderAdd", hashes: [HASH], folder: 3 })).toEqual({
      ok: true,
      value: { type: "asset:folderAdd", hashes: [HASH], folder: 3 },
    });
    // Rowids start at one. Zero is not a folder that went away; it is a number
    // that never named one, and the difference is worth refusing at the door.
    expect(checkRequest({ type: "asset:folderRemove", hashes: [HASH], folder: 0 })).toEqual({
      ok: false,
      reason: "asset:folderRemove: folder: expected a folder id",
    });
    expect(checkRequest({ type: "asset:folderRemove", hashes: [HASH], folder: "Icons" })).toEqual({
      ok: false,
      reason: "asset:folderRemove: folder: expected a safe integer",
    });
  });

  it("refuses a body with nothing in it", () => {
    // The engine trims and refuses the same thing (`EmptyCommentError`); this
    // is the boundary refusing to carry it in the first place.
    expect(checkRequest({ type: "comment:add", hash: HASH, atMs: null, body: "   " })).toEqual({
      ok: false,
      reason: "comment:add: body: expected a non-empty string",
    });
  });

  it("names an edit by its id, never by a hash and a position", () => {
    expect(checkRequest({ type: "comment:set", id: 41, atMs: 91_000, body: "later" })).toEqual({
      ok: true,
      value: { type: "comment:set", id: 41, atMs: 91_000, body: "later" },
    });
    expect(checkRequest({ type: "comment:remove", id: 41 })).toEqual({
      ok: true,
      value: { type: "comment:remove", id: 41 },
    });
    expect(checkRequest({ type: "comment:remove", id: "41" })).toEqual({
      ok: false,
      reason: "comment:remove: id: expected a safe integer",
    });
  });
});

describe("validating an envelope", () => {
  it("carries an id with the request", () => {
    expect(checkRequestEnvelope({ id: 3, request: { type: "library:stats" } })).toEqual({
      ok: true,
      value: { id: 3, request: { type: "library:stats" } },
    });
  });

  it("reads as a path when the failure is inside the request", () => {
    expect(checkRequestEnvelope({ id: 1, request: { type: "library:open" } })).toEqual({
      ok: false,
      reason: "request: library:open: path: expected a string",
    });
  });

  it("refuses an id that is not a whole number", () => {
    expect(checkRequestEnvelope({ id: 1.5, request: { type: "library:stats" } }).ok).toBe(false);
    expect(checkRequestEnvelope({ request: { type: "library:stats" } }).ok).toBe(false);
  });

  it("keeps a reply's success and its failure apart", () => {
    // A caller must not be able to read a value out of a failure by forgetting
    // to check, so the two shapes have no field in common beyond the id.
    expect(checkReplyEnvelope({ id: 2, ok: true, value: null })).toEqual({
      ok: true,
      value: { id: 2, ok: true, value: null },
    });

    expect(checkReplyEnvelope({ id: 2, ok: false }).ok).toBe(false);
    expect(checkReplyEnvelope({ id: 2, ok: true }).ok).toBe(false);
  });

  it("requires a problem to carry a code", () => {
    // The code is the whole reason the wire shape exists: a `RoostError` loses
    // it to `structuredClone`, so a problem without one is worth nothing.
    const problem = { code: "not_a_library", message: "no library.json", detail: { path: "/x" } };
    expect(checkReplyEnvelope({ id: 5, ok: false, problem })).toEqual({
      ok: true,
      value: { id: 5, ok: false, problem },
    });

    expect(checkReplyEnvelope({ id: 5, ok: false, problem: { ...problem, code: "" } }).ok).toBe(
      false,
    );
    expect(
      checkReplyEnvelope({
        id: 5,
        ok: false,
        problem: { ...problem, detail: { nested: { no: true } } },
      }),
    ).toEqual({
      ok: false,
      reason: "problem: detail.nested: expected a string, number, boolean, or null",
    });
  });

  it("carries an import's progress as counts and nothing else", () => {
    // A progress event fires per hundred files and a bulk import is hundreds
    // of thousands of them; a path per event is a string per event crossing two
    // process boundaries for a status bar nobody reads at that speed.
    expect(
      checkEvent({
        type: "import:progress",
        scanned: 100,
        imported: 98,
        duplicates: 2,
        failed: 0,
        thumbnails: 0,
        total: null,
      }),
    ).toEqual({
      ok: true,
      value: {
        type: "import:progress",
        scanned: 100,
        imported: 98,
        duplicates: 2,
        failed: 0,
        thumbnails: 0,
        total: null,
      },
    });

    // `null` and a number are both accepted, and they mean different things:
    // a walk does not know its total until it ends, and an Eagle import counted
    // its items before it began (ADR-0032).
    expect(
      checkEvent({
        type: "import:progress",
        scanned: 3,
        imported: 3,
        duplicates: 0,
        failed: 0,
        thumbnails: 0,
        total: 14,
      }),
    ).toMatchObject({ ok: true, value: { total: 14 } });

    expect(checkEvent({ type: "import:progress", scanned: 1, imported: 1, duplicates: 0 })).toEqual(
      {
        ok: false,
        reason: "import:progress: failed: expected a safe integer",
      },
    );
    // A path smuggled in does not ride along: the value is built here, field
    // by field, rather than being the caller's object with a type over it.
    const smuggled = checkEvent({
      type: "import:progress",
      scanned: 1,
      imported: 1,
      duplicates: 0,
      failed: 0,
      thumbnails: 0,
      total: null,
      path: "/home/you/secret",
    });
    expect(smuggled).toEqual({
      ok: true,
      value: {
        type: "import:progress",
        scanned: 1,
        imported: 1,
        duplicates: 0,
        failed: 0,
        thumbnails: 0,
        total: null,
      },
    });
  });

  it("validates an event the same way", () => {
    expect(checkEventEnvelope({ event: { type: "library:changed" } }).ok).toBe(true);
    expect(checkEvent({ type: "library:exploded" })).toEqual({
      ok: false,
      reason: 'type: unknown event "library:exploded"',
    });
  });
});

describe("the readers everything else is built from", () => {
  it("accepts a content hash and nothing that merely looks like one", () => {
    const hash = "a".repeat(64);
    expect(readHash({ hash }, "hash")).toEqual({ ok: true, value: hash });
    // Uppercase is refused rather than folded: the on-disk name is lowercase,
    // so folding here would put one asset at two addresses.
    expect(readHash({ hash: "A".repeat(64) }, "hash").ok).toBe(false);
    expect(readHash({ hash: "a".repeat(63) }, "hash").ok).toBe(false);
    expect(readHash({ hash: `${"a".repeat(63)}g` }, "hash").ok).toBe(false);

    expect(readHashArray({ hashes: [hash, hash] }, "hashes").ok).toBe(true);
    expect(readHashArray({ hashes: [hash, "nope"] }, "hashes").ok).toBe(false);
    expect(readHashArray({ hashes: hash }, "hashes").ok).toBe(false);
  });

  it("lists the vocabulary when a value is not in it", () => {
    expect(readOneOf({ mode: "managed" }, "mode", STORAGE_MODES)).toEqual({
      ok: true,
      value: "managed",
    });
    expect(readOneOf({ mode: "sideways" }, "mode", STORAGE_MODES)).toEqual({
      ok: false,
      reason: "mode: expected one of managed, referenced",
    });
  });
});

/**
 * Declared here rather than pulled in with a `lib`.
 *
 * `structuredClone` is a global in Node and in the browser, and this package
 * has the types of neither — that absence is what enforces "loads in a
 * sandboxed renderer" at compile time (`CLAUDE.md` §6). Widening `lib` for one
 * test would give the whole package the DOM back.
 */
declare function structuredClone<T>(value: T): T;

describe("what crosses the port", () => {
  it("survives structuredClone, which is what actually carries it", () => {
    // The rule this pins is `ARCHITECTURE.md` §4.2: nothing in a message may be
    // something the algorithm cannot carry. A class instance, a function, or a
    // `Date` would fail here or arrive as something else.
    const messages = [
      { id: 1, request: { type: "library:open", path: "/libraries/one" } },
      { id: 1, ok: true, value: null },
      { id: 2, ok: false, problem: { code: "io", message: "nope", detail: { errno: -2 } } },
      { event: { type: "library:changed" } },
    ];

    for (const message of messages) {
      expect(structuredClone(message)).toEqual(message);
    }
  });
});
