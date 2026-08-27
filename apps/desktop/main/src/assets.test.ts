import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Db, INDEX_FILE, IndexSink, ManagedStorage, parseContentHash } from "@roost/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssetServer } from "./assets.js";

const MANAGED = parseContentHash("a".repeat(64));
const REFERENCED = parseContentHash("b".repeat(64));
const NO_THUMB = parseContentHash("c".repeat(64));
const ABSENT = parseContentHash("d".repeat(64));

/** 1000 bytes whose value at index i is i % 251, so a slice identifies itself. */
const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
const WEBP = Buffer.from("pretend-this-is-webp");

describe("serving bytes over roost://", () => {
  let root: string;
  let outside: string;
  let server: AssetServer;

  const get = (url: string, headers: Record<string, string> = {}): Promise<Response> =>
    server.handle(new Request(url, { headers }));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "roost-assets-"));
    outside = await mkdtemp(join(tmpdir(), "roost-elsewhere-"));

    const storage = new ManagedStorage(root);
    const managedPath = storage.locate(MANAGED, "png");
    await mkdir(dirname(managedPath), { recursive: true });
    await writeFile(managedPath, BYTES);

    const referencedPath = join(outside, "held.jpg");
    await writeFile(referencedPath, BYTES.slice(0, 10));

    const db = Db.open(join(root, INDEX_FILE));
    db.transaction(() => {
      const sink = new IndexSink(db);
      sink.apply({
        ts: 1,
        op: "add",
        hash: MANAGED,
        ext: "png",
        size: BYTES.length,
        name: "a.png",
        mode: "managed",
      });
      sink.apply({
        ts: 1,
        op: "add",
        hash: REFERENCED,
        ext: "jpg",
        size: 10,
        name: "b.jpg",
        mode: "referenced",
        ref: referencedPath,
      });
      sink.apply({
        ts: 1,
        op: "add",
        hash: NO_THUMB,
        ext: "mp4",
        size: 4,
        name: "c.mp4",
        mode: "managed",
      });
      db.repo.putThumbnail(MANAGED, 256, 256, 160, WEBP);
    });
    db.close();

    server = new AssetServer();
    server.attach(root);
  });

  afterEach(async () => {
    server.detach();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("returns a thumbnail with a cache header that says it can never change", async () => {
    const response = await get(`roost://thumb/${MANAGED}@256`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(WEBP);
  });

  it("404s a thumbnail that has not been generated, and asks to be re-asked later", async () => {
    // The grid learns a thumbnail is absent by asking. `roost-old` measured it
    // re-asking on every scroll back over a folder of videos, so the 404 is
    // cacheable — briefly, because an import may be generating one right now.
    for (const url of [`roost://thumb/${NO_THUMB}@256`, `roost://thumb/${MANAGED}@512`]) {
      const response = await get(url);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("public, max-age=10");
    }
  });

  it("streams a managed original whole", async () => {
    const response = await get(`roost://original/${MANAGED}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe("1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  it("answers a range with 206 and the exact bytes asked for", async () => {
    const response = await get(`roost://original/${MANAGED}`, { range: "bytes=100-199" });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(response.headers.get("content-length")).toBe("100");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(100, 200));
  });

  it("answers a suffix range, which is how a player finds an MP4's index", async () => {
    const response = await get(`roost://original/${MANAGED}`, { range: "bytes=-16" });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 984-999/1000");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(984));
  });

  it("answers 416 for a range past the end, and says how big the file is", async () => {
    const response = await get(`roost://original/${MANAGED}`, { range: "bytes=5000-" });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */1000");
  });

  it("serves a referenced original from where the user keeps it", async () => {
    const response = await get(`roost://original/${REFERENCED}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(0, 10));
  });

  it("404s a referenced original the user has moved away", async () => {
    await rm(join(outside, "held.jpg"));
    expect((await get(`roost://original/${REFERENCED}`)).status).toBe(404);
  });

  it("gives HEAD the headers and no body", async () => {
    const response = await server.handle(
      new Request(`roost://original/${MANAGED}`, { method: "HEAD" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("1000");
    expect(await response.text()).toBe("");
  });

  it("refuses a method that is not a read", async () => {
    const response = await server.handle(
      new Request(`roost://original/${MANAGED}`, { method: "POST" }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("400s a URL that is not a route, and 404s an asset that is not there", async () => {
    expect((await get("roost://thumb/not-a-hash@256")).status).toBe(400);
    expect((await get(`roost://export/${MANAGED}`)).status).toBe(400);
    expect((await get(`roost://original/${ABSENT}`)).status).toBe(404);
  });

  it("serves nothing once the library is closed", async () => {
    // Not merely tidiness: a request that arrived after a close must not answer
    // with bytes from the library that is no longer open.
    server.detach();
    expect((await get(`roost://thumb/${MANAGED}@256`)).status).toBe(404);
    expect((await get(`roost://original/${MANAGED}`)).status).toBe(404);
  });
});

describe("what main is allowed to import", () => {
  it("never pulls the whole of @roost/media, which would load sharp", async () => {
    // ADR-0008 puts the handler in the process that draws the window, and
    // `@roost/media`'s entry point re-exports the decoder — so a bare import
    // would `dlopen` libvips there. `@roost/media/serving` exists to make the
    // narrow import possible; this makes it the one that happens.
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const offenders: string[] = [];
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".ts")) continue;
      const source = await readFile(join(dir, name), "utf8");
      if (/from "@roost\/media"/.test(source)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
