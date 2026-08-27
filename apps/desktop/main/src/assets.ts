import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { logger, ManagedStorage, ReadOnlyIndex } from "@roost/core";
import { formatFromExtension, mediaTypeOf } from "@roost/media/serving";
import { contentRange, parseRange, type Slice } from "./range.js";
import { parseRoostUrl, type Route } from "./route.js";

const log = logger("assets");

/**
 * The `roost://` handler: thumbnails out of the index, originals off the disk.
 *
 * Deliberately holds no reference to Electron. `protocol.handle` passes a
 * `Request` and takes a `Response`, both of which are globals here, so the
 * whole of this can be driven by a test in an ordinary Node process — which is
 * the only way any of it gets exercised, since a CI job that opens a window
 * does not exist yet (`TODO.md` §M3).
 *
 * One library is served at a time, because one window opens one library. The
 * read-only connection is opened when a library opens and closed when it does,
 * so a closed library leaves no descriptor behind and a request that arrives
 * afterwards gets a 404 rather than bytes from the previous library.
 */
export class AssetServer {
  #open: OpenLibrary | undefined;

  /** Points the handler at a library that has just been opened. */
  attach(root: string): void {
    this.detach();
    this.#open = {
      root,
      index: ReadOnlyIndex.open(root),
      // `locate` is the one door from a hash to a path (invariant 2). Nothing
      // in this file joins one itself.
      storage: new ManagedStorage(root),
    };
    log.debug("serving bytes for a library", { root });
  }

  detach(): void {
    this.#open?.index.close();
    this.#open = undefined;
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    }

    const route = parseRoostUrl(request.url);
    if (!route.ok) {
      // The reason names nothing the renderer supplied that it does not already
      // know, but it is worth having in the log: a malformed roost:// URL is a
      // renderer bug, and the URL is where it is visible.
      log.warn("rejected a roost:// URL", { reason: route.reason });
      return new Response(null, { status: 400 });
    }

    const open = this.#open;
    if (open === undefined) return new Response(null, { status: 404 });

    return route.value.kind === "thumb"
      ? this.#serveThumb(open, route.value)
      : this.#serveOriginal(open, route.value, request);
  }

  #serveThumb(open: OpenLibrary, route: Extract<Route, { kind: "thumb" }>): Response {
    const bytes = open.index.thumbnail(route.hash, route.size);
    if (bytes === undefined) return missingThumbnail();
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "image/webp",
        "content-length": String(bytes.byteLength),
        // A content-addressed URL's bytes cannot change, so this is free
        // correctness rather than a gamble (ADR-0008).
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  async #serveOriginal(
    open: OpenLibrary,
    route: Extract<Route, { kind: "original" }>,
    request: Request,
  ): Promise<Response> {
    const record = open.index.findOriginal(route.hash);
    if (record === undefined) return new Response(null, { status: 404 });

    const path =
      record.storageMode === "referenced"
        ? record.refPath
        : open.storage.locate(route.hash, record.ext);
    if (path === null) return new Response(null, { status: 404 });

    // The recorded size is what the file had at import. A referenced original
    // lives in a user's directory and may have changed since, and answering a
    // range against a stale size would hand a player the wrong bytes.
    let size: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) return new Response(null, { status: 404 });
      size = info.size;
    } catch {
      // A referenced original that has been moved or deleted. `roost doctor`
      // reports it; the grid shows a cell without a preview.
      return new Response(null, { status: 404 });
    }

    const type = mediaTypeOf(formatFromExtension(record.ext));
    const requested = parseRange(request.headers.get("range"), size);
    if (requested.kind === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes" },
      });
    }

    const slice: Slice =
      requested.kind === "whole" ? { start: 0, end: Math.max(0, size - 1) } : requested.slice;
    const length = size === 0 ? 0 : slice.end - slice.start + 1;

    const headers: Record<string, string> = {
      "content-type": type,
      "content-length": String(length),
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=31536000, immutable",
    };
    if (requested.kind === "partial") headers["content-range"] = contentRange(slice, size);

    // HEAD gets the headers and no body; a body on a HEAD response is a
    // protocol error, not merely wasteful.
    if (request.method === "HEAD" || length === 0) {
      return new Response(null, { status: requested.kind === "partial" ? 206 : 200, headers });
    }

    // Streamed rather than read: ADR-0008's whole point is that a 4 GB video
    // costs a chunk per request instead of its size.
    const stream = createReadStream(path, { start: slice.start, end: slice.end });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: requested.kind === "partial" ? 206 : 200,
      headers,
    });
  }
}

interface OpenLibrary {
  readonly root: string;
  readonly index: ReadOnlyIndex;
  readonly storage: ManagedStorage;
}

/**
 * A thumbnail that has not been generated yet.
 *
 * Not a bare 404: the grid learns a thumbnail is absent by asking for it, which
 * is right — it avoids a `has_thumbnail` column duplicating what the store
 * already answers — but `roost-old` measured the grid re-asking on every scroll
 * back over a folder of videos. Ten seconds absorbs a scroll without outliving
 * an import that is generating thumbnails while someone watches.
 */
function missingThumbnail(): Response {
  return new Response(null, { status: 404, headers: { "cache-control": "public, max-age=10" } });
}
