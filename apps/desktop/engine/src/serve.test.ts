import { mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReplyEnvelope, Request } from "@roost/contract";
import { ASSET_KINDS as WIRE_KINDS, LIBRARY_SUFFIX as WIRE_SUFFIX } from "@roost/contract";
import { KINDS, latestSchemaVersion } from "@roost/core";
import { createFolder, importInto, LIBRARY_SUFFIX, Library, runDerives } from "@roost/library";
import { GRID_SIZE, gradient } from "@roost/media";
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

  /**
   * Delivers a message as Electron would, and waits for the reply.
   *
   * **The budget depends on what is expected**, and that distinction is not
   * decoration. A request that will be answered gets a long one and **throws**
   * if nothing arrives — a timeout here used to return `undefined`, the caller
   * read the index anyway, and the assertion failed against the value from
   * *before* the edit, which reads like a broken write rather than a slow one.
   * It cost a real diagnosis on 2026-09-05, under a full-suite run where a disk
   * write took longer than the 100ms the old loop allowed.
   *
   * `silence` is the other case, and it keeps the short budget deliberately:
   * those tests assert that nothing is ever sent, so the wait is pure cost and
   * a generous one would be paid on every run.
   */
  async deliver(
    data: unknown,
    expecting: "reply" | "silence" = "reply",
  ): Promise<ReplyEnvelope | undefined> {
    const before = this.sent.length;
    this.#listener?.({ data });
    // The handler is async; one macrotask is enough for a reply that never
    // touches the disk, and the loop covers the ones that do.
    const ticks = expecting === "silence" ? 50 : 1000;
    for (let tick = 0; tick < ticks && this.replies(before).length === 0; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const reply = this.replies(before)[0];
    if (reply === undefined && expecting === "reply") {
      throw new Error(`no reply within ${ticks * 2}ms for ${JSON.stringify(data)}`);
    }
    return reply;
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

  const ask = async (
    id: number,
    request: Request,
    expecting: "reply" | "silence" = "reply",
  ): Promise<ReplyEnvelope | undefined> => port.deliver({ id, request }, expecting);

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
        formatVersion: 2,
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
    // discards the subclass, so a bare Error would arrive without it. `dir` is
    // there and holds no library, which is the error this asserts; a path that
    // is not there at all is a different code, below.
    const reply = await ask(3, { type: "library:open", path: dir });

    expect(reply).toEqual({
      id: 3,
      ok: false,
      problem: {
        code: "not_a_library",
        message: expect.stringContaining("not a Roost library"),
        detail: { path: dir, reason: "no library.json" },
      },
    });
  });

  it("tells a path that is gone from a directory that is not a library", async () => {
    // The picker's recent list is where this lands: a library on a drive that
    // is not mounted is not damaged, and saying it holds no library.json sends
    // the reader looking for damage that is not there.
    const gone = join(dir, "not-a-library");
    const reply = await ask(4, { type: "library:open", path: gone });

    expect(reply).toEqual({
      id: 4,
      ok: false,
      problem: {
        code: "library_not_found",
        message: expect.stringContaining("is not there"),
        detail: { path: gone },
      },
    });
  });

  it("drops a message that is not a request, without answering it", async () => {
    // Nothing can be replied to: a message this malformed may not carry the id
    // an answer would have to be addressed to.
    for (const message of [null, 7, { id: 1 }, { id: 1, request: { type: "library:eat" } }]) {
      expect(await port.deliver(message, "silence")).toBeUndefined();
    }
  });

  // Linux's, because {@link openFilesUnder} reads `/proc/self/fd` and nothing
  // portable answers that question. The closing it checks for is every
  // platform's — and on Windows an index left open is louder, not quieter,
  // since the file cannot then be unlinked.
  it.runIf(process.platform === "linux")(
    "holds one library at a time, and lets go of the one it replaced",
    async () => {
      const first = join(dir, "First.roost");
      const second = join(dir, "Second.roost");
      await ask(1, { type: "library:create", parent: dir, name: "First" });
      expect(await openFilesUnder(first)).not.toEqual([]);

      await ask(2, { type: "library:create", parent: dir, name: "Second" });

      expect(await ask(3, { type: "library:current" })).toMatchObject({
        ok: true,
        value: { root: second, name: "Second" },
      });
      // Not the lock, which is re-entrant within one process by design — the
      // file handles. A library kept open holds its index and its journal, and
      // the journal buffers, so "replaced" has to mean closed rather than
      // forgotten.
      expect(await openFilesUnder(first)).toEqual([]);
    },
  );

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

  it("moves assets into another library and keeps its own open (ADR-0054)", async () => {
    await libraryOf(3);
    const target = join(dir, `Target${LIBRARY_SUFFIX}`);
    await (await Library.create(target, "Target")).close();
    const page = (await ask(1, {
      type: "assets:page",
      query: "",
      limit: 10,
      after: null,
      sort: null,
    })) as { value: { assets: { id: string }[] } };
    const moving = page.value.assets.slice(0, 2).map((asset) => asset.id);

    const reply = await ask(2, { type: "assets:transfer", ids: moving, target, take: "move" });

    expect(reply).toMatchObject({
      ok: true,
      value: { added: 2, removed: 2, failed: 0, cancelled: false },
    });
    // The last word on progress is never throttled away, so a bar reaches the end.
    const events = port.sent
      .map((message) => (message as { event?: { type: string } }).event)
      .filter((event) => event?.type === "transfer:progress");
    expect(events.at(-1)).toMatchObject({ done: 2, total: 2 });
    expect(await ask(3, { type: "assets:count", query: "" })).toMatchObject({ value: 1 });
    // The target was opened for the call and closed after it: this process
    // still has the library it had, and the target opens anywhere.
    expect(await ask(4, { type: "library:current" })).toMatchObject({
      value: { name: "Paged" },
    });
    const opened = await Library.open(target, { exclusive: true });
    try {
      expect(opened.db.repo.allIds()).toHaveLength(2);
    } finally {
      await opened.close();
    }
  });

  it("takes one transfer at a time", async () => {
    await libraryOf(4);
    const target = join(dir, `Target${LIBRARY_SUFFIX}`);
    await (await Library.create(target, "Target")).close();
    const page = (await ask(1, {
      type: "assets:page",
      query: "",
      limit: 10,
      after: null,
      sort: null,
    })) as { value: { assets: { id: string }[] } };
    const [first, second] = page.value.assets.map((asset) => asset.id);

    // Both sent before either is answered: the second arrives while the first
    // holds the target open in this process, where its lock cannot see it.
    await Promise.all([
      ask(2, { type: "assets:transfer", ids: [first ?? ""], target, take: "copy" }),
      ask(3, { type: "assets:transfer", ids: [second ?? ""], target, take: "copy" }),
    ]);
    // By id, because `deliver` hands back whichever reply came first.
    const replyTo = async (id: number): Promise<ReplyEnvelope | undefined> => {
      for (let tick = 0; tick < 1000; tick += 1) {
        const found = port.replies().find((reply) => reply.id === id);
        if (found !== undefined) return found;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return undefined;
    };

    expect(await replyTo(2)).toMatchObject({ ok: true });
    expect(await replyTo(3)).toMatchObject({ ok: false, problem: { code: "transfer_running" } });
  });

  it("says there was nothing to stop when no transfer is running", async () => {
    expect(await ask(1, { type: "assets:transferCancel" })).toMatchObject({
      ok: true,
      value: false,
    });
  });

  it("pauses the queue, remembers it, and still draws a file somebody opens", async () => {
    // ADR-0049: × stops the queue until Resume, the library remembers it, and
    // a file opened meanwhile gets its thumbnail on the spot.
    const source = join(dir, "pictures");
    await mkdir(source, { recursive: true });
    for (const n of [1, 2, 3]) {
      await writeFile(join(source, `picture-${n}.png`), await gradient(64, 48, n, "png"));
    }
    const root = join(dir, `Paused${LIBRARY_SUFFIX}`);
    const made = await Library.create(root, "Paused");
    let ids: string[];
    try {
      ids = (await importInto(made, [source])).importedIds;
      await made.updateSettings({ derivePaused: true });
    } finally {
      await made.close();
    }

    const thumbnails = async (): Promise<number> =>
      ((await ask(90, { type: "library:stats" })) as { value: { thumbnails: number } }).value
        .thumbnails;
    const until = async (done: () => Promise<boolean>): Promise<void> => {
      for (let tries = 0; tries < 100 && !(await done()); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

    await ask(1, { type: "library:open", path: root });
    expect(await ask(2, { type: "derive:status" })).toMatchObject({
      value: { paused: true, ready: 3 },
    });
    // Opening a paused library derives nothing on its own.
    await settle();
    expect(await thumbnails()).toBe(0);

    // Opened: that one, and only that one.
    await ask(3, { type: "asset:detail", id: ids[0] ?? "" });
    await until(async () => (await thumbnails()) === 1);
    await settle();
    expect(await thumbnails()).toBe(1);

    expect(await ask(4, { type: "derive:resume" })).toMatchObject({ value: { paused: false } });
    await until(async () => (await thumbnails()) === 3);
    expect(await thumbnails()).toBe(3);
    const settings = async (): Promise<unknown> =>
      JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    expect(await settings()).toMatchObject({ derivePaused: false });

    expect(await ask(5, { type: "derive:pause" })).toMatchObject({ value: { paused: true } });
    expect(await settings()).toMatchObject({ derivePaused: true });

    // An import is somebody asking for these files now, paused or not.
    const more = join(dir, "more");
    await mkdir(more);
    await writeFile(join(more, "picture-4.png"), await gradient(64, 48, 4, "png"));
    await ask(6, { type: "import:paths", paths: [more], take: "copy", tags: [], folder: null });
    expect(await thumbnails()).toBe(4);
  });

  it("names the pictures a folder's tile draws, and never sends them", async () => {
    // ADR-0043 §7: ids and the parts of an address; the bytes go over roost://.
    const source = join(dir, "covers");
    await mkdir(source, { recursive: true });
    for (const n of [1, 2]) {
      await writeFile(join(source, `picture-${n}.png`), await gradient(32, 32, n, "png"));
    }
    const root = join(dir, `Covers${LIBRARY_SUFFIX}`);
    const made = await Library.create(root, "Covers");
    let folder: number;
    try {
      folder = await createFolder(made, "Design", null);
      await importInto(made, [source], { folder });
      await runDerives(made, { sizes: [GRID_SIZE] });
    } finally {
      await made.close();
    }
    await ask(1, { type: "library:open", path: root });

    const reply = await ask(2, { type: "folder:covers", folders: [folder] });
    const [cover] = (reply as { value: { folder: number; assets: Record<string, unknown>[] }[] })
      .value;
    expect(cover?.folder).toBe(folder);
    expect(cover?.assets).toHaveLength(2);
    expect(Object.keys(cover?.assets[0] ?? {}).sort()).toEqual(["derivedAt", "id", "posterMs"]);
  });

  it("tries one file again, even with the queue paused", async () => {
    // ADR-0050: the per-file Try again, from the inspector or the preview.
    const source = join(dir, "torn");
    await mkdir(source, { recursive: true });
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(join(source, "torn.png"), Buffer.concat([header, Buffer.alloc(64)]));
    const root = join(dir, `Torn${LIBRARY_SUFFIX}`);
    const made = await Library.create(root, "Torn");
    let id: string;
    try {
      id = (await importInto(made, [source])).importedIds[0] ?? "";
    } finally {
      await made.close();
    }
    await ask(1, { type: "library:open", path: root });
    const failed = async (): Promise<number> =>
      ((await ask(90, { type: "derive:status" })) as { value: { failed: number } }).value.failed;
    for (let tries = 0; tries < 100 && (await failed()) === 0; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await failed()).toBe(1);
    await ask(2, { type: "derive:pause" });

    // Released and tried at once; still damaged, so it fails again — and the
    // attempt is what the answer and the count say happened.
    expect(await ask(3, { type: "derive:retryAsset", id })).toMatchObject({ value: true });
    for (let tries = 0; tries < 100 && (await failed()) === 0; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await failed()).toBe(1);
    // An id with nothing stalled has nothing to release.
    expect(await ask(4, { type: "derive:retryAsset", id: "ZZZZZZZZZZZZ" })).toMatchObject({
      value: false,
    });
  });

  const pageOfHits = (reply: ReplyEnvelope | undefined): { names: string[]; next: unknown } => {
    const value = (reply as { value: { assets: { name: string }[]; next: unknown } }).value;
    return { names: value.assets.map((a) => a.name), next: value.next };
  };

  it("pages the grid by cursor, and says when there is no next page", async () => {
    await libraryOf(5);

    const first = await ask(1, {
      type: "assets:page",
      query: "",
      limit: 2,
      after: null,
      sort: null,
    });
    const firstPage = pageOfHits(first);
    expect(firstPage.names).toHaveLength(2);
    expect(firstPage.next).not.toBeNull();

    const second = await ask(2, {
      type: "assets:page",
      query: "",
      limit: 2,
      after: firstPage.next as { key: number; id: string },
      sort: null,
    });
    const secondPage = pageOfHits(second);
    expect(secondPage.names).toHaveLength(2);
    // No overlap: a cursor resumes after the last row, it does not repeat it.
    expect(new Set([...firstPage.names, ...secondPage.names]).size).toBe(4);

    const third = await ask(3, {
      type: "assets:page",
      query: "",
      limit: 2,
      after: secondPage.next as { key: number; id: string },
      sort: null,
    });
    // A short page is the last page, and saying so saves the grid a round trip
    // that would only confirm what the row count already said.
    expect(pageOfHits(third)).toEqual({ names: expect.any(Array), next: null });
    expect(pageOfHits(third).names).toHaveLength(1);
  });

  it("sends the grid only the fields a cell draws, and never bytes", async () => {
    await libraryOf(1);
    const reply = await ask(1, {
      type: "assets:page",
      query: "",
      limit: 1,
      after: null,
      sort: null,
    });
    const [card] = (reply as { value: { assets: Record<string, unknown>[] } }).value.assets;

    // Invariant 12: a thumbnail reaches the window over `roost://`, never in a
    // message. A field added here that carried bytes would pass every other
    // test in this file.
    expect(Object.keys(card ?? {}).sort()).toEqual([
      // Part of the thumbnail's address rather than something a cell draws,
      // and the reason an externally edited file redraws (ADR-0047).
      "derivedAt",
      "ext",
      "height",
      "id",
      "importedAt",
      "kind",
      "name",
      "posterMs",
      "rating",
      "size",
      // Why there is no picture, in the queue's words: a string or null, and
      // never the picture (`UI_SPEC.md` §6.1).
      "undrawn",
      "width",
    ]);
  });

  it("treats an empty query as the whole library and RQL as a filter", async () => {
    await libraryOf(3);

    const all = await ask(1, {
      type: "assets:page",
      query: "",
      limit: 10,
      after: null,
      sort: null,
    });
    expect(pageOfHits(all).names).toHaveLength(3);

    const txt = await ask(2, {
      type: "assets:page",
      query: "ext:txt",
      limit: 10,
      after: null,
      sort: null,
    });
    expect(pageOfHits(txt).names).toHaveLength(3);

    const none = await ask(3, {
      type: "assets:page",
      query: "ext:png",
      limit: 10,
      after: null,
      sort: null,
    });
    expect(pageOfHits(none)).toEqual({ names: [], next: null });
  });

  it("answers a malformed query with the parse error rather than an empty grid", async () => {
    await libraryOf(1);
    // An empty grid would look like a library with nothing in it. The search
    // field needs to be able to say where the query went wrong.
    const reply = await ask(1, {
      type: "assets:page",
      query: "rating:>>",
      limit: 10,
      after: null,
      sort: null,
    });
    expect(reply?.ok).toBe(false);
  });

  it("gives every sidebar row the query that selects it", async () => {
    await libraryOf(1);
    const reply = await ask(1, { type: "library:sidebar" });
    const value = (
      reply as { value: Record<string, { query: string; name: string; stars: number | null }[]> }
    ).value;

    expect(Object.keys(value).sort()).toEqual([
      "folders",
      "places",
      "ratings",
      "smartFolders",
      "tags",
      "types",
    ]);
    // `UI_SPEC.md` §4.1: the renderer never assembles RQL, so a row without a
    // query is a row it cannot act on. **Except the types**, which are the one
    // vocabulary here that is not a row: a facet value is `OR`ed with whatever
    // is ticked beside it, so what selects it depends on the rest of the bar
    // and no single entry could carry it (ADR-0035).
    for (const [section, rows] of Object.entries(value)) {
      if (section === "types") continue;
      for (const row of rows) expect(typeof row.query).toBe("string");
    }

    const places = value["places"] ?? [];
    expect(places.map((place) => place.name)).toEqual([
      "All assets",
      "Recent",
      "Untagged",
      "Trash",
    ]);

    // A section of its own, under Places, with one row per star — and each
    // matches *that* rating rather than "this many and up": five nested rows
    // would have counts adding up to more than the library holds, and
    // `rating:>=4` is one term in the search field for the other question.
    const ratings = value["ratings"] ?? [];
    expect(ratings.map((row) => row.name)).toEqual([
      "5 stars",
      "4 stars",
      "3 stars",
      "2 stars",
      "1 star",
      "No stars",
    ]);
    expect(ratings[1]?.query).toBe("rating:4");
    // Unrated is last and is not a rating of zero: the schema has no zero, so
    // the row carries `is:unrated`. It draws no filled stars, which is what
    // `stars: 0` means — the count of what to light, not a rating.
    expect(ratings[5]?.query).toBe("is:unrated");
    expect(ratings.map((row) => row.stars)).toEqual([5, 4, 3, 2, 1, 0]);
    // "All assets" is the empty string — the engine's word for the whole
    // library — and not a term in the grammar.
    expect(places[0]?.query).toBe("");
    expect(places[2]?.query).toBe("is:untagged");
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
        sort: null,
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
    const page = await ask(1, {
      type: "assets:page",
      query: "",
      limit: 1,
      after: null,
      sort: null,
    });
    const id = (page as { value: { assets: { id: string }[] } }).value.assets[0]?.id ?? "";

    const reply = await ask(2, { type: "asset:detail", id });
    const value = (reply as { value: Record<string, unknown> }).value;

    // Every field of the wire shape, and no field the contract never declared:
    // the two types are allowed to differ, and this is the place that notices.
    expect(Object.keys(value).sort()).toEqual(
      [
        // Whether the pane may load the file into an `<img>` (ADR-0040 §7).
        "browserDrawable",
        "comments",
        "createdAt",
        "durationMs",
        "ext",
        "kind",
        "folders",
        "id",
        "height",
        "importedAt",
        "contentHash",
        "derivedAt",
        "name",
        "note",
        "pageCount",
        "posterMs",
        "props",
        "rating",
        "size",
        "sourceUrl",
        "subtitles",
        "tags",
        "trashedAt",
        "undrawn",
        "width",
      ].sort(),
    );
    expect(value["rating"]).toBeNull();
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
    const reply = await ask(1, { type: "asset:detail", id: "FFFFFFFFFFFF" });
    expect(reply).toEqual({ id: 1, ok: true, value: null });
  });

  it("applies each edit and lets the reader see what the engine made of it", async () => {
    await libraryOf(1);
    const page = await ask(1, {
      type: "assets:page",
      query: "",
      limit: 1,
      after: null,
      sort: null,
    });
    const id = (page as { value: { assets: { id: string }[] } }).value.assets[0]?.id ?? "";
    const detail = async (): Promise<Record<string, unknown>> => {
      const reply = await ask(99, { type: "asset:detail", id });
      return (reply as { value: Record<string, unknown> }).value;
    };

    expect(await ask(2, { type: "asset:rate", ids: [id], rating: 4 })).toMatchObject({
      ok: true,
      value: null,
    });
    expect((await detail())["rating"]).toBe(4);

    // The engine drops an all-whitespace note rather than storing one: a note
    // badge that is on forever and says nothing is worse than no badge.
    await ask(4, { type: "asset:note", ids: [id], note: "   " });
    expect((await detail())["note"]).toBeNull();
    await ask(5, { type: "asset:note", ids: [id], note: "  keep this  " });
    expect((await detail())["note"]).toBe("keep this");

    // A source follows the note's rule exactly (ADR-0030): trimmed, and blank
    // means absent. What it does *not* do is validate — the value is the
    // user's answer to a question, not an address the engine vouches for.
    await ask(6, { type: "asset:source", ids: [id], url: "  instagram.com/p/xyz  " });
    expect((await detail())["sourceUrl"]).toBe("instagram.com/p/xyz");
    await ask(7, { type: "asset:source", ids: [id], url: "  " });
    expect((await detail())["sourceUrl"]).toBeNull();

    await ask(8, { type: "asset:tagAdd", ids: [id], tags: ["Wood", " wood "] });
    // Deduplicated and trimmed on the way through, which is exactly why an
    // edit answers with `null` and the inspector re-reads.
    expect((await detail())["tags"]).toEqual(["Wood"]);

    await ask(9, { type: "asset:tagRemove", ids: [id], tags: ["wood"] });
    expect((await detail())["tags"]).toEqual([]);

    await ask(10, { type: "asset:rename", id, name: "  Renamed.txt  " });
    expect((await detail())["name"]).toBe("Renamed.txt");
  });

  it("files an asset and unfiles it, naming the folder by id", async () => {
    // The pair the inspector's chips send. By id and never by path: folder
    // names are unique only among siblings, and a library written before the
    // rule can hold one with a `/` in it.
    const source = join(dir, "filed");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "poster.txt"), "poster");
    const root = join(dir, `Filed${LIBRARY_SUFFIX}`);
    const library = await Library.create(root, "Filed");
    let nested = 0;
    try {
      await importInto(library, [source]);
      const design = await createFolder(library, "Design", null);
      nested = await createFolder(library, "Icons", design);
    } finally {
      await library.close();
    }
    await ask(100, { type: "library:open", path: root });

    const page = await ask(1, {
      type: "assets:page",
      query: "",
      limit: 1,
      after: null,
      sort: null,
    });
    const id = (page as { value: { assets: { id: string }[] } }).value.assets[0]?.id ?? "";
    const folders = async (): Promise<unknown> => {
      const reply = await ask(99, { type: "asset:detail", id });
      return (reply as { value: { folders: unknown } }).value.folders;
    };

    expect(await folders()).toEqual([]);

    await ask(2, { type: "asset:folderAdd", ids: [id], folder: nested });
    // The whole path, walked here rather than by the window: the window draws
    // it and would have had to hold the tree to build it.
    expect(await folders()).toEqual([{ id: nested, path: "Design/Icons" }]);

    // Adding it twice is not an error and not a second membership.
    await ask(3, { type: "asset:folderAdd", ids: [id], folder: nested });
    expect(await folders()).toEqual([{ id: nested, path: "Design/Icons" }]);

    await ask(4, { type: "asset:folderRemove", ids: [id], folder: nested });
    expect(await folders()).toEqual([]);

    // The asset itself is untouched: a folder is a collection, not a location.
    const after = await ask(5, {
      type: "assets:page",
      query: "",
      limit: 1,
      after: null,
      sort: null,
    });
    expect((after as { value: { assets: unknown[] } }).value.assets).toHaveLength(1);
  });

  it("makes, renames and deletes a folder, and says what the delete did", async () => {
    const source = join(dir, "shelved");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "logo.txt"), "logo");
    const root = join(dir, `Shelved${LIBRARY_SUFFIX}`);
    const library = await Library.create(root, "Shelved");
    try {
      await importInto(library, [source]);
    } finally {
      await library.close();
    }
    await ask(100, { type: "library:open", path: root });

    const page = await ask(1, {
      type: "assets:page",
      query: "",
      limit: 1,
      after: null,
      sort: null,
    });
    const id = (page as { value: { assets: { id: string }[] } }).value.assets[0]?.id ?? "";

    const made = await ask(2, { type: "folder:create", name: "Design", parent: null });
    const design = (made as { value: number }).value;
    const nested = await ask(3, { type: "folder:create", name: "Icons", parent: design });
    const icons = (nested as { value: number }).value;
    await ask(4, { type: "asset:folderAdd", ids: [id], folder: icons });

    await ask(5, { type: "folder:rename", folder: icons, name: "Marks" });
    const sidebar = await ask(6, { type: "library:sidebar" });
    const rows = (sidebar as { value: { folders: { path: string; folder: number }[] } }).value
      .folders;
    // Depth-first, so a row is followed by its own subtree — and the renamed
    // child carries the new path, not a stale one.
    expect(rows.map((row) => row.path)).toEqual(["Design", "Design/Marks"]);

    // The default leaves the asset alone; only its membership goes.
    const kept = await ask(7, { type: "folder:delete", folder: design, trashContents: false });
    expect(kept).toMatchObject({ value: { trashed: 0 } });
    const detail = await ask(8, { type: "asset:detail", id });
    expect(detail).toMatchObject({ value: { trashedAt: null, folders: [] } });

    const again = await ask(9, { type: "folder:create", name: "Gone", parent: null });
    await ask(10, {
      type: "asset:folderAdd",
      ids: [id],
      folder: (again as { value: number }).value,
    });
    const taken = await ask(11, {
      type: "folder:delete",
      folder: (again as { value: number }).value,
      trashContents: true,
    });
    expect(taken).toMatchObject({ value: { trashed: 1 } });
    // Trashed, not removed: the row is still there, with a date on it.
    const after = await ask(12, { type: "asset:detail", id });
    expect((after as { value: { trashedAt: number | null } }).value.trashedAt).not.toBeNull();
  });

  it("carries comments on the asset they are about, in timeline order", async () => {
    await libraryOf(1);
    const page = await ask(1, {
      type: "assets:page",
      query: "",
      limit: 1,
      after: null,
      sort: null,
    });
    const asset = (page as { value: { assets: { id: string }[] } }).value.assets[0]?.id ?? "";
    const comments = async (): Promise<Record<string, unknown>[]> => {
      const reply = await ask(99, { type: "asset:detail", id: asset });
      return (reply as { value: { comments: Record<string, unknown>[] } }).value.comments;
    };

    // Written out of order on purpose: the list is a timeline, not a log of
    // when somebody typed.
    await ask(2, { type: "comment:add", asset, atMs: 120_000, body: "  later  " });
    await ask(3, { type: "comment:add", asset, atMs: null, body: "about the file" });
    await ask(4, { type: "comment:add", asset, atMs: 1_000, body: "earlier" });

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
    const comment = idOf((await comments())[0]);
    await ask(5, { type: "comment:set", id: comment, atMs: 2_000, body: "earlier still" });
    // The same comment, moved: an edit that removed and re-added would mint a
    // second id and put it at the end of the list.
    expect((await comments())[0]).toMatchObject({
      id: comment,
      atMs: 2_000,
      body: "earlier still",
    });
    expect(await comments()).toHaveLength(3);

    await ask(6, { type: "comment:remove", id: comment });
    expect((await comments()).map((row) => row["id"])).not.toContain(comment);
  });

  it("refuses a comment the format cannot hold", async () => {
    await libraryOf(1);
    const page = await ask(1, {
      type: "assets:page",
      query: "",
      limit: 1,
      after: null,
      sort: null,
    });
    const asset = (page as { value: { assets: { id: string }[] } }).value.assets[0]?.id ?? "";

    // Refused by the contract before the engine is asked, and therefore
    // **dropped rather than answered** — the same rule every malformed message
    // follows here (`serve.ts`). A body with nothing in it is a comment that
    // says nothing, and a negative offset is a number that cannot mean
    // anything; both are the validator's, and `contract.test.ts` pins them.
    expect(
      await ask(2, { type: "comment:add", asset, atMs: null, body: "  " }, "silence"),
    ).toBeUndefined();
    expect(
      await ask(3, { type: "comment:add", asset, atMs: -1, body: "x" }, "silence"),
    ).toBeUndefined();
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
    const page = await ask(1, {
      type: "assets:page",
      query: "",
      limit: 1,
      after: null,
      sort: null,
    });
    const id = (page as { value: { assets: { id: string }[] } }).value.assets[0]?.id ?? "";

    const reply = await ask(2, { type: "asset:rate", ids: [id], rating: 9 });
    expect(reply).toMatchObject({ ok: false, problem: { code: "invalid_rating" } });
  });

  it("announces that the library changed, once per edit", async () => {
    await libraryOf(1);
    const page = await ask(1, {
      type: "assets:page",
      query: "",
      limit: 1,
      after: null,
      sort: null,
    });
    const id = (page as { value: { assets: { id: string }[] } }).value.assets[0]?.id ?? "";

    const events = (): unknown[] =>
      port.sent.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "event" in message &&
          (message as { event: { type: string } }).event.type === "library:changed",
      );
    const before = events().length;

    await ask(2, { type: "asset:rate", ids: [id], rating: 3 });

    // Everything derived — the counts, the sidebar, the grid — is re-read from
    // this. An edit that changed the library silently would leave all three
    // showing the state before it.
    expect(events().length).toBe(before + 1);
  });

  it("refuses to open a file itself, because it has no desktop", async () => {
    await libraryOf(1);
    const reply = await ask(1, { type: "asset:openExternally", id: "AAAAAAAAAAAA" });
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
      folder: null,
      paths: [source],
      take: "copy",
      tags: [],
    });
    const report = (reply as { value: Record<string, unknown> }).value;

    // The timings are dropped on purpose: they are a benchmark's business, and
    // a window that showed them would invite reading one run as a measurement.
    expect(Object.keys(report).sort()).toEqual(
      [
        "bytes",
        "duplicateNames",
        "duplicates",
        "elapsedMs",
        "failed",
        "imported",
        "moved",
        "copied",
        "scanned",
        "subtitles",
        "subtitlesUnattached",
        "thumbnails",
      ].sort(),
    );
    expect(report["imported"]).toBe(3);
    expect(report["failed"]).toEqual([]);

    // Re-importing is the ordinary case, not a failure: identical bytes have
    // one address (RL-11).
    const again = await ask(3, {
      type: "import:paths",
      folder: null,
      paths: [source],
      take: "copy",
      tags: [],
    });
    expect((again as { value: Record<string, unknown> }).value).toMatchObject({
      imported: 0,
      duplicates: 3,
    });
  });

  it("imports into a folder, and files the duplicates only when asked", async () => {
    // ADR-0037, end to end: the run lands where the window was looking, a file
    // already here does not, and the second question is answered afterwards.
    const source = join(dir, "landing");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "one.txt"), "one");
    const root = join(dir, `Landed${LIBRARY_SUFFIX}`);
    const library = await Library.create(root, "Landed");
    await library.close();
    await ask(1, { type: "library:open", path: root });

    const made = await ask(2, { type: "folder:create", name: "Design", parent: null });
    const folder = (made as { value: number }).value;

    await ask(3, { type: "import:paths", paths: [source], take: "copy", tags: [], folder });
    expect(
      (await ask(4, { type: "assets:count", query: "folder:Design" })) as unknown,
    ).toMatchObject({ value: 1 });

    // The same file again, with no folder: a duplicate, and it joins nothing.
    const again = await ask(5, {
      type: "import:paths",
      paths: [source],
      take: "copy",
      tags: [],
      folder: null,
    });
    const report = (again as { value: Record<string, unknown> }).value;
    expect(report["duplicates"]).toBe(1);
    expect(report["duplicateNames"]).toEqual(["one.txt"]);

    // And now the answer to the pop-up. The hashes are never sent: the engine
    // kept the list the run reported.
    const other = await ask(6, { type: "folder:create", name: "Later", parent: null });
    const filed = await ask(7, {
      type: "import:fileDuplicates",
      folder: (other as { value: number }).value,
    });
    expect((filed as { value: unknown }).value).toEqual({ filed: 1, expired: false });
    expect(
      (await ask(8, { type: "assets:count", query: "folder:Later" })) as unknown,
    ).toMatchObject({ value: 1 });
    // An add, not a move: it is still in the folder it was imported into.
    expect(
      (await ask(9, { type: "assets:count", query: "folder:Design" })) as unknown,
    ).toMatchObject({ value: 1 });
  });

  it("has nothing to file before an import has run", async () => {
    // A dialog left open across a library change is answered honestly rather
    // than with a zero that reads like "they were already there".
    await ask(1, { type: "library:create", parent: dir, name: "Fresh" });
    const made = await ask(2, { type: "folder:create", name: "Design", parent: null });

    const filed = await ask(3, {
      type: "import:fileDuplicates",
      folder: (made as { value: number }).value,
    });

    expect((filed as { value: unknown }).value).toEqual({ filed: 0, expired: true });
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

    await ask(2, {
      type: "import:paths",
      folder: null,
      paths: [source],
      take: "copy",
      tags: [],
    });

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
    const reply = await ask(1, { type: "dialog:chooseImport", what: "files" });
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
        "folders",
        "notes",
        "rated",
        "smartFolders",
        "tagGroups",
        "tags",
        "thumbnails",
        "totalBytes",
        "trashed",
        "underived",
      ].sort(),
    );
    expect(value["assets"]).toBe(0);
  });
});
