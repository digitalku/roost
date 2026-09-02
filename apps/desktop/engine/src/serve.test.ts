import { mkdir, mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReplyEnvelope, Request } from "@roost/contract";
import { ASSET_KINDS as WIRE_KINDS, LIBRARY_SUFFIX as WIRE_SUFFIX } from "@roost/contract";
import { KINDS, latestSchemaVersion } from "@roost/core";
import { importInto, LIBRARY_SUFFIX, Library } from "@roost/library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineHost } from "./host.js";
import type { Port } from "./port.js";
import { serve } from "./serve.js";

/**
 * A port that is a plain object.
 *
 * The whole reason `serve` takes a {@link Port} rather than importing Electron:
 * the message loop is the part most worth testing and the least worth starting
 * a browser for.
 */
class FakePort implements Port {
  readonly sent: unknown[] = [];
  #listener: ((message: { data: unknown }) => void) | undefined;
  started = false;

  on(_channel: "message", listener: (message: { data: unknown }) => void): void {
    this.#listener = listener;
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  start(): void {
    this.started = true;
  }

  /** Delivers a message as Electron would, and waits for the reply. */
  async deliver(data: unknown): Promise<ReplyEnvelope | undefined> {
    const before = this.sent.length;
    this.#listener?.({ data });
    // The handler is async; one macrotask is enough for a reply that never
    // touches the disk, and the loop covers the ones that do.
    for (let tick = 0; tick < 50 && this.replies(before).length === 0; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return this.replies(before)[0];
  }

  /**
   * The replies sent since `from`, skipping events.
   *
   * An edit announces `library:changed` before it answers, so the next message
   * on the port after a request is not necessarily its reply.
   */
  replies(from = 0): ReplyEnvelope[] {
    return this.sent
      .slice(from)
      .filter((message): message is ReplyEnvelope => isRecord(message) && "id" in message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Which files this process currently holds open under `root`.
 *
 * Linux-only, and deliberately not a lock check: `acquireLock` treats our own
 * pid as free, so a library this process never closed is indistinguishable from
 * one it did by that route. The file descriptors are not.
 */
async function openFilesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const fd of await readdir("/proc/self/fd")) {
    try {
      const target = await readlink(`/proc/self/fd/${fd}`);
      if (target.startsWith(`${root}/`)) found.push(target);
    } catch {
      // The descriptor closed while the directory was being walked, which is
      // ordinary: reading it is itself a descriptor.
    }
  }
  return found.sort();
}

describe("the engine's message loop", () => {
  let dir: string;
  let port: FakePort;
  let host: EngineHost;
  let close: () => Promise<void>;

  const ask = async (id: number, request: Request): Promise<ReplyEnvelope | undefined> =>
    port.deliver({ id, request });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-engine-"));
    port = new FakePort();
    host = new EngineHost();
    close = serve(port, host).close;
  });

  afterEach(async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
  });

  it("starts the port, because a port nobody started delivers nothing", () => {
    expect(port.started).toBe(true);
  });

  it("agrees with the contract about what a library folder is called", () => {
    // Two constants that must match and cannot import each other: the contract
    // may not depend on `@roost/library`, and the renderer may not import
    // anything else. This process depends on both, so this is the only place
    // the two can be compared (ADR-0014).
    expect(WIRE_SUFFIX).toBe(LIBRARY_SUFFIX);
  });

  it("refuses a name a filesystem would read as something else", async () => {
    // The name is about to become a path, and the engine is the side with a
    // filesystem — so it checks, rather than trusting that the window did.
    for (const name of ["..", "a/b", ".hidden"]) {
      const reply = await ask(9, { type: "library:create", parent: dir, name });
      expect({ name, ok: reply?.ok }).toEqual({ name, ok: false });
      expect(reply).toMatchObject({ problem: { code: "invalid_library_name" } });
    }
  });

  it("creates a library and answers with what the window shows", async () => {
    const reply = await ask(1, {
      type: "library:create",
      parent: dir,
      name: "Made By The Window",
    });

    expect(reply?.ok).toBe(true);
    expect(reply).toMatchObject({
      id: 1,
      ok: true,
      // The suffix is added here, on the side that has a filesystem: the
      // renderer sends a location and a name and never joins them (ADR-0014).
      value: {
        root: join(dir, "Made By The Window.roost"),
        name: "Made By The Window",
        formatVersion: 1,
        schemaVersion: latestSchemaVersion(),
      },
    });
  });

  it("answers a request that needs a library it does not have, rather than hanging", async () => {
    const reply = await ask(2, { type: "library:stats" });

    expect(reply).toEqual({
      id: 2,
      ok: false,
      // Not a `RoostError`, so it crosses as `remote` — a code the renderer can
      // report but not act on, which is the honest answer for one.
      problem: { code: "remote", message: "No library is open", detail: {} },
    });
  });

  it("carries a library error's own code across the wire", async () => {
    // The code is the whole reason `WireProblem` exists: `structuredClone`
    // discards the subclass, so a bare Error would arrive without it.
    const reply = await ask(3, { type: "library:open", path: join(dir, "not-a-library") });

    expect(reply).toEqual({
      id: 3,
      ok: false,
      problem: {
        code: "not_a_library",
        message: expect.stringContaining("not a Roost library"),
        detail: { path: join(dir, "not-a-library") },
      },
    });
  });

  it("drops a message that is not a request, without answering it", async () => {
    // Nothing can be replied to: a message this malformed may not carry the id
    // an answer would have to be addressed to.
    for (const message of [null, 7, { id: 1 }, { id: 1, request: { type: "library:eat" } }]) {
      expect(await port.deliver(message)).toBeUndefined();
    }
  });

  it("holds one library at a time, and lets go of the one it replaced", async () => {
    const first = join(dir, "First.roost");
    const second = join(dir, "Second.roost");
    await ask(1, { type: "library:create", parent: dir, name: "First" });
    expect(await openFilesUnder(first)).not.toEqual([]);

    await ask(2, { type: "library:create", parent: dir, name: "Second" });

    expect(await ask(3, { type: "library:current" })).toMatchObject({
      ok: true,
      value: { root: second, name: "Second" },
    });
    // Not the lock, which is re-entrant within one process by design — the file
    // handles. A library kept open holds its index and its journal, and the
    // journal buffers, so "replaced" has to mean closed rather than forgotten.
    expect(await openFilesUnder(first)).toEqual([]);
  });

  it("reports nothing open once it is closed", async () => {
    await ask(1, { type: "library:create", parent: dir, name: "Closed" });
    expect(await ask(2, { type: "library:close" })).toEqual({ id: 2, ok: true, value: null });
    expect(await ask(3, { type: "library:current" })).toEqual({ id: 3, ok: true, value: null });
  });

  /**
   * A library with `count` distinct files in it, opened through the host.
   *
   * Built with `@roost/library` and then handed over, because the engine has no
   * import request yet — the grid arrives before the import UI does.
   */
  const libraryOf = async (count: number): Promise<void> => {
    const source = join(dir, "source");
    await mkdir(source, { recursive: true });
    for (let i = 0; i < count; i += 1) {
      await writeFile(join(source, `file-${i}.txt`), `contents ${i}`);
    }
    const root = join(dir, `Paged${LIBRARY_SUFFIX}`);
    const library = await Library.create(root, "Paged");
    try {
      await importInto(library, [source]);
    } finally {
      await library.close();
    }
    await ask(100, { type: "library:open", path: root });
  };

  const pageOfHits = (reply: ReplyEnvelope | undefined): { names: string[]; next: unknown } => {
    const value = (reply as { value: { assets: { name: string }[]; next: unknown } }).value;
    return { names: value.assets.map((a) => a.name), next: value.next };
  };

  it("pages the grid by cursor, and says when there is no next page", async () => {
    await libraryOf(5);

    const first = await ask(1, { type: "assets:page", query: "", limit: 2, after: null });
    const firstPage = pageOfHits(first);
    expect(firstPage.names).toHaveLength(2);
    expect(firstPage.next).not.toBeNull();

    const second = await ask(2, {
      type: "assets:page",
      query: "",
      limit: 2,
      after: firstPage.next as { importedAt: number; hash: string },
    });
    const secondPage = pageOfHits(second);
    expect(secondPage.names).toHaveLength(2);
    // No overlap: a cursor resumes after the last row, it does not repeat it.
    expect(new Set([...firstPage.names, ...secondPage.names]).size).toBe(4);

    const third = await ask(3, {
      type: "assets:page",
      query: "",
      limit: 2,
      after: secondPage.next as { importedAt: number; hash: string },
    });
    // A short page is the last page, and saying so saves the grid a round trip
    // that would only confirm what the row count already said.
    expect(pageOfHits(third)).toEqual({ names: expect.any(Array), next: null });
    expect(pageOfHits(third).names).toHaveLength(1);
  });

  it("sends the grid only the fields a cell draws, and never bytes", async () => {
    await libraryOf(1);
    const reply = await ask(1, { type: "assets:page", query: "", limit: 1, after: null });
    const [card] = (reply as { value: { assets: Record<string, unknown>[] } }).value.assets;

    // Invariant 12: a thumbnail reaches the window over `roost://`, never in a
    // message. A field added here that carried bytes would pass every other
    // test in this file.
    expect(Object.keys(card ?? {}).sort()).toEqual([
      "ext",
      "hash",
      "height",
      "importedAt",
      "isFavorite",
      "name",
      "posterMs",
      "rating",
      "size",
      "width",
    ]);
  });

  it("treats an empty query as the whole library and RQL as a filter", async () => {
    await libraryOf(3);

    const all = await ask(1, { type: "assets:page", query: "", limit: 10, after: null });
    expect(pageOfHits(all).names).toHaveLength(3);

    const txt = await ask(2, { type: "assets:page", query: "ext:txt", limit: 10, after: null });
    expect(pageOfHits(txt).names).toHaveLength(3);

    const none = await ask(3, { type: "assets:page", query: "ext:png", limit: 10, after: null });
    expect(pageOfHits(none)).toEqual({ names: [], next: null });
  });

  it("answers a malformed query with the parse error rather than an empty grid", async () => {
    await libraryOf(1);
    // An empty grid would look like a library with nothing in it. The search
    // field needs to be able to say where the query went wrong.
    const reply = await ask(1, { type: "assets:page", query: "rating:>>", limit: 10, after: null });
    expect(reply?.ok).toBe(false);
  });

  it("gives every sidebar row the query that selects it", async () => {
    await libraryOf(1);
    const reply = await ask(1, { type: "library:sidebar" });
    const value = (reply as { value: Record<string, { query: string; name: string }[]> }).value;

    expect(Object.keys(value).sort()).toEqual(["folders", "places", "smartFolders", "tags"]);
    // `UI_SPEC.md` §4.1: the renderer never assembles RQL, so a row without a
    // query is a row it cannot act on.
    for (const rows of Object.values(value)) {
      for (const row of rows) expect(typeof row.query).toBe("string");
    }

    const places = value["places"] ?? [];
    expect(places.map((place) => place.name)).toEqual([
      "All assets",
      "Recent",
      "Favorites",
      "Untagged",
      "Trash",
    ]);
    // "All assets" is the empty string — the engine's word for the whole
    // library — and not a term in the grammar.
    expect(places[0]?.query).toBe("");
    expect(places[2]?.query).toBe("is:favorite");
    // Recent is a real date, because RQL has no relative one and the grammar is
    // frozen by cross-implementation compatibility.
    expect(places[1]?.query).toMatch(/^imported:>\d{4}-\d{2}-\d{2}$/);
  });

  it("sends every place query as something the engine can actually run", async () => {
    // A row carrying a query nobody ever ran is a row that fails on click. Each
    // one is sent straight back through `assets:page`.
    await libraryOf(2);
    const sidebar = await ask(1, { type: "library:sidebar" });
    const places = (sidebar as { value: { places: { query: string }[] } }).value.places;

    let id = 10;
    for (const place of places) {
      id += 1;
      const reply = await ask(id, {
        type: "assets:page",
        query: place.query,
        limit: 5,
        after: null,
      });
      expect({ query: place.query, ok: reply?.ok }).toEqual({ query: place.query, ok: true });
    }
  });

  it("counts what a query matches, separately from paging it", async () => {
    await libraryOf(4);
    expect(await ask(1, { type: "assets:count", query: "" })).toMatchObject({ value: 4 });
    expect(await ask(2, { type: "assets:count", query: "ext:txt" })).toMatchObject({ value: 4 });
    expect(await ask(3, { type: "assets:count", query: "ext:png" })).toMatchObject({ value: 0 });
  });

  it("answers a half-typed query without calling it a failure", async () => {
    await libraryOf(1);
    // `UI_SPEC.md` §5: a half-typed query is the normal state of a search
    // field. A rejected request would make the renderer read it as a fault and
    // show an error state over the grid.
    const reply = await ask(1, { type: "query:check", query: "ext:png rating:9" });
    expect(reply?.ok).toBe(true);

    const value = (reply as { value: { ok: boolean; message: string; at: number | null } }).value;
    expect(value.ok).toBe(false);
    expect(value.message).toBe("Ratings run from 1 to 5, not 9");
    // A caret needs somewhere to point, and it points at the term that is
    // wrong rather than at the start of the query.
    expect(value.at).toBe(8);
  });

  it("accepts a query that matches nothing, which is not the same as invalid", async () => {
    await libraryOf(1);
    for (const query of ["", "ext:png", "folder:Nonexistent", "tag:nobody"]) {
      const reply = await ask(1, { type: "query:check", query });
      expect({ query, value: (reply as { value: unknown }).value }).toEqual({
        query,
        value: { ok: true, message: null, at: null },
      });
    }
  });

  it("reads one asset back with everything the inspector shows", async () => {
    await libraryOf(1);
    const page = await ask(1, { type: "assets:page", query: "", limit: 1, after: null });
    const hash = (page as { value: { assets: { hash: string }[] } }).value.assets[0]?.hash ?? "";

    const reply = await ask(2, { type: "asset:detail", hash });
    const value = (reply as { value: Record<string, unknown> }).value;

    // Every field of the wire shape, and no field the contract never declared:
    // the two types are allowed to differ, and this is the place that notices.
    expect(Object.keys(value).sort()).toEqual(
      [
        "comments",
        "createdAt",
        "durationMs",
        "ext",
        "kind",
        "folders",
        "hash",
        "height",
        "importedAt",
        "isFavorite",
        "isPartialHash",
        "name",
        "note",
        "pageCount",
        "posterMs",
        "props",
        "rating",
        "refPath",
        "size",
        "storageMode",
        "tags",
        "trashedAt",
        "width",
      ].sort(),
    );
    expect(value["rating"]).toBeNull();
    expect(value["isFavorite"]).toBe(false);
    expect(value["tags"]).toEqual([]);
  });

  it("agrees with @roost/core about what an asset broadly is", async () => {
    // Two vocabularies that must match and cannot import each other: the
    // contract may not depend on `@roost/core`, and the renderer may not import
    // anything else. This process depends on both (ADR-0007, and the same
    // argument ADR-0014 made about the library suffix).
    expect([...WIRE_KINDS]).toEqual([...KINDS]);
  });

  it("answers with null for an asset the library does not hold", async () => {
    await libraryOf(1);
    // A selection can outlive the asset it points at. An empty inspector is
    // the right answer to that, not an error dialog.
    const reply = await ask(1, { type: "asset:detail", hash: "f".repeat(64) });
    expect(reply).toEqual({ id: 1, ok: true, value: null });
  });

  it("applies each edit and lets the reader see what the engine made of it", async () => {
    await libraryOf(1);
    const page = await ask(1, { type: "assets:page", query: "", limit: 1, after: null });
    const hash = (page as { value: { assets: { hash: string }[] } }).value.assets[0]?.hash ?? "";
    const detail = async (): Promise<Record<string, unknown>> => {
      const reply = await ask(99, { type: "asset:detail", hash });
      return (reply as { value: Record<string, unknown> }).value;
    };

    expect(await ask(2, { type: "asset:rate", hashes: [hash], rating: 4 })).toMatchObject({
      ok: true,
      value: null,
    });
    expect((await detail())["rating"]).toBe(4);

    await ask(3, { type: "asset:favorite", hashes: [hash], favorite: true });
    expect((await detail())["isFavorite"]).toBe(true);

    // The engine drops an all-whitespace note rather than storing one: a note
    // badge that is on forever and says nothing is worse than no badge.
    await ask(4, { type: "asset:note", hash, note: "   " });
    expect((await detail())["note"]).toBeNull();
    await ask(5, { type: "asset:note", hash, note: "  keep this  " });
    expect((await detail())["note"]).toBe("keep this");

    await ask(6, { type: "asset:tagAdd", hashes: [hash], tags: ["Wood", " wood "] });
    // Deduplicated and trimmed on the way through, which is exactly why an
    // edit answers with `null` and the inspector re-reads.
    expect((await detail())["tags"]).toEqual(["Wood"]);

    await ask(7, { type: "asset:tagRemove", hashes: [hash], tags: ["wood"] });
    expect((await detail())["tags"]).toEqual([]);

    await ask(8, { type: "asset:rename", hash, name: "  Renamed.txt  " });
    expect((await detail())["name"]).toBe("Renamed.txt");
  });

  it("carries comments on the asset they are about, in timeline order", async () => {
    await libraryOf(1);
    const page = await ask(1, { type: "assets:page", query: "", limit: 1, after: null });
    const hash = (page as { value: { assets: { hash: string }[] } }).value.assets[0]?.hash ?? "";
    const comments = async (): Promise<Record<string, unknown>[]> => {
      const reply = await ask(99, { type: "asset:detail", hash });
      return (reply as { value: { comments: Record<string, unknown>[] } }).value.comments;
    };

    // Written out of order on purpose: the list is a timeline, not a log of
    // when somebody typed.
    await ask(2, { type: "comment:add", hash, atMs: 120_000, body: "  later  " });
    await ask(3, { type: "comment:add", hash, atMs: null, body: "about the file" });
    await ask(4, { type: "comment:add", hash, atMs: 1_000, body: "earlier" });

    // Timed first, in order, and the untimed one last — and the body trimmed on
    // the way through, which is why an edit answers `null` and the reader
    // re-reads (ADR-0023).
    expect((await comments()).map((row) => row["body"])).toEqual([
      "earlier",
      "later",
      "about the file",
    ]);
    // `atMs` on the wire, milliseconds, beside a `createdAt` in unix seconds:
    // the one number in the format that is not seconds, spelled so that it
    // cannot be read as one.
    expect(Object.keys((await comments())[0] ?? {}).sort()).toEqual(
      ["atMs", "body", "createdAt", "id", "updatedAt"].sort(),
    );

    // Narrowed rather than cast: the reply is `unknown` on this side of the
    // wire, and that is the whole point of reading it back through the port.
    const idOf = (row: Record<string, unknown> | undefined): number => {
      const id = row?.["id"];
      if (typeof id !== "number") throw new Error("a comment came back without an id");
      return id;
    };
    const id = idOf((await comments())[0]);
    await ask(5, { type: "comment:set", id, atMs: 2_000, body: "earlier still" });
    // The same comment, moved: an edit that removed and re-added would mint a
    // second id and put it at the end of the list.
    expect((await comments())[0]).toMatchObject({ id, atMs: 2_000, body: "earlier still" });
    expect(await comments()).toHaveLength(3);

    await ask(6, { type: "comment:remove", id });
    expect((await comments()).map((row) => row["id"])).not.toContain(id);
  });

  it("refuses a comment the format cannot hold", async () => {
    await libraryOf(1);
    const page = await ask(1, { type: "assets:page", query: "", limit: 1, after: null });
    const hash = (page as { value: { assets: { hash: string }[] } }).value.assets[0]?.hash ?? "";

    // Refused by the contract before the engine is asked, and therefore
    // **dropped rather than answered** — the same rule every malformed message
    // follows here (`serve.ts`). A body with nothing in it is a comment that
    // says nothing, and a negative offset is a number that cannot mean
    // anything; both are the validator's, and `contract.test.ts` pins them.
    expect(await ask(2, { type: "comment:add", hash, atMs: null, body: "  " })).toBeUndefined();
    expect(await ask(3, { type: "comment:add", hash, atMs: -1, body: "x" })).toBeUndefined();
    // An id nothing is behind is the engine's to refuse, and it says so rather
    // than doing nothing quietly: a stale list in one window must not silently
    // edit whatever is at that id now.
    expect(await ask(4, { type: "comment:set", id: 9_999, atMs: null, body: "x" })).toMatchObject({
      ok: false,
      problem: { code: "unknown_comment" },
    });
  });

  it("refuses a rating the schema will not hold", async () => {
    await libraryOf(1);
    const page = await ask(1, { type: "assets:page", query: "", limit: 1, after: null });
    const hash = (page as { value: { assets: { hash: string }[] } }).value.assets[0]?.hash ?? "";

    const reply = await ask(2, { type: "asset:rate", hashes: [hash], rating: 9 });
    expect(reply).toMatchObject({ ok: false, problem: { code: "invalid_rating" } });
  });

  it("announces that the library changed, once per edit", async () => {
    await libraryOf(1);
    const page = await ask(1, { type: "assets:page", query: "", limit: 1, after: null });
    const hash = (page as { value: { assets: { hash: string }[] } }).value.assets[0]?.hash ?? "";

    const events = (): unknown[] =>
      port.sent.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "event" in message &&
          (message as { event: { type: string } }).event.type === "library:changed",
      );
    const before = events().length;

    await ask(2, { type: "asset:rate", hashes: [hash], rating: 3 });

    // Everything derived — the counts, the sidebar, the grid — is re-read from
    // this. An edit that changed the library silently would leave all three
    // showing the state before it.
    expect(events().length).toBe(before + 1);
  });

  it("refuses to open a file itself, because it has no desktop", async () => {
    await libraryOf(1);
    const reply = await ask(1, { type: "asset:openExternally", hash: "a".repeat(64) });
    // Main answers this one. Reaching the engine is a routing bug, and it
    // fails loudly rather than returning a plausible false.
    expect(reply?.ok).toBe(false);
  });

  it("imports what it is given, and reports what it did", async () => {
    const source = join(dir, "loose");
    await mkdir(source, { recursive: true });
    for (let i = 0; i < 3; i += 1) await writeFile(join(source, `file-${i}.txt`), `body ${i}`);
    const root = join(dir, `Imported${LIBRARY_SUFFIX}`);
    const library = await Library.create(root, "Imported");
    await library.close();
    await ask(1, { type: "library:open", path: root });

    const reply = await ask(2, {
      type: "import:paths",
      paths: [source],
      mode: "managed",
      tags: [],
    });
    const report = (reply as { value: Record<string, unknown> }).value;

    // The timings are dropped on purpose: they are a benchmark's business, and
    // a window that showed them would invite reading one run as a measurement.
    expect(Object.keys(report).sort()).toEqual(
      [
        "bytes",
        "duplicates",
        "elapsedMs",
        "failed",
        "imported",
        "partialCollisions",
        "partialDuplicates",
        "scanned",
        "thumbnails",
      ].sort(),
    );
    expect(report["imported"]).toBe(3);
    expect(report["failed"]).toEqual([]);

    // Re-importing is the ordinary case, not a failure: identical bytes have
    // one address (`STORAGE_SPEC.md` invariant 1).
    const again = await ask(3, {
      type: "import:paths",
      paths: [source],
      mode: "managed",
      tags: [],
    });
    expect((again as { value: Record<string, unknown> }).value).toMatchObject({
      imported: 0,
      duplicates: 3,
    });
  });

  it("reports progress, and announces the change once at the end", async () => {
    const source = join(dir, "progress");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "one.txt"), "one");
    const root = join(dir, `Progressed${LIBRARY_SUFFIX}`);
    const library = await Library.create(root, "Progressed");
    await library.close();
    await ask(1, { type: "library:open", path: root });

    const eventsOf = (type: string): unknown[] =>
      port.sent.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "event" in message &&
          (message as { event: { type: string } }).event.type === type,
      );
    const changedBefore = eventsOf("library:changed").length;

    await ask(2, { type: "import:paths", paths: [source], mode: "managed", tags: [] });

    // One final progress event however small the run, so a status bar showing
    // an import always ends up showing what it ended on.
    expect(eventsOf("import:progress").length).toBeGreaterThanOrEqual(1);
    // And exactly one `library:changed`, not one per file: the window re-reads
    // the counts, the sidebar and the match count on it, and doing that per
    // file would be an import that spends its time redrawing.
    expect(eventsOf("library:changed").length).toBe(changedBefore + 1);
  });

  it("refuses to open a file picker, because it has no window", async () => {
    await libraryOf(1);
    const reply = await ask(1, { type: "dialog:chooseImport" });
    expect(reply?.ok).toBe(false);
  });

  it("maps the counts field by field rather than spreading them", async () => {
    await ask(1, { type: "library:create", parent: dir, name: "Counted" });

    const reply = await ask(2, { type: "library:stats" });

    // Every field of the wire shape, present and a number. A spread of the
    // engine's own `Stats` would pass a field this contract never declared, and
    // the two types are allowed to differ (ADR-0007).
    expect(reply?.ok).toBe(true);
    const value = (reply as { value: Record<string, unknown> }).value;
    expect(Object.keys(value).sort()).toEqual(
      [
        "assets",
        "favorites",
        "folders",
        "managed",
        "notes",
        "partialHashes",
        "rated",
        "referenced",
        "smartFolders",
        "tagGroups",
        "tags",
        "thumbnails",
        "totalBytes",
        "trashed",
      ].sort(),
    );
    expect(value["assets"]).toBe(0);
  });
});
