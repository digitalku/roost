import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request as ContractRequest } from "@roost/contract";
import { isLocalAddress, LibrarySharing, type SharedLibrary } from "@roost/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Sharing a library with a phone (ADR-0072), over real HTTP on loopback.
 *
 * The host stands in for main: it answers requests by echoing them, serves one
 * picture, and knows one password. What is under test is everything between a
 * phone and those four doors.
 */

let dir: string;
let root: string;
let sharing: LibrarySharing;
let answered: ContractRequest[];
let bytesAsked: string[];
let base: string;

const library = (hasPassword = true): SharedLibrary => ({
  root,
  id: "7b2e9c41-5d3a-4f86-9e10-c4a8b6d2f053",
  name: "pribadi",
  hasPassword,
});

async function writeManifest(hash: string | null): Promise<void> {
  await writeFile(
    join(root, "library.json"),
    JSON.stringify({
      roost_library_version: hash === null ? 2 : 3,
      id: "7b2e9c41-5d3a-4f86-9e10-c4a8b6d2f053",
      name: "pribadi",
      created_at: 1767225600,
      ...(hash === null ? {} : { password: { kdf: "scrypt", hash } }),
    }),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "roost-server-"));
  root = join(dir, "pribadi.roost");
  await rm(root, { recursive: true, force: true });
  await (await import("node:fs/promises")).mkdir(root);
  await writeManifest("a".repeat(64));
  answered = [];
  bytesAsked = [];
  sharing = new LibrarySharing(
    {
      build: "test",
      answer: async (request) => {
        answered.push(request);
        return { ok: true, value: { echoed: request.type } };
      },
      bytes: async (request) => {
        bytesAsked.push(`${request.url} ${request.headers.get("range") ?? ""}`);
        return new Response("PICTURE", { status: 200, headers: { "content-type": "image/webp" } });
      },
      checkPassword: async (password) => password === "secret",
    },
    { stateDir: join(dir, "state"), port: 0, now: () => 1_800_000_000 },
  );
});

afterEach(async () => {
  await sharing.stop();
  await rm(dir, { recursive: true, force: true });
});

async function start(): Promise<void> {
  await sharing.follow(library());
  const status = await sharing.share(true);
  expect(status.listening).toBe(true);
  base = `http://127.0.0.1:${status.port}`;
}

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

async function pair(): Promise<string> {
  const answer = await post("/api/1/pair", { password: "secret", device: "Pixel" });
  expect(answer.status).toBe(200);
  const body = (await answer.json()) as { token: string };
  return body.token;
}

describe("when it listens", () => {
  it("listens only while a library with a password is open and its box is ticked", async () => {
    expect((await sharing.status()).listening).toBe(false);
    await sharing.follow(library());
    expect((await sharing.status()).listening).toBe(false);

    const ticked = await sharing.share(true);
    expect(ticked.listening).toBe(true);
    expect(ticked.sharing).toBe(true);

    // A library without a password is not shared, however the box is.
    expect((await sharing.follow(library(false))).listening).toBe(false);
    expect((await sharing.follow(library())).listening).toBe(true);

    // Closed: nothing listens, and the box stays ticked for next time.
    expect((await sharing.follow(undefined)).listening).toBe(false);
    expect((await sharing.follow(library())).listening).toBe(true);
    expect((await sharing.share(false)).listening).toBe(false);
  });

  it("remembers the box for the library, on this machine and outside the library", async () => {
    await start();
    await sharing.stop();
    const again = new LibrarySharing(
      {
        build: "test",
        answer: async () => ({ ok: true, value: null }),
        bytes: async () => new Response(null, { status: 404 }),
        checkPassword: async () => false,
      },
      { stateDir: join(dir, "state"), port: 0 },
    );
    try {
      expect((await again.follow(library())).listening).toBe(true);
    } finally {
      await again.stop();
    }
  });
});

describe("pairing", () => {
  it("says hello to anyone, and lets in only a device that gave the password", async () => {
    await start();
    const hello = (await (await fetch(`${base}/api/1/hello`)).json()) as Record<string, unknown>;
    expect(hello).toEqual({
      api: 1,
      build: "test",
      library: { id: "7b2e9c41-5d3a-4f86-9e10-c4a8b6d2f053", name: "pribadi" },
    });

    const refused = await post("/api/1/request", { type: "library:stats" });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ ok: false, problem: { code: "not_paired" } });

    const wrong = await post("/api/1/pair", { password: "guess", device: "Pixel" });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ problem: { code: "password_wrong" } });

    const token = await pair();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const answered = await post("/api/1/request", { type: "library:stats" }, token);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ ok: true, value: { echoed: "library:stats" } });
  });

  it("keeps only a hash of the token, and lists the device", async () => {
    await start();
    const token = await pair();
    const status = await sharing.status();
    expect(status.devices).toEqual([
      { id: expect.any(String), name: "Pixel", pairedAt: 1_800_000_000, lastSeen: null },
    ]);
    const files = await (await import("node:fs/promises")).readdir(join(dir, "state", "remote"));
    const stored = await readFile(join(dir, "state", "remote", files[0] ?? ""), "utf8");
    expect(stored).not.toContain(token);
    expect(stored).not.toContain("secret");
  });

  it("refuses an address after five wrong passwords in a minute", async () => {
    await start();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await post("/api/1/pair", { password: "guess", device: "x" })).status).toBe(403);
    }
    const blocked = await post("/api/1/pair", { password: "secret", device: "x" });
    expect(blocked.status).toBe(429);
  });

  it("unpairs every device when the password changes, and one device when asked", async () => {
    await start();
    const first = await pair();
    const second = await pair();
    const [one] = (await sharing.status()).devices;

    await sharing.revoke(one?.id ?? "");
    expect((await post("/api/1/request", { type: "library:stats" }, first)).status).toBe(401);
    expect((await post("/api/1/request", { type: "library:stats" }, second)).status).toBe(200);

    // Changed by any process, the CLI included: the next request finds out.
    await writeManifest("b".repeat(64));
    expect((await post("/api/1/request", { type: "library:stats" }, second)).status).toBe(401);
  });
});

describe("what a paired phone may ask", () => {
  it("refuses a request off the allowlist, and one the contract rejects", async () => {
    await start();
    const token = await pair();
    const dialog = await post("/api/1/request", { type: "dialog:openLibrary" }, token);
    expect(dialog.status).toBe(403);
    expect(await dialog.json()).toMatchObject({ problem: { code: "not_allowed_remotely" } });

    const password = await post(
      "/api/1/request",
      { type: "library:checkPassword", password: "x" },
      token,
    );
    expect(password.status).toBe(403);

    const malformed = await post("/api/1/request", { type: "asset:rate" }, token);
    expect(malformed.status).toBe(400);
    expect(answered).toEqual([]);

    const allowed = await post(
      "/api/1/request",
      { type: "asset:tagAdd", ids: ["ABCDEFGHJKMN"], tags: ["keluarga"] },
      token,
    );
    expect(await allowed.json()).toMatchObject({ ok: true });
  });

  it("serves bytes at the window's own paths, with the range it was asked for", async () => {
    await start();
    const token = await pair();
    const answer = await fetch(`${base}/bytes/thumb/ABCDEFGHJKMN@256?v=7`, {
      headers: { authorization: `Bearer ${token}`, range: "bytes=0-3" },
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("image/webp");
    expect(await answer.text()).toBe("PICTURE");
    expect(bytesAsked).toEqual(["roost://thumb/ABCDEFGHJKMN@256?v=7 bytes=0-3"]);

    const anonymous = await fetch(`${base}/bytes/thumb/ABCDEFGHJKMN@256`);
    expect(anonymous.status).toBe(401);
  });

  it("passes the events a phone needs, and not the others", async () => {
    await start();
    const token = await pair();
    const controller = new AbortController();
    const answer = await fetch(`${base}/api/1/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    expect(answer.headers.get("content-type")).toContain("text/event-stream");
    const reader = (answer.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let seen = decoder.decode((await reader.read()).value);

    sharing.emit({ type: "library:folding", done: 1, total: 2 });
    sharing.emit({ type: "library:changed" });
    while (!seen.includes("library:changed")) seen += decoder.decode((await reader.read()).value);
    controller.abort();

    expect(seen).toContain('event: library:changed\ndata: {"type":"library:changed"}');
    expect(seen).not.toContain("library:folding");
  });
});

describe("the local network", () => {
  it("answers home, Tailscale and loopback addresses, and nothing on the internet", () => {
    for (const address of [
      "127.0.0.1",
      "::1",
      "10.0.0.4",
      "172.20.1.1",
      "192.168.1.20",
      "::ffff:192.168.1.20",
      "169.254.3.3",
      "100.101.102.103",
      "fd7a:115c:a1e0::1",
      "fe80::1",
    ]) {
      expect(isLocalAddress(address), address).toBe(true);
    }
    for (const address of [
      "8.8.8.8",
      "172.32.0.1",
      "100.128.0.1",
      "::ffff:8.8.8.8",
      "2001:4860::8888",
      "",
      undefined,
    ]) {
      expect(isLocalAddress(address), String(address)).toBe(false);
    }
  });
});
