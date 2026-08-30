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
      "library:stats",
      "library:sidebar",
      "assets:page",
      "assets:count",
      "query:check",
      "asset:detail",
      "asset:summary",
      "asset:rate",
      "asset:favorite",
      "asset:note",
      "asset:rename",
      "asset:tagAdd",
      "asset:tagRemove",
      "asset:openExternally",
      "asset:reveal",
      "asset:copyPath",
      "assets:export",
      "import:paths",
      "derive:status",
      "derive:retry",
      "dialog:chooseImport",
      "dialog:openLibrary",
      "dialog:chooseLocation",
    ]);
  });
});

describe("validating a page of the grid", () => {
  const page = (over: Record<string, unknown>): ReturnType<typeof checkRequest> =>
    checkRequest({ type: "assets:page", query: "", limit: 100, after: null, ...over });

  it("accepts an empty query, which means the whole library", () => {
    expect(page({})).toEqual({
      ok: true,
      value: { type: "assets:page", query: "", limit: 100, after: null },
    });
  });

  it("takes a cursor back only in the shape it handed one out", () => {
    const cursor = { importedAt: 1_700_000_000, hash: "a".repeat(64) };
    expect(page({ after: cursor })).toEqual({
      ok: true,
      value: { type: "assets:page", query: "", limit: 100, after: cursor },
    });

    // Every field of it, checked. A cursor is used in a keyset predicate, and
    // the renderer is the process this build assumes may be compromised.
    expect(page({ after: { importedAt: 1, hash: "not-a-hash" } })).toEqual({
      ok: false,
      reason: "assets:page: after: hash: expected 64 lowercase hex characters",
    });
    expect(page({ after: { hash: "a".repeat(64) } })).toEqual({
      ok: false,
      reason: "assets:page: after: importedAt: expected a safe integer",
    });
    expect(page({ after: "resume-please" })).toEqual({
      ok: false,
      reason: "assets:page: after: expected null or an object",
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
      },
    });

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
