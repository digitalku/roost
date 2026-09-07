import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import {
  type ContentHash,
  fileNameFor,
  logger,
  ManagedStorage,
  ReadOnlyIndex,
  stageFile,
  sweepStaging,
} from "@roost/core";
import { formatFromExtension, isConvertible, mediaTypeOf, toWebVtt } from "@roost/media/serving";
import { contentRange, parseRange, type Slice } from "./range.js";
import { parseRoostUrl, type Route } from "./route.js";

const log = logger("assets");

/**
 * The most a caption track may be, read whole on main's thread.
 *
 * Two megabytes is far past any subtitle — a three-hour film is tens of
 * kilobytes — and a file claiming to be one that holds more is refused rather
 * than read.
 */
const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

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
    // Whatever a previous session handed out has been had by now (ADR-0034):
    // a clipboard reference does not survive a reboot, and a drop that was
    // still being read when the window closed has long since finished.
    void sweepStaging(root);
  }

  detach(): void {
    this.#open?.index.close();
    this.#open = undefined;
  }

  /**
   * Where one asset's bytes are on disk, or `undefined`.
   *
   * The other thing main needs a library for: handing a file to the desktop's
   * own handler (`CONCEPT.md` §5). It reuses this connection rather than
   * opening a second one, for the same reason ADR-0008 allows only one.
   *
   * Not a `Response`, so it is deliberately outside `handle` — a path is
   * something main acts on, never something the renderer receives.
   */
  async locate(hash: ContentHash): Promise<string | undefined> {
    const open = this.#open;
    if (open === undefined) return undefined;
    const record = open.index.findOriginal(hash);
    if (record === undefined) return undefined;

    const path =
      record.storageMode === "referenced" ? record.refPath : open.storage.locate(hash, record.ext);
    if (path === null) return undefined;
    try {
      return (await stat(path)).isFile() ? path : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Files with readable names, for handing this selection to another
   * application (ADR-0034).
   *
   * A `referenced` original is handed over where it lies — that file is already
   * the user's own, under the user's own name. A managed one is staged inside
   * the library under the name the library shows, because the name on disk is
   * its hash and nobody can read that.
   *
   * Assets whose bytes are not on this machine are skipped rather than passed
   * on as a path that resolves to nothing: a handoff with a hole in it is worse
   * than a shorter one, which is the rule `copyPaths` already follows.
   */
  async stage(hashes: readonly ContentHash[]): Promise<string[]> {
    const open = this.#open;
    if (open === undefined) return [];

    const files: string[] = [];
    for (const hash of hashes) {
      const record = open.index.findOriginal(hash);
      const name = open.index.displayName(hash);
      if (record === undefined || name === undefined) continue;

      if (record.storageMode === "referenced") {
        if (record.refPath !== null) files.push(record.refPath);
        continue;
      }

      const source = await this.locate(hash);
      if (source === undefined) continue;
      try {
        const { path } = await stageFile(open.root, source, fileNameFor(name, record.ext));
        files.push(path);
      } catch (error) {
        log.warn("an asset could not be staged", {
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    return files;
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

    if (route.value.kind === "thumb") return this.#serveThumb(open, route.value);
    if (route.value.kind === "page") return this.#servePage(open, route.value);
    if (route.value.kind === "subtitle") return this.#serveSubtitle(open, route.value);
    return this.#serveOriginal(open, route.value, request);
  }

  /**
   * One page of a document, rendered on demand.
   *
   * Neither a stored thumbnail nor the file itself, which is why it is a third
   * route rather than a use of the other two: page-through needs a picture per
   * page and a library that stored one per page would be storing a rendering
   * nobody asked for.
   *
   * Rendered **here**, in the process that draws the window, which is a
   * deliberate exception of the same kind ADR-0008 already takes for the
   * read-only database handle: bytes cannot cross IPC, so the process that
   * serves them is the process that must make them. It is affordable because
   * the backend is WASM rather than a native decoder — nothing is `dlopen`ed
   * and nothing is loaded until the first page is asked for — and because a
   * page costs single-digit milliseconds (ADR-0016).
   */
  async #servePage(open: OpenLibrary, route: Extract<Route, { kind: "page" }>): Promise<Response> {
    const path = await this.locate(route.hash);
    if (path === undefined) return new Response(null, { status: 404 });

    try {
      // Imported here rather than at the top of the file: a window that never
      // opens a document never loads a PDF backend, and cold start is an M3
      // acceptance criterion that M4 must not spend.
      const { renderPage } = await import("@roost/media/document");
      const page = await renderPage(path, route.index, route.width);
      const { encodePng } = await import("@roost/media/png");
      const png = encodePng(page.pixels, page.width, page.height);

      return new Response(new Uint8Array(png), {
        headers: {
          "content-type": "image/png",
          "content-length": String(png.byteLength),
          // Content-addressed like a thumbnail: the hash, the page, and the
          // width fix the pixels, so nothing behind this URL can change.
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    } catch (error) {
      // An encrypted PDF, a page past the end, a file that is not a document at
      // all. A missing picture, not a broken window.
      log.debug("could not render a page", {
        hash: route.hash,
        page: route.index,
        reason: error instanceof Error ? error.message : String(error),
      });
      return new Response(null, { status: 404, headers: { "cache-control": "max-age=5" } });
    }
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

  /**
   * A caption track, as WebVTT (ADR-0025).
   *
   * Read whole and converted rather than streamed: `<track>` has no use for a
   * range, a subtitle is kilobytes, and the conversion needs the text anyway.
   * The ceiling is what keeps that honest — a file claiming to be a subtitle
   * and holding a gigabyte is refused rather than read onto main's thread.
   *
   * **No range support and no `accept-ranges`.** Saying a resource is
   * range-able and then ignoring the header is worse than saying nothing.
   */
  async #serveSubtitle(
    open: OpenLibrary,
    route: Extract<Route, { kind: "subtitle" }>,
  ): Promise<Response> {
    const record = open.index.findOriginal(route.hash);
    if (record === undefined) return new Response(null, { status: 404 });
    if (!isConvertible(record.ext)) {
      // ASS and an embedded stream both need ffmpeg, which is a capability and
      // may be absent. Until that arrives this is honest about not being able
      // to answer, rather than serving something a `<track>` cannot read.
      return new Response(null, { status: 415 });
    }

    const path =
      record.storageMode === "referenced"
        ? record.refPath
        : open.storage.locate(route.hash, record.ext);
    if (path === null) return new Response(null, { status: 404 });

    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_SUBTITLE_BYTES) {
        return new Response(null, { status: info.isFile() ? 413 : 404 });
      }
      const text = await readFile(path, "utf8");
      return new Response(toWebVtt(text), {
        headers: {
          "content-type": "text/vtt; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
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
