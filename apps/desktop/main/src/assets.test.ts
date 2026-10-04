import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Db, FileStore, INDEX_FILE, IndexSink, parseAssetId } from "@roost/core";
import { makePdf } from "@roost/media/testing/pdf-fixture";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssetServer } from "./assets.js";

const PICTURE = parseAssetId("AAAAAAAAAAAA");
const SECOND = parseAssetId("BBBBBBBBBBBB");
const NO_THUMB = parseAssetId("CCCCCCCCCCCC");
const ABSENT = parseAssetId("DDDDDDDDDDDD");
const TRACK = parseAssetId("FFFFFFFFFFFF");
const ASS = parseAssetId("999999999999");

/** 1000 bytes whose value at index i is i % 251, so a slice identifies itself. */
const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
const WEBP = Buffer.from("pretend-this-is-webp");
const SRT = "1\r\n00:00:01,000 --> 00:00:02,500\r\nHello, world\r\n";

describe("serving bytes over roost://", () => {
  let root: string;
  let outside: string;
  let server: AssetServer;

  const get = (url: string, headers: Record<string, string> = {}): Promise<Response> =>
    server.handle(new Request(url, { headers }));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "roost-assets-"));
    outside = await mkdtemp(join(tmpdir(), "roost-elsewhere-"));

    const storage = new FileStore(root);
    const picturePath = storage.locate(PICTURE, "png");
    await mkdir(dirname(picturePath), { recursive: true });
    await writeFile(picturePath, BYTES);

    // A second asset, inside the library like every other one: version 2 has
    // one storage mode (RL-19), so `outside` is only somewhere to move a file
    // *to* in the test that makes one go missing.
    const secondPath = storage.locate(SECOND, "jpg");
    await mkdir(dirname(secondPath), { recursive: true });
    await writeFile(secondPath, BYTES.slice(0, 10));

    const trackPath = storage.locate(TRACK, "srt");
    await mkdir(dirname(trackPath), { recursive: true });
    await writeFile(trackPath, SRT);

    const db = Db.open(join(root, INDEX_FILE));
    db.transaction(() => {
      const sink = new IndexSink(db);
      sink.apply({
        ts: 1,
        op: "add",
        id: PICTURE,
        ext: "png",
        name: "a",
      });
      sink.apply({
        ts: 1,
        op: "add",
        id: SECOND,
        ext: "jpg",
        name: "b",
      });
      sink.apply({
        ts: 1,
        op: "add",
        id: NO_THUMB,
        ext: "mp4",
        name: "c",
      });
      sink.apply({
        ts: 1,
        op: "add",
        id: TRACK,
        ext: "srt",
        name: "film",
      });
      sink.apply({
        ts: 1,
        op: "add",
        id: ASS,
        ext: "ass",
        name: "film",
      });
      db.repo.putThumbnail(PICTURE, 256, 256, 160, WEBP);
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
    const response = await get(`roost://thumb/${PICTURE}@256`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(WEBP);
  });

  it("404s a thumbnail that has not been generated, and asks to be re-asked later", async () => {
    // The grid learns a thumbnail is absent by asking. `roost-old` measured it
    // re-asking on every scroll back over a folder of videos, so the 404 is
    // cacheable — briefly, because an import may be generating one right now.
    for (const url of [`roost://thumb/${NO_THUMB}@256`, `roost://thumb/${PICTURE}@512`]) {
      const response = await get(url);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("public, max-age=10");
    }
  });

  it("passes the misses on, once for a burst, so the queue can draw them next", async () => {
    const reported: (readonly string[])[] = [];
    server.onThumbnailsMissing = (ids) => reported.push(ids);

    // A screen of placeholders is a burst of requests, and the same cell can
    // ask twice — at two sizes, or once more before the first answer lands.
    await get(`roost://thumb/${NO_THUMB}@256`);
    await get(`roost://thumb/${NO_THUMB}@256`);
    await get(`roost://thumb/${PICTURE}@512`);
    await get(`roost://thumb/${PICTURE}@256`);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(reported).toEqual([[NO_THUMB, PICTURE]]);
  });

  it("streams a managed original whole", async () => {
    const response = await get(`roost://file/${PICTURE}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe("1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  it("answers a range with 206 and the exact bytes asked for", async () => {
    const response = await get(`roost://file/${PICTURE}`, { range: "bytes=100-199" });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(response.headers.get("content-length")).toBe("100");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(100, 200));
  });

  it("answers a suffix range, which is how a player finds an MP4's index", async () => {
    const response = await get(`roost://file/${PICTURE}`, { range: "bytes=-16" });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 984-999/1000");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(984));
  });

  it("answers 416 for a range past the end, and says how big the file is", async () => {
    const response = await get(`roost://file/${PICTURE}`, { range: "bytes=5000-" });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */1000");
  });

  it("serves a second asset from the one place its bytes can be", async () => {
    const response = await get(`roost://file/${SECOND}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(0, 10));
  });

  it("404s an asset whose file has gone (RL-25)", async () => {
    // The row stays — it carries everything the person wrote about it — and the
    // grid draws a cell with no picture rather than nothing at all.
    await rm(new FileStore(root).locate(SECOND, "jpg"));
    expect((await get(`roost://file/${SECOND}`)).status).toBe(404);
  });

  it("gives HEAD the headers and no body", async () => {
    const response = await server.handle(
      new Request(`roost://file/${PICTURE}`, { method: "HEAD" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("1000");
    expect(await response.text()).toBe("");
  });

  it("refuses a method that is not a read", async () => {
    const response = await server.handle(
      new Request(`roost://file/${PICTURE}`, { method: "POST" }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("serves a subtitle as WebVTT, converted", async () => {
    // `<track>` accepts WebVTT and nothing else, and the format people have is
    // SubRip — so this route is a conversion rather than the bytes (ADR-0025).
    const response = await get(`roost://subtitle/${TRACK}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/vtt; charset=utf-8");

    const text = await response.text();
    expect(text.startsWith("WEBVTT")).toBe(true);
    expect(text).toContain("00:00:01.000 --> 00:00:02.500");
    // A comma in the words is a comma.
    expect(text).toContain("Hello, world");
  });

  it("lets the page read a track, which is the whole of why it loads", async () => {
    /*
     * A `<track>` is fetched with CORS or not at all: its cues are read by the
     * page, unlike a picture or a film, which are drawn and played. This scheme
     * is `standard`, so its origin is its host — `roost://subtitle/…` is
     * cross-origin to the window however the window was loaded, and to
     * `roost://file/…` as well. Without the header the track ends at
     * `readyState 3` with no cues and nothing said anywhere, which is how it
     * was reported on 2026-09-08.
     */
    const allowed = "*";
    expect(
      (await get(`roost://subtitle/${TRACK}`)).headers.get("access-control-allow-origin"),
    ).toBe(allowed);
    // On every response, not only that one: the media element carries
    // `crossorigin`, so its own bytes are a CORS request too — and an error is
    // as much an answer as a body.
    for (const url of [
      `roost://file/${PICTURE}`,
      `roost://thumb/${PICTURE}@256`,
      `roost://subtitle/${ASS}`,
      `roost://file/${ABSENT}`,
      "roost://export/nonsense",
    ]) {
      expect((await get(url)).headers.get("access-control-allow-origin")).toBe(allowed);
    }
  });

  it("says it cannot serve a track that needs an external tool", async () => {
    // ASS needs ffmpeg, which is a capability and may be absent. Answering
    // with the bytes under a `text/vtt` type would be an empty track and no
    // error anywhere.
    expect((await get(`roost://subtitle/${ASS}`)).status).toBe(415);
    expect((await get(`roost://subtitle/${ABSENT}`)).status).toBe(404);
  });

  it("400s a URL that is not a route, and 404s an asset that is not there", async () => {
    expect((await get("roost://thumb/not-a-hash@256")).status).toBe(400);
    expect((await get(`roost://export/${PICTURE}`)).status).toBe(400);
    expect((await get(`roost://file/${ABSENT}`)).status).toBe(404);
  });

  it("serves nothing once the library is closed", async () => {
    // Not merely tidiness: a request that arrived after a close must not answer
    // with bytes from the library that is no longer open.
    server.detach();
    expect((await get(`roost://thumb/${PICTURE}@256`)).status).toBe(404);
    expect((await get(`roost://file/${PICTURE}`)).status).toBe(404);
  });
});

describe("serving a document page", () => {
  let root: string;
  let server: AssetServer;
  const DOC = parseAssetId("EEEEEEEEEEEE");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "roost-pages-"));

    const storage = new FileStore(root);
    const path = storage.locate(DOC, "pdf");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, makePdf([{ colour: [255, 0, 0] }, { colour: [0, 0, 255] }]));

    const db = Db.open(join(root, INDEX_FILE));
    db.transaction(() => {
      const sink = new IndexSink(db);
      sink.apply({
        ts: 1,
        op: "add",
        id: DOC,
        ext: "pdf",
        name: "report",
      });
    });
    db.close();

    server = new AssetServer();
    server.attach(root);
  });

  afterEach(async () => {
    server.detach();
    await rm(root, { recursive: true, force: true });
  });

  const get = (url: string): Promise<Response> => server.handle(new Request(url));

  it("renders the page asked for, as a PNG", async () => {
    const response = await get(`roost://page/${DOC}/1@512`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await response.arrayBuffer());
    // A real PNG, not merely a response that claims to be one: signature, and
    // the width the URL asked for, read out of IHDR.
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(bytes.readUInt32BE(16)).toBe(512);
  });

  it("caches a page for ever, because its URL fixes its pixels", async () => {
    const response = await get(`roost://page/${DOC}/0@512`);

    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  it("answers 404 for a page the document does not have", async () => {
    const response = await get(`roost://page/${DOC}/9@512`);

    expect(response.status).toBe(404);
    // Briefly cached, not for ever: the document could be re-imported.
    expect(response.headers.get("cache-control")).toBe("max-age=5");
  });

  it("answers 404 for an asset that is not a document at all", async () => {
    const absent = parseAssetId("FFFFFFFFFFFF");

    expect((await get(`roost://page/${absent}/0@512`)).status).toBe(404);
  });
});

describe("a picture for the clipboard", () => {
  let root: string;
  let server: AssetServer;
  let png: Buffer;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "roost-still-"));
    const { encodePng } = await import("@roost/media/png");
    png = encodePng(Buffer.alloc(8 * 6 * 4, 0x80), 8, 6);

    const storage = new FileStore(root);
    for (const [id, ext, bytes] of [
      [PICTURE, "png", png],
      [TRACK, "srt", Buffer.from(SRT)],
    ] as const) {
      const path = storage.locate(id, ext);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }

    const db = Db.open(join(root, INDEX_FILE));
    db.transaction(() => {
      const sink = new IndexSink(db);
      sink.apply({ ts: 1, op: "add", id: PICTURE, ext: "png", name: "logo" });
      sink.apply({ ts: 1, op: "add", id: TRACK, ext: "srt", name: "film" });
      // In the index and not on disk, as an asset is when its file has gone.
      sink.apply({ ts: 1, op: "add", id: ABSENT, ext: "png", name: "gone" });
    });
    db.close();

    server = new AssetServer();
    server.attach(root);
  });

  afterEach(async () => {
    server.detach();
    await rm(root, { recursive: true, force: true });
  });

  it("hands a PNG over as the file's own bytes", async () => {
    const still = await server.still(PICTURE);
    expect(still?.equals(png)).toBe(true);
  });

  it("has nothing for a file that is not a picture, or is not there", async () => {
    // `undefined` is what tells main to leave the clipboard alone, so a paste
    // afterwards brings back what was there rather than nothing at all.
    expect(await server.still(TRACK)).toBeUndefined();
    expect(await server.still(ABSENT)).toBeUndefined();
    expect(await server.still(SECOND)).toBeUndefined();
  });

  it("has nothing once the library is closed", async () => {
    server.detach();
    expect(await server.still(PICTURE)).toBeUndefined();
  });
});

describe("handing files out by dragging (ADR-0034 §4)", () => {
  let root: string;
  let server: AssetServer;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "roost-handoff-"));
    // Imported here and only here: a test is allowed the decoder that main's
    // own modules must not load at the top of a file.
    const { gradient } = await import("@roost/media");
    const webp = await gradient(200, 100, 1, "webp");

    const db = Db.open(join(root, INDEX_FILE));
    db.transaction(() => {
      new IndexSink(db).apply({ ts: 1, op: "add", id: PICTURE, ext: "png", name: "logo" });
      db.repo.putThumbnail(PICTURE, 256, 200, 100, webp);
    });
    db.close();
    // Left by an earlier session, which the sweep at open is for.
    await mkdir(join(root, "staging"), { recursive: true });
    await writeFile(join(root, "staging", "handed out before.png"), "old");

    server = new AssetServer();
    server.attach(root);
  });

  afterEach(async () => {
    server.detach();
    await rm(root, { recursive: true, force: true });
  });

  it("says what a copy costs, and leaves nothing of the probe behind", async () => {
    const cost = await server.handoffCost();

    // Which of the two depends on the filesystem the test runs on.
    expect(["free", "copies"]).toContain(cost);
    // Swept first and probed after, so neither the old file nor the probe's
    // own survive — and the probe never touched the library's root (RL-3).
    expect(await readdir(join(root, "staging"))).toEqual([]);
    expect((await readdir(root)).filter((name) => name.startsWith(".roost"))).toEqual([]);
  });

  it("hands out a named copy, or the library's own file when staging is off", async () => {
    // ADR-0034 §8. The file itself is written here because this block's
    // library has only the index; the sweep has to finish first, or it would
    // take the named copy with it.
    const own = new FileStore(root).locate(PICTURE, "png");
    await mkdir(dirname(own), { recursive: true });
    await writeFile(own, "the library's own bytes");
    await server.handoffCost();

    const [named] = await server.handOut([PICTURE, ABSENT], true);
    expect(named).toBe(join(root, "staging", "logo.png"));

    // Off: the path in `files/`, under the id, and nothing more in staging.
    expect(await server.handOut([PICTURE, ABSENT], false)).toEqual([own]);
    expect(await readdir(join(root, "staging"))).toEqual(["logo.png"]);
  });

  it("carries the icon on the first drag and the picture after", async () => {
    // Loading the decoder costs ~180 ms, which a drag must not wait for.
    expect(await server.dragPicture(PICTURE)).toBeUndefined();

    let picture: Buffer | undefined;
    for (let tries = 0; tries < 100 && picture === undefined; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      picture = await server.dragPicture(PICTURE);
    }
    // A PNG, since `nativeImage` reads no WebP.
    expect(picture?.subarray(1, 4).toString()).toBe("PNG");
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

  it("reaches the PDF backend by its own subpath, and only lazily", async () => {
    // `@roost/media/document` is decoder-free — pdfium in WebAssembly, no
    // sharp — and it is imported inside the handler rather than at the top of
    // the file, so a window that never opens a document never loads it.
    const source = await readFile(
      join(fileURLToPath(new URL(".", import.meta.url)), "assets.ts"),
      "utf8",
    );

    expect(source).toContain('await import("@roost/media/document")');
    // The PNG encoder comes the same way, and it is `node:zlib` and nothing
    // else — which is what makes it reachable from here at all.
    expect(source).toContain('await import("@roost/media/png")');
    expect(/^import .*@roost\/media\/document/m.test(source)).toBe(false);
  });

  it("loads the decoder for a copied picture inside the handler, never at the top", async () => {
    // **Copy image** is the one gesture that needs sharp in main, as a HEIC's
    // rendition is (ADR-0040 §7): the import is inside the method, so a window
    // nobody copies a picture from never loads it.
    const source = await readFile(
      join(fileURLToPath(new URL(".", import.meta.url)), "assets.ts"),
      "utf8",
    );
    expect(source).toContain('const { renderStill } = await import("@roost/media")');
  });
});
