import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import {
  type AssetId,
  FileStore,
  fileNameFor,
  logger,
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
 * The `roost://` handler: thumbnails out of the index, files off the disk.
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
      // `locate` is the one door from an id to a path (invariant 2). Nothing
      // in this file joins one itself.
      storage: new FileStore(root),
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
  async locate(id: AssetId): Promise<string | undefined> {
    const open = this.#open;
    if (open === undefined) return undefined;
    const record = open.index.findFile(id);
    if (record === undefined) return undefined;

    const path = open.storage.locate(id, record.ext);
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
   * Staged inside the library under the name the library shows, because the
   * name on disk is an id and nobody can read that. Version 1 had a second
   * case — a `referenced` original handed over where it lay — and version 2
   * has one storage mode (RL-19), so this one path serves every asset.
   *
   * Assets whose bytes are not on this machine are skipped rather than passed
   * on as a path that resolves to nothing: a handoff with a hole in it is worse
   * than a shorter one, which is the rule `copyPaths` already follows.
   */
  async stage(ids: readonly AssetId[]): Promise<string[]> {
    const open = this.#open;
    if (open === undefined) return [];

    const files: string[] = [];
    for (const id of ids) {
      const record = open.index.findFile(id);
      const name = open.index.displayName(id);
      if (record === undefined || name === undefined) continue;

      const source = await this.locate(id);
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
    return allowCrossOrigin(await this.#route(request));
  }

  async #route(request: Request): Promise<Response> {
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
    if (route.value.kind === "render") return this.#serveRender(open, route.value);
    return this.#serveFile(open, route.value, request);
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
    const path = await this.locate(route.id);
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
        asset: route.id,
        page: route.index,
        reason: error instanceof Error ? error.message : String(error),
      });
      return new Response(null, { status: 404, headers: { "cache-control": "max-age=5" } });
    }
  }

  /**
   * A picture for an asset a browser cannot draw (ADR-0040 §7).
   *
   * HEIC, RAW and TIFF all import, all get thumbnails, and all used to open as
   * an empty pane: the pane loads the asset's own bytes into an `<img>`, and
   * Chromium decodes none of the three. This renders one on demand — the same
   * exception `#servePage` takes, for the same reason, and with the same escape
   * hatch: the decoder is imported **here**, so a window that never opens one of
   * these three never loads sharp at all.
   *
   * Not cached as `immutable` like a thumbnail. It is content-addressed and its
   * bytes are stable, but a rendition is expensive to keep and cheap to make
   * again — a HEIC is ~200 ms — so it is left to the ordinary cache.
   */
  async #serveRender(
    open: OpenLibrary,
    route: Extract<Route, { kind: "render" }>,
  ): Promise<Response> {
    const record = open.index.findFile(route.id);
    if (record === undefined) return new Response(null, { status: 404 });

    const path = await this.locate(route.id);
    if (path === undefined) return new Response(null, { status: 404 });

    try {
      const { renderForBrowser } = await import("@roost/media");
      const rendition = await renderForBrowser(path, formatFromExtension(record.ext));

      return new Response(new Uint8Array(rendition.bytes), {
        headers: {
          "content-type": rendition.mediaType,
          "content-length": String(rendition.bytes.byteLength),
          "cache-control": "public, max-age=3600",
        },
      });
    } catch (error) {
      // A RAW with no embedded preview, a HEIC on a machine with no libheif, a
      // file that is not what its name says. A missing picture, not a broken
      // window — and the pane falls back to the thumbnail it already has.
      log.debug("could not render a preview", {
        asset: route.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return new Response(null, { status: 404, headers: { "cache-control": "max-age=5" } });
    }
  }

  #serveThumb(open: OpenLibrary, route: Extract<Route, { kind: "thumb" }>): Response {
    const bytes = open.index.thumbnail(route.id, route.size);
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
    const record = open.index.findFile(route.id);
    if (record === undefined) return new Response(null, { status: 404 });
    if (!isConvertible(record.ext)) {
      // ASS and an embedded stream both need ffmpeg, which is a capability and
      // may be absent. Until that arrives this is honest about not being able
      // to answer, rather than serving something a `<track>` cannot read.
      return new Response(null, { status: 415 });
    }

    const path = open.storage.locate(route.id, record.ext);

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

  async #serveFile(
    open: OpenLibrary,
    route: Extract<Route, { kind: "file" }>,
    request: Request,
  ): Promise<Response> {
    const record = open.index.findFile(route.id);
    if (record === undefined) return new Response(null, { status: 404 });

    const path = open.storage.locate(route.id, record.ext);

    // The size is read here and never taken from the index: the bytes may have
    // changed since anything last looked (RL-20), and answering a range against
    // a stale size would hand a player the wrong bytes.
    let size: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) return new Response(null, { status: 404 });
      size = info.size;
    } catch {
      // An asset whose file is gone (RL-25). `roost doctor` reports it; the
      // grid shows a cell without a preview.
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

/**
 * The one header a caption track cannot do without (ADR-0025).
 *
 * **A `<track>` is fetched with CORS or not at all.** Every other consumer here
 * is a no-cors load — an `<img>` draws a cross-origin picture and a `<video>`
 * plays a cross-origin file without asking anyone — but a text track's cues are
 * *read* by the page, so the HTML specification requires the media element to
 * carry `crossorigin` and the response to allow the origin. Without it the
 * track ends at `readyState 3` with no cues, no console message and no event:
 * the subtitle simply never appears, which is how this was reported on
 * 2026-09-08.
 *
 * Same-origin was never available. The window is `file://` in a packaged build
 * and `http://localhost` under `pnpm dev`, and `roost:` is a `standard` scheme
 * whose origin is the *host* — so `roost://subtitle/…` is cross-origin to the
 * document, and to `roost://file/…` as well.
 *
 * `*` rather than an origin, and on every response: the alternative is a header
 * that varies with how the window was loaded, which is the kind of difference
 * that works in `pnpm dev` and fails once packaged. It grants nothing new —
 * `supportFetchAPI` stays off, so no script can read these bytes as data, and
 * the CSP still lists `roost:` in `img-src` and `media-src` only.
 */
function allowCrossOrigin(response: Response): Response {
  response.headers.set("access-control-allow-origin", "*");
  return response;
}

interface OpenLibrary {
  readonly root: string;
  readonly index: ReadOnlyIndex;
  readonly storage: FileStore;
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
