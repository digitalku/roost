import { mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReplyEnvelope, Request } from "@roost/contract";
import { LIBRARY_SUFFIX as WIRE_SUFFIX } from "@roost/contract";
import { LIBRARY_SUFFIX } from "@roost/library";
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
    for (let tick = 0; tick < 50 && this.sent.length === before; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return this.sent[before] as ReplyEnvelope | undefined;
  }
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
        schemaVersion: 5,
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
      ].sort(),
    );
    expect(value["assets"]).toBe(0);
  });
});
