import { resolve } from "node:path";
import type {
  AssetPage,
  LibraryStats,
  LibrarySummary,
  QueryCheck,
  Request,
  ResponseOf,
  SidebarRow,
  WireAssetDetail,
  WireCursor,
  WireSidebar,
} from "@roost/contract";
import {
  type AssetDetail,
  type ContentHash,
  type Cursor,
  lastCursor,
  logger,
  parseContentHash,
  type SearchHit,
  type StorageMode,
} from "@roost/core";
import {
  compileFor,
  Library,
  libraryDirectory,
  libraryNameFromPath,
  matches,
  pageOf,
  rate,
  readSidebar,
  renameAsset,
  setFavorite,
  setNote,
  tagAdd,
  tagRemove,
} from "@roost/library";
import { QueryError } from "@roost/search";

/**
 * One library, and the requests that reach it.
 *
 * The host is where a contract message becomes a `@roost/library` call. It
 * holds no Electron and no message plumbing: that lives in `serve.ts`, so this
 * can be driven directly from a test with a real library on disk.
 *
 * A dispatch that is only ever "validate → call service → return" is the same
 * rule `ARCHITECTURE.md` invariant 4 puts on an IPC handler in main. Anything
 * longer belongs in `@roost/library`.
 */

const log = logger("engine");

export class EngineHost {
  #library: Library | undefined;

  /**
   * Answers one request.
   *
   * Exhaustive over the union with no `default`: a member added to the contract
   * then fails to compile here, which is the only place that failure is cheap.
   */
  async handle(request: Request): Promise<ResponseOf<Request["type"]>> {
    switch (request.type) {
      case "library:open":
        return this.#open(await Library.open(resolve(request.path), { exclusive: true }));

      case "library:create": {
        // `<parent>/<name>.roost`, composed here because this is the side with
        // a filesystem — and validated here, because a name a person typed is
        // about to become a path (ADR-0014).
        const path = libraryDirectory(resolve(request.parent), request.name);
        const name = libraryNameFromPath(path);
        return this.#open(await Library.create(path, name, { exclusive: true }));
      }

      case "library:current":
        return this.#library === undefined ? null : summarize(this.#library);

      case "library:close":
        await this.close();
        return null;

      case "library:stats":
        return statsOf(this.#require());

      case "library:sidebar":
        return sidebarOf(this.#require());

      case "assets:page":
        return this.#page(request.query, request.limit, request.after);

      case "assets:count":
        return matches(this.#require(), request.query);

      case "query:check":
        return check(this.#require(), request.query);

      case "asset:detail": {
        const found = this.#require().db.repo.assetDetail(parseContentHash(request.hash));
        return found === undefined ? null : detailOf(found);
      }

      case "asset:rate":
        return this.#edit(() => rate(this.#require(), hashes(request.hashes), request.rating));

      case "asset:favorite":
        return this.#edit(() =>
          setFavorite(this.#require(), hashes(request.hashes), request.favorite),
        );

      case "asset:note":
        return this.#edit(() =>
          setNote(this.#require(), parseContentHash(request.hash), request.note),
        );

      case "asset:rename":
        return this.#edit(() =>
          renameAsset(this.#require(), parseContentHash(request.hash), request.name),
        );

      case "asset:tagAdd":
        return this.#edit(() => tagAdd(this.#require(), hashes(request.hashes), request.tags));

      case "asset:tagRemove":
        return this.#edit(() => tagRemove(this.#require(), hashes(request.hashes), request.tags));

      case "asset:openExternally":

      case "dialog:openLibrary":
      case "dialog:chooseLocation":
        // A dialog belongs to a window and this process has none. Main answers
        // these before forwarding; one arriving here is a routing bug, and it
        // fails loudly rather than returning a plausible null.
        throw new Error(`${request.type} is answered by main, not by the engine`);
    }
  }

  /**
   * One page of the grid, and where the next one starts.
   *
   * A short page is the last page. Saying so with `next: null` saves the grid a
   * round trip that would cost a statement to learn what the row count already
   * said — the same rule `pages()` uses in `@roost/library`.
   *
   * A malformed RQL query throws from the compiler, which is the answer: the
   * search field wants the parse error, not an empty grid that looks like a
   * library with nothing in it.
   */
  #page(query: string, limit: number, after: WireCursor | null): AssetPage {
    const library = this.#require();
    // `parseContentHash` rather than a cast: the contract already checked the
    // shape, and this is the engine checking it again at its own boundary —
    // which is the boundary ADR-0007 says matters.
    const cursor: Cursor | undefined =
      after === null
        ? undefined
        : { importedAt: after.importedAt, hash: parseContentHash(after.hash) };

    // Spread rather than assigned: `exactOptionalPropertyTypes` makes an
    // explicit `after: undefined` a different thing from an absent one.
    const hits = pageOf(library, query, { limit, ...(cursor && { after: cursor }) });
    const last = hits.length < limit ? undefined : lastCursor(hits);
    return {
      assets: hits.map(cardOf),
      next: last === undefined ? null : { importedAt: last.importedAt, hash: last.hash },
    };
  }

  /**
   * Runs one edit and announces that the library changed.
   *
   * Announced **after** the edit, so a window that re-reads on the event reads
   * the state the edit produced. The answer is `null` on purpose: `UI_SPEC.md`
   * asks each edit to read the record back rather than trust what it sent, and
   * an edit that returned its own idea of the new state would be exactly the
   * trust it is avoiding — the engine normalises a name, drops an
   * all-whitespace note, and deduplicates tags on the way through.
   */
  async #edit(run: () => Promise<void>): Promise<null> {
    await run();
    this.onChanged?.();
    return null;
  }

  /**
   * Called after every mutation, so the window can re-read what it shows.
   *
   * Set by `serve`, which owns the port. The host holds no message plumbing —
   * that is what lets it be driven straight from a test.
   */
  onChanged: (() => void) | undefined;

  /** Releases whatever is open. Safe to call when nothing is. */
  async close(): Promise<void> {
    const open = this.#library;
    this.#library = undefined;
    if (open === undefined) return;
    await open.close();
    log.info("library closed", { root: open.root });
  }

  async #open(library: Library): Promise<LibrarySummary> {
    // The previous library goes first, and only once the new one is open: a
    // failed open must not leave the window holding nothing.
    await this.close();
    this.#library = library;
    log.info("library opened", { root: library.root, name: library.manifest.name });
    return summarize(library);
  }

  #require(): Library {
    const library = this.#library;
    if (library === undefined) throw new NoLibraryOpenError();
    return library;
  }
}

/**
 * Asked for something that needs a library, with none open.
 *
 * A `RoostError` would need a code in `@roost/core`'s list, and this is not a
 * fact about a library — it is a fact about the order the window asked things
 * in. It crosses the wire as an ordinary error, with the code `remote`.
 */
export class NoLibraryOpenError extends Error {
  constructor() {
    super("No library is open");
    this.name = "NoLibraryOpenError";
  }
}

function summarize(library: Library): LibrarySummary {
  return {
    root: library.root,
    name: library.manifest.name,
    id: library.manifest.id,
    formatVersion: library.manifest.roost_library_version,
    schemaVersion: library.db.schemaVersion(),
  };
}

/**
 * The counts, mapped field by field onto the wire shape.
 *
 * Not a spread of `Stats`: the two types are allowed to differ, and this is the
 * place that has to notice when they do (ADR-0007).
 */
function statsOf(library: Library): LibraryStats {
  const counts = library.stats();
  return {
    assets: counts.assets,
    managed: counts.managed,
    referenced: counts.referenced,
    partialHashes: counts.partialHashes,
    totalBytes: counts.totalBytes,
    tags: counts.tags,
    tagGroups: counts.tagGroups,
    folders: counts.folders,
    smartFolders: counts.smartFolders,
    rated: counts.rated,
    favorites: counts.favorites,
    notes: counts.notes,
    thumbnails: counts.thumbnails,
  };
}

/**
 * One row, mapped field by field onto the wire shape.
 *
 * `origName` becomes `name`: the wire calls it what the grid draws, and the
 * column keeps the name that says it is the user's original (ADR-0007 — the
 * duplication is the boundary).
 */
function cardOf(hit: SearchHit): AssetPage["assets"][number] {
  return {
    hash: hit.hash,
    name: hit.origName,
    ext: hit.ext,
    size: hit.size,
    width: hit.width,
    height: hit.height,
    importedAt: hit.importedAt,
    rating: hit.rating,
    isFavorite: hit.isFavorite,
  };
}

/**
 * The navigation pane, mapped onto one row shape.
 *
 * Four sections that are four different types in `@roost/library` become one
 * type on the wire, because the renderer draws them the same way and a row that
 * differs per section would be four components instead of one. The depth and
 * the group are what the sections actually vary by.
 */
function sidebarOf(library: Library): WireSidebar {
  const sidebar = readSidebar(library);
  const depths = new Map<number, number>();
  for (const folder of sidebar.folders) {
    // The rows arrive parents-first, so a parent's depth is known by the time
    // its children are read. A folder whose parent is missing is corruption,
    // and it lands at the root rather than disappearing.
    depths.set(folder.id, folder.parentId === null ? 0 : (depths.get(folder.parentId) ?? 0) + 1);
  }

  return {
    places: sidebar.places.map(
      (place): SidebarRow => ({
        id: place.id,
        name: place.name,
        query: place.query,
        // No count: it would be one query per place on every sidebar read, and
        // nothing in `UI_SPEC.md` §4.1 shows one.
        count: null,
        depth: 0,
        group: null,
      }),
    ),
    folders: sidebar.folders.map(
      (folder): SidebarRow => ({
        id: `folder:${folder.id}`,
        name: folder.name,
        query: folder.query,
        count: folder.count,
        depth: depths.get(folder.id) ?? 0,
        group: null,
      }),
    ),
    smartFolders: sidebar.smartFolders.map(
      (smart): SidebarRow => ({
        id: `smart:${smart.id}`,
        name: smart.name,
        query: smart.query,
        // A match count would mean running every saved query on every read.
        // `UI_SPEC.md` §4.1 asks for one; it arrives with the search field,
        // which is what makes a count cheap enough to want.
        count: null,
        depth: 0,
        group: null,
      }),
    ),
    tags: sidebar.tags.map(
      (tag): SidebarRow => ({
        id: `tag:${tag.name}`,
        name: tag.name,
        query: tag.query,
        count: tag.count,
        depth: 0,
        group: tag.group,
      }),
    ),
  };
}

/**
 * Whether a query parses, without running it.
 *
 * A parse failure is **not** an error here: a half-typed query is the normal
 * state of a search field, and answering with a rejected request would make the
 * renderer read a failure as a fault. Anything that is not a `QueryError` still
 * throws — a library that cannot be read is a fault.
 *
 * The empty query is checked without the compiler, because it has no term to
 * parse and means the whole library.
 */
function check(library: Library, query: string): QueryCheck {
  if (query.trim() === "") return { ok: true, message: null, at: null };
  try {
    // Compiled, not merely parsed: `folder:` resolves against this library's
    // tree, so `folder:Nonexistent` has to reach the compiler to be judged —
    // and it is *valid*, matching nothing, which is a distinction a parser
    // alone cannot make.
    compileFor(library, query);
    return { ok: true, message: null, at: null };
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
    return { ok: false, message: error.message, at: error.at ?? null };
  }
}

/** Content hashes, re-checked at the engine's own boundary (ADR-0007). */
function hashes(values: readonly string[]): ContentHash[] {
  return values.map(parseContentHash);
}

/**
 * One asset, mapped field by field onto the wire shape.
 *
 * `storageMode` is narrowed rather than passed through: the column is a string
 * and the wire says it is one of two values, so this is where a third one would
 * be caught instead of reaching a renderer that switches on it.
 */
function detailOf(detail: AssetDetail): WireAssetDetail {
  return {
    hash: detail.hash,
    name: detail.origName,
    ext: detail.ext,
    size: detail.size,
    width: detail.width,
    height: detail.height,
    storageMode: storageMode(detail.storageMode),
    refPath: detail.refPath,
    isPartialHash: detail.isPartialHash,
    createdAt: detail.createdAt,
    importedAt: detail.importedAt,
    rating: detail.rating,
    note: detail.note,
    isFavorite: detail.isFavorite,
    tags: detail.tags,
    folders: detail.folders,
  };
}

function storageMode(value: string): StorageMode {
  if (value !== "managed" && value !== "referenced") {
    throw new Error(`unknown storage mode in the index: ${value}`);
  }
  return value;
}
