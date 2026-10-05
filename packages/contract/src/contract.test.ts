import { describe, expect, it } from "vitest";
import { readAssetId, readAssetIdArray, readOneOf } from "./checked.js";
import { TAKES } from "./dto.js";
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
      "library:rename",
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
      "asset:thumbnail",
      "asset:thumbnailSet",
      "asset:thumbnailClear",
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
      "folder:covers",
      "folder:find",
      "folder:delete",
      "comment:add",
      "comment:set",
      "comment:remove",
      "asset:openExternally",
      "asset:reveal",
      "asset:copyPath",
      "asset:copyFiles",
      "asset:copyImage",
      "asset:dragOut",
      "handoff:cost",
      "assets:trash",
      "assets:restore",
      "assets:remove",
      "assets:emptyTrash",
      "library:reclaimable",
      "library:reclaim",
      "assets:export",
      "assets:transfer",
      "assets:transferCancel",
      "import:cancel",
      "import:paths",
      "import:fileDuplicates",
      "eagle:survey",
      "eagle:import",
      "derive:status",
      "derive:retry",
      "derive:pause",
      "derive:retryAsset",
      "derive:resume",
      "derive:wanted",
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
    const cursor = { key: 1_700_000_000, id: "AAAAAAAAAAAA", section: "own" };
    expect(page({ after: cursor })).toEqual({
      ok: true,
      value: { type: "assets:page", query: "", limit: 100, after: cursor, sort: null },
    });

    // A key is a number or a string and nothing else, because that is what a
    // sort key can be (ADR-0039 §4) — the *meaning* is the engine's, and a
    // contract with an opinion about it would be a second one.
    expect(page({ after: { key: "asset-01", id: "AAAAAAAAAAAA", section: "beneath" } }).ok).toBe(
      true,
    );
    // The part of the listing it resumes in (ADR-0059), one of two.
    expect(page({ after: { key: 1, id: "AAAAAAAAAAAA" } }).ok).toBe(false);
    expect(page({ after: { key: 1, id: "AAAAAAAAAAAA", section: "elsewhere" } }).ok).toBe(false);

    // Every field of it, checked. A cursor is used in a keyset predicate, and
    // the renderer is the process this build assumes may be compromised.
    expect(page({ after: { key: 1, id: "not-an-id" } })).toEqual({
      ok: false,
      reason: "assets:page: after: id: expected an asset id",
    });
    expect(page({ after: { id: "AAAAAAAAAAAA" } })).toEqual({
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

  it("carries which panes are drawn (ADR-0028 §6)", () => {
    expect(
      checkRequest({ type: "settings:write", showSidebar: false, showInspector: true }),
    ).toEqual({
      ok: true,
      value: { type: "settings:write", showSidebar: false, showInspector: true },
    });
    expect(checkRequest({ type: "settings:write", showSidebar: 0 })).toEqual({
      ok: false,
      reason: "settings:write: showSidebar: expected a boolean",
    });
  });

  it("carries whether a file is handed out by name (ADR-0034 §8)", () => {
    expect(checkRequest({ type: "settings:write", handOutByName: false })).toEqual({
      ok: true,
      value: { type: "settings:write", handOutByName: false },
    });
    expect(checkRequest({ type: "settings:write", handOutByName: "no" })).toEqual({
      ok: false,
      reason: "settings:write: handOutByName: expected a boolean",
    });
  });

  it("carries a zoom per view, whatever the views are called (ADR-0039 §10)", () => {
    // The view's name is the window's vocabulary, so a name this build has not
    // heard of passes; a zoom that is not a positive integer does not.
    expect(checkRequest({ type: "settings:write", gridZooms: { icons: 160, mosaic: 90 } })).toEqual(
      {
        ok: true,
        value: { type: "settings:write", gridZooms: { icons: 160, mosaic: 90 } },
      },
    );
    expect(checkRequest({ type: "settings:write", gridZooms: [160] })).toEqual({
      ok: false,
      reason: "settings:write: gridZooms: expected an object",
    });
    expect(checkRequest({ type: "settings:write", gridZooms: { details: 0 } })).toEqual({
      ok: false,
      reason: "settings:write: gridZooms.details: expected a positive integer",
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
  const HASH = "AAAAAAAAAAAA";

  it("takes a moment and takes its absence", () => {
    expect(checkRequest({ type: "asset:poster", id: HASH, atMs: 91_500 })).toMatchObject({
      ok: true,
    });
    // `null` is the default frame, which is not the first one — clearing is
    // this request with the value absent rather than a request of its own.
    expect(checkRequest({ type: "asset:poster", id: HASH, atMs: null })).toMatchObject({
      ok: true,
    });
  });

  it("refuses a moment before the start", () => {
    expect(checkRequest({ type: "asset:poster", id: HASH, atMs: -1 })).toMatchObject({
      ok: false,
    });
  });

  it("refuses a moment that is not whole milliseconds", () => {
    expect(checkRequest({ type: "asset:poster", id: HASH, atMs: 1.5 })).toMatchObject({
      ok: false,
    });
  });
});

describe("validating a thumbnail somebody chose (ADR-0060)", () => {
  const ID = "AAAAAAAAAAAA";

  it("takes the selection and where the image comes from", () => {
    for (const from of ["clipboard", "file"] as const) {
      expect(checkRequest({ type: "asset:thumbnail", ids: [ID], from })).toEqual({
        ok: true,
        value: { type: "asset:thumbnail", ids: [ID], from },
      });
    }
    // Main reads the clipboard and the dialog; anywhere else is not a source.
    expect(checkRequest({ type: "asset:thumbnail", ids: [ID], from: "url" })).toMatchObject({
      ok: false,
    });
    expect(checkRequest({ type: "asset:thumbnail", ids: [], from: "file" })).toMatchObject({
      ok: false,
    });
  });

  it("takes a path for the engine, and nothing empty", () => {
    expect(checkRequest({ type: "asset:thumbnailSet", ids: [ID], path: "/tmp/a.png" })).toEqual({
      ok: true,
      value: { type: "asset:thumbnailSet", ids: [ID], path: "/tmp/a.png" },
    });
    expect(checkRequest({ type: "asset:thumbnailSet", ids: [ID], path: "" })).toMatchObject({
      ok: false,
    });
    expect(
      checkRequest({ type: "asset:thumbnailSet", ids: ["nope"], path: "/a.png" }),
    ).toMatchObject({ ok: false });
  });

  it("clears by id", () => {
    expect(checkRequest({ type: "asset:thumbnailClear", ids: [ID] })).toEqual({
      ok: true,
      value: { type: "asset:thumbnailClear", ids: [ID] },
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
      checkRequest({ type: "import:paths", paths, take: "copy", tags: [], folder: 3 }),
    ).toEqual({
      ok: true,
      value: { type: "import:paths", paths, take: "copy", tags: [], folder: 3 },
    });
    expect(
      checkRequest({ type: "import:paths", paths, take: "copy", tags: [], folder: null }),
    ).toMatchObject({ ok: true, value: { folder: null } });
  });

  it("refuses a missing destination, and one that is not a folder id", () => {
    // Missing rather than null is a renderer that has not been rebuilt, and it
    // must fail here rather than fall through to "no folder".
    expect(checkRequest({ type: "import:paths", paths, take: "copy", tags: [] })).toMatchObject({
      ok: false,
    });
    for (const folder of [0, -1, 1.5, "3"]) {
      expect(
        checkRequest({ type: "import:paths", paths, take: "copy", tags: [], folder }),
      ).toMatchObject({ ok: false });
    }
  });

  it("files the last run's duplicates in a folder, or each in its own", () => {
    // `null` is each in the folder its directory became (ADR-0058 §3.4), so it
    // is an answer here where it was refused before; a missing one is not.
    expect(checkRequest({ type: "import:fileDuplicates", folder: 7 })).toEqual({
      ok: true,
      value: { type: "import:fileDuplicates", folder: 7 },
    });
    expect(checkRequest({ type: "import:fileDuplicates", folder: null })).toEqual({
      ok: true,
      value: { type: "import:fileDuplicates", folder: null },
    });
    expect(checkRequest({ type: "import:fileDuplicates", folder: 0 })).toMatchObject({
      ok: false,
    });
    expect(checkRequest({ type: "import:fileDuplicates" })).toMatchObject({ ok: false });
  });
});

describe("validating a comment", () => {
  const HASH = "AAAAAAAAAAAA";

  it("takes a moment or an explicit null, and nothing in between", () => {
    expect(checkRequest({ type: "comment:add", asset: HASH, atMs: 91_500, body: "early" })).toEqual(
      {
        ok: true,
        value: { type: "comment:add", asset: HASH, atMs: 91_500, body: "early" },
      },
    );

    // `null` is a comment about the asset rather than about a moment in it,
    // which is what lets a `.zip` carry one (ADR-0023).
    expect(checkRequest({ type: "comment:add", asset: HASH, atMs: null, body: "x" })).toEqual({
      ok: true,
      value: { type: "comment:add", asset: HASH, atMs: null, body: "x" },
    });

    // An absent field is not the same as an explicit null on this boundary: it
    // is a caller that forgot, and forgetting must not silently mean "about the
    // whole asset".
    expect(checkRequest({ type: "comment:add", asset: HASH, body: "x" })).toEqual({
      ok: false,
      reason: "comment:add: atMs: expected a safe integer",
    });
  });

  it("refuses a moment that cannot mean anything", () => {
    expect(checkRequest({ type: "comment:add", asset: HASH, atMs: -1, body: "x" })).toEqual({
      ok: false,
      reason: "comment:add: atMs: expected zero or more milliseconds",
    });
    // Milliseconds are integers here, and a float would round differently on
    // the two sides of the wire.
    expect(checkRequest({ type: "comment:add", asset: HASH, atMs: 91.5, body: "x" })).toEqual({
      ok: false,
      reason: "comment:add: atMs: expected a safe integer",
    });
  });

  it("takes a folder by id, and refuses a number that was never one", () => {
    expect(checkRequest({ type: "asset:folderAdd", ids: [HASH], folder: 3 })).toEqual({
      ok: true,
      value: { type: "asset:folderAdd", ids: [HASH], folder: 3 },
    });
    // Rowids start at one. Zero is not a folder that went away; it is a number
    // that never named one, and the difference is worth refusing at the door.
    expect(checkRequest({ type: "asset:folderRemove", ids: [HASH], folder: 0 })).toEqual({
      ok: false,
      reason: "asset:folderRemove: folder: expected a folder id",
    });
    expect(checkRequest({ type: "asset:folderRemove", ids: [HASH], folder: "Icons" })).toEqual({
      ok: false,
      reason: "asset:folderRemove: folder: expected a safe integer",
    });
  });

  it("refuses a body with nothing in it", () => {
    // The engine trims and refuses the same thing (`EmptyCommentError`); this
    // is the boundary refusing to carry it in the first place.
    expect(checkRequest({ type: "comment:add", asset: HASH, atMs: null, body: "   " })).toEqual({
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

  it("carries the assets a derive redrew, and refuses a malformed one", () => {
    // ADR-0047. The ids reach the window so that a cell can be given a new
    // thumbnail address without the grid fetching every page again.
    expect(
      checkEvent({
        type: "assets:derived",
        assets: [
          { id: "K7QM4X2AJH9F", derivedAt: 1_700_000_000, undrawn: null, chosen: false },
          { id: "5KM76B88XVJM", derivedAt: 1_700_000_001, undrawn: null, chosen: false },
        ],
      }),
    ).toEqual({
      ok: true,
      value: {
        type: "assets:derived",
        assets: [
          { id: "K7QM4X2AJH9F", derivedAt: 1_700_000_000, undrawn: null, chosen: false },
          { id: "5KM76B88XVJM", derivedAt: 1_700_000_001, undrawn: null, chosen: false },
        ],
      },
    });

    // A derive that parked or failed: a reason, and a time only if it wrote
    // anything about the file (`UI_SPEC.md` §6.1).
    expect(
      checkEvent({
        type: "assets:derived",
        assets: [
          { id: "K7QM4X2AJH9F", derivedAt: null, undrawn: "missing:libheif", chosen: false },
          { id: "5KM76B88XVJM", derivedAt: 1, undrawn: "missing:decoder:hevc", chosen: false },
        ],
      }),
    ).toMatchObject({ ok: true });

    // An empty batch is valid and means nothing was redrawn; the engine does
    // not send one, and a validator that refused it would be a second rule to
    // keep in step with the sender.
    expect(checkEvent({ type: "assets:derived", assets: [] })).toMatchObject({ ok: true });

    expect(checkEvent({ type: "assets:derived", assets: {} })).toEqual({
      ok: false,
      reason: "assets:derived: assets: expected an array",
    });
    expect(
      checkEvent({
        type: "assets:derived",
        assets: [{ id: "K7QM4X2AJH9F", undrawn: null, chosen: false }],
      }),
    ).toEqual({
      ok: false,
      reason: "assets:derived: derivedAt: expected a safe integer",
    });
    expect(
      checkEvent({
        type: "assets:derived",
        assets: [{ id: "K7QM4X2AJH9F", derivedAt: 1, chosen: false }],
      }),
    ).toEqual({
      ok: false,
      reason: "assets:derived: undrawn: expected a string",
    });
    // Whether the picture is somebody's (ADR-0060) is said every time: a
    // window patching a card must not guess it from an absence.
    expect(
      checkEvent({
        type: "assets:derived",
        assets: [{ id: "K7QM4X2AJH9F", derivedAt: 1, undrawn: null }],
      }),
    ).toEqual({
      ok: false,
      reason: "assets:derived: chosen: expected a boolean",
    });

    // Built field by field, so a path or a thumbnail cannot ride along
    // (invariant 12).
    const smuggled = checkEvent({
      type: "assets:derived",
      assets: [
        {
          id: "K7QM4X2AJH9F",
          derivedAt: 1,
          undrawn: null,
          chosen: false,
          path: "/home/someone/secret.png",
        },
      ],
    });
    expect(smuggled.ok && smuggled.value).toEqual({
      type: "assets:derived",
      assets: [{ id: "K7QM4X2AJH9F", derivedAt: 1, undrawn: null, chosen: false }],
    });
  });

  it("carries an import's progress as counts and nothing else", () => {
    // A progress event fires several times a second and a bulk import is
    // hundreds of thousands of files; a path per event is a string per event
    // crossing two process boundaries for a status bar nobody reads at that
    // speed.
    const progress = {
      type: "import:progress",
      scanned: 100,
      imported: 98,
      duplicates: 2,
      failed: 0,
      thumbnails: 0,
      total: 400,
      counting: false,
      bytesDone: 1_048_576,
      bytesTotal: 4_194_304,
    };
    expect(checkEvent(progress)).toEqual({ ok: true, value: progress });

    // While the first walk counts, the total is what it has found so far and
    // nothing has been read (ADR-0055 §3.1).
    expect(
      checkEvent({ ...progress, scanned: 0, imported: 0, counting: true, bytesDone: 0 }),
    ).toMatchObject({ ok: true, value: { counting: true, total: 400 } });

    // The total is a number now: an unknown one is what the count exists to
    // prevent, so `null` is refused rather than drawn as a bar with no end.
    expect(checkEvent({ ...progress, total: null })).toEqual({
      ok: false,
      reason: "import:progress: total: expected a safe integer",
    });
    expect(checkEvent({ ...progress, counting: "yes" })).toMatchObject({ ok: false });

    // A path smuggled in does not ride along: the value is built here, field
    // by field, rather than being the caller's object with a type over it.
    expect(checkEvent({ ...progress, path: "/home/you/secret" })).toEqual({
      ok: true,
      value: progress,
    });
  });

  it("stops an import, and asks nothing else to do it", () => {
    expect(checkRequest({ type: "import:cancel" })).toEqual({
      ok: true,
      value: { type: "import:cancel" },
    });
  });

  it("takes a line of install progress, and only for a backend that has one", () => {
    expect(
      checkEvent({ type: "install:progress", backend: "media", line: "12.0 MB / 150 MB" }),
    ).toEqual({
      ok: true,
      value: { type: "install:progress", backend: "media", line: "12.0 MB / 150 MB" },
    });
    // The same closed vocabulary the request is validated against: this event
    // names a backend, and `images` is not one anybody can install.
    expect(checkEvent({ type: "install:progress", backend: "images", line: "x" }).ok).toBe(false);
    // A blank line is the package manager drawing rather than saying.
    expect(checkEvent({ type: "install:progress", backend: "media", line: " " }).ok).toBe(false);
  });

  it("carries a fold's progress as two whole byte counts", () => {
    expect(checkEvent({ type: "library:folding", done: 4096, total: 8192 })).toEqual({
      ok: true,
      value: { type: "library:folding", done: 4096, total: 8192 },
    });
    expect(checkEvent({ type: "library:folding", done: 0.5, total: 1 }).ok).toBe(false);
    expect(checkEvent({ type: "library:folding", done: 1 }).ok).toBe(false);
  });

  it("carries a rename and a library lost, with a found folder or none (ADR-0056)", () => {
    expect(checkRequest({ type: "library:rename", name: "trip" })).toEqual({
      ok: true,
      value: { type: "library:rename", name: "trip" },
    });
    expect(checkRequest({ type: "library:rename", name: "" }).ok).toBe(false);

    const renamed = { type: "library:renamed", root: "/p/trip.roost", name: "trip" };
    expect(checkEvent(renamed)).toEqual({ ok: true, value: renamed });

    const found = {
      type: "library:lost",
      root: "/p/traveling.roost",
      name: "traveling",
      movedTo: "/p/trip.roost",
      movedName: "trip",
    };
    expect(checkEvent(found)).toEqual({ ok: true, value: found });
    expect(checkEvent({ ...found, movedTo: null, movedName: null }).ok).toBe(true);
    expect(checkEvent({ ...found, movedName: null }).ok).toBe(false);
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
  it("accepts an asset id and nothing that merely looks like one", () => {
    const id = "K7QM4X2AJH9F";
    expect(readAssetId({ id }, "id")).toEqual({ ok: true, value: id });

    // Lower case is refused rather than folded: Windows compares filenames
    // without regard to case, so two ids differing only in case would be one
    // file — which is why RL-14's alphabet is upper case only.
    expect(readAssetId({ id: id.toLowerCase() }, "id").ok).toBe(false);
    // The letters the alphabet leaves out, because they read as digits.
    for (const letter of "ILOU") {
      expect(readAssetId({ id: `${letter}7QM4X2AJH9F` }, "id").ok).toBe(false);
    }
    expect(readAssetId({ id: "K7QM4X2AJH9" }, "id").ok).toBe(false);
    expect(readAssetId({ id: "K7QM4X2AJH9FF" }, "id").ok).toBe(false);
    // A version 1 hash is not an id, which is what stops one reaching a query
    // that would answer nothing.
    expect(readAssetId({ id: "a".repeat(64) }, "id").ok).toBe(false);

    expect(readAssetIdArray({ ids: [id, id] }, "ids").ok).toBe(true);
    expect(readAssetIdArray({ ids: [id, "nope"] }, "ids").ok).toBe(false);
    expect(readAssetIdArray({ ids: id }, "ids").ok).toBe(false);
  });

  it("lists the vocabulary when a value is not in it", () => {
    expect(readOneOf({ take: "copy" }, "take", TAKES)).toEqual({ ok: true, value: "copy" });
    expect(readOneOf({ take: "sideways" }, "take", TAKES)).toEqual({
      ok: false,
      reason: "take: expected one of move, copy",
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
