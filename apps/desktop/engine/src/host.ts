import { resolve } from "node:path";
import type {
  AssetKind,
  AssetPage,
  DeriveProgress,
  ImportProgress,
  LibraryStats,
  LibrarySummary,
  QueryCheck,
  Request,
  ResponseOf,
  SidebarRow,
  WireAssetDetail,
  WireComment,
  WireCursor,
  WireDeriveStatus,
  WireImportReport,
  WireSidebar,
} from "@roost/contract";
import {
  type AssetDetail,
  type CommentRow,
  type ContentHash,
  type Cursor,
  lastCursor,
  logger,
  parseContentHash,
  type SearchHit,
  type StorageMode,
  type SubtitleRow,
} from "@roost/core";
import {
  addComment,
  compileFor,
  createAsset,
  type DeriveReport,
  emptyTrash,
  enqueueMissing,
  ensurePreview,
  exportAssets,
  forgetLibrary,
  type ImportReport,
  importInto,
  Library,
  libraryDirectory,
  libraryNameFromPath,
  listRecent,
  matches,
  pageOf,
  pinLibrary,
  queueStatus,
  rate,
  readSidebar,
  rememberLibrary,
  removeAssets,
  removeComment,
  renameAsset,
  restoreAssets,
  retryBlocked,
  retryFailed,
  runDerives,
  setComment,
  setFavorite,
  setNote,
  setPoster,
  tagAdd,
  tagRemove,
  trashAssets,
} from "@roost/library";
import { capabilities } from "@roost/media";
import { formatFromExtension, isConvertible, kindOf } from "@roost/media/serving";
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

      case "recent:list":
        return listRecent();

      case "recent:forget":
        return forgetLibrary(request.root);

      case "recent:pin":
        return pinLibrary(request.root, request.pinned);

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
        const library = this.#require();
        const found = library.db.repo.assetDetail(parseContentHash(request.hash));
        if (found === undefined) return null;
        // The preview size is made on first use, which is what asking for an
        // asset's detail is: the inspector and the preview pane both draw
        // `@512`, and generating it for every asset up front would be 34 GB at
        // a million (`serving.ts`). One asset, and only if it already has a
        // grid thumbnail — proof that something here can draw it.
        await ensurePreview(library, request.hash);
        return detailOf(
          found,
          library.db.repo.commentsFor(found.hash),
          library.db.repo.subtitlesFor(found.hash),
        );
      }

      case "asset:summary":
        return this.#require().db.repo.selectionSummary(hashes(request.hashes));

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

      case "asset:poster":
        return this.#edit(async () => {
          const pinned = await setPoster(
            this.#require(),
            parseContentHash(request.hash),
            request.atMs,
          );
          // The picture is not made here: the service queues the derive at
          // interactive priority and this works the queue in the background,
          // which is the same path a rebuild takes. Nothing to work when the
          // moment was already the one asked for.
          if (pinned) void this.#runDerives();
        });

      case "asset:create":
        // Not an import: there is no source file, and the name is not a
        // filename anything found on disk. What it writes is the ordinary
        // `add`, so nothing downstream has to know the difference.
        return this.#editReporting(async () => {
          const made = await createAsset(
            this.#require(),
            request.name,
            new TextEncoder().encode(request.text),
          );
          if (made.created) void this.#runDerives();
          return made;
        });

      case "asset:rename":
        return this.#edit(() =>
          renameAsset(this.#require(), parseContentHash(request.hash), request.name),
        );

      case "asset:tagAdd":
        return this.#edit(() => tagAdd(this.#require(), hashes(request.hashes), request.tags));

      case "asset:tagRemove":
        return this.#edit(() => tagRemove(this.#require(), hashes(request.hashes), request.tags));

      // The id `addComment` mints is deliberately dropped: the caller re-reads
      // the asset like every other edit, and an id held in the renderer would
      // be a second idea of a list the engine already answers with.
      case "comment:add":
        return this.#edit(async () => {
          await addComment(
            this.#require(),
            parseContentHash(request.hash),
            request.atMs,
            request.body,
          );
        });

      case "comment:set":
        return this.#edit(() =>
          setComment(this.#require(), request.id, request.atMs, request.body),
        );

      case "comment:remove":
        return this.#edit(() => removeComment(this.#require(), request.id));

      case "assets:trash":
        return this.#edit(() => trashAssets(this.#require(), hashes(request.hashes)));

      case "assets:restore":
        return this.#edit(() => restoreAssets(this.#require(), hashes(request.hashes)));

      case "assets:remove":
        return this.#edit(() => removeAssets(this.#require(), hashes(request.hashes)));

      case "assets:emptyTrash":
        return this.#editReporting(() => emptyTrash(this.#require()));

      case "import:paths":
        return this.#import(request.paths, request.mode, request.tags);

      case "derive:status":
        return this.#deriveStatus();

      case "derive:retry": {
        const library = this.#require();
        retryBlocked(library, request.reason ?? undefined);
        retryFailed(library);
        // The queue is worked in the background rather than awaited: the button
        // that sent this should not sit disabled through a thousand videos, and
        // the window learns what happened from `job:progress` like any other
        // run.
        void this.#runDerives();
        return this.#deriveStatus();
      }

      case "assets:export":
        // No journal line: nothing about the library changed. An export reads
        // the store and writes outside it, which is the one direction that is
        // not a mutation.
        return exportAssets(this.#require(), hashes(request.hashes), request.destination);

      case "clipboard:paste":
      case "dialog:chooseImport":
      case "asset:openExternally":
      case "asset:reveal":
      case "asset:copyPath":
      case "dialog:openLibrary":
      case "dialog:chooseLocation":
        // A dialog belongs to a window and this process has none, and the
        // clipboard belongs to the desktop. Main answers these before
        // forwarding; one arriving here is a routing bug, and it fails loudly
        // rather than returning a plausible null.
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
   * Imports paths, reporting progress as it goes.
   *
   * Progress is throttled to one event per {@link PROGRESS_EVERY} files rather
   * than one per file. A bulk import runs at hundreds of files a second and
   * every event is a `structuredClone` across two process boundaries; a status
   * bar cannot show more than a few a second, and the ones in between would
   * cost the import measurably.
   *
   * `library:changed` is announced once at the end, not per file: it makes the
   * window re-read the counts, the sidebar, and the match count, and doing that
   * per file would be an import that spends its time redrawing.
   */
  async #import(
    paths: readonly string[],
    mode: StorageMode,
    tags: readonly string[],
  ): Promise<WireImportReport> {
    const library = this.#require();
    let announced = 0;

    const report = await importInto(library, paths, { mode, tags: [...tags] }, (_path, running) => {
      if (running.scanned - announced < PROGRESS_EVERY) return;
      announced = running.scanned;
      this.onProgress?.(progressOf(running, 0));
    });
    this.onProgress?.(progressOf(report, 0));

    // Derived work is part of the same run here, unlike the CLI, where `import`
    // and `thumb` are separate commands. A headless import into a library
    // nobody is looking at should not pay for pictures; an import someone is
    // watching produces a screen of placeholders without them.
    //
    // The importer has already queued the jobs, in the transaction that wrote
    // the rows — this only works the queue.
    const derived = await this.#runDerives((running) => {
      this.onProgress?.(progressOf(report, running.derived));
    });

    this.onChanged?.();
    return reportOf(report, derived?.derived ?? 0);
  }

  /**
   * Works the derive queue, once at a time.
   *
   * One run per host: a second caller joins the run in flight rather than
   * starting another, because two runners on one library would claim different
   * halves of the same queue and finish no sooner. The window learns what
   * happened from `job:progress`.
   */
  async #runDerives(
    onProgress?: (report: DeriveReport) => void,
  ): Promise<DeriveReport | undefined> {
    const library = this.#library;
    if (library === undefined) return undefined;

    const running = this.#deriving;
    if (running !== undefined) return running;

    this.#stopDeriving = new AbortController();
    const run = runDerives(library, {
      signal: this.#stopDeriving.signal,
      onProgress: (report) => {
        onProgress?.(report);
        this.onJobProgress?.({
          derived: report.derived,
          remaining: queueStatus(library).ready,
          blocked: report.blocked,
          failed: report.failed,
        });
      },
    }).finally(() => {
      this.#deriving = undefined;
    });

    this.#deriving = run;
    const report = await run;
    // Announced once at the end: the grid re-reads and the cells that were
    // placeholders find their thumbnails. Per batch would be a redraw every
    // hundred assets for a run that can take minutes.
    if (report.derived > 0) this.onChanged?.();
    return report;
  }

  #deriving: Promise<DeriveReport> | undefined;
  #stopDeriving: AbortController | undefined;

  /** Called as the derive queue works. Set by `serve`, like {@link onChanged}. */
  onJobProgress: ((progress: DeriveProgress) => void) | undefined;

  /** What the queue holds, and what this machine can draw. */
  async #deriveStatus(): Promise<WireDeriveStatus> {
    const status = queueStatus(this.#require());
    return {
      ready: status.ready,
      running: status.running,
      blocked: status.blocked,
      failed: status.failed,
      reasons: status.reasons.map((row) => ({ reason: row.reason, count: row.count })),
      capabilities: (await capabilities()).map((capability) => ({
        name: capability.name,
        available: capability.available,
        version: capability.version,
        detail: capability.detail,
      })),
    };
  }

  /** Called while an import runs. Set by `serve`, like {@link onChanged}. */
  onProgress: ((progress: ImportProgress) => void) | undefined;

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
   * An edit whose answer is more than "it happened".
   *
   * Emptying the trash is the one so far: the count is over what the engine
   * sees rather than over a selection the renderer sent, so the renderer has no
   * way to compute what to put in the status bar.
   */
  async #editReporting<T>(run: () => Promise<T>): Promise<T> {
    const result = await run();
    this.onChanged?.();
    return result;
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

    // The runner is stopped before the library is: it commits batch by batch,
    // so a run cut short here has already kept everything it finished, and a
    // batch that lands after the database is closed would throw instead.
    this.#stopDeriving?.abort();
    await this.#deriving?.catch(() => undefined);

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

    // Whatever the last session left undone, plus whatever a rebuild dropped.
    // Queued and worked in the background, so opening a library is not held up
    // by a hundred thousand thumbnails — the window draws placeholders and they
    // fill in (`ARCHITECTURE.md` §4.5).
    enqueueMissing(library);
    void this.#runDerives();

    // After the library is open, and never in its way: the picker's list is a
    // convenience, and a state file that cannot be written must not cost
    // somebody the library they just opened (`recent.ts`).
    await rememberLibrary({
      root: library.root,
      name: library.manifest.name,
      id: library.manifest.id,
    });

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
    trashed: counts.trashed,
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
    kind: kindOf(formatFromExtension(hit.ext)) satisfies AssetKind,
    size: hit.size,
    // Part of the thumbnail's address rather than something a cell draws: see
    // `AssetCard` in the contract.
    posterMs: hit.posterMs,
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
        // Only Trash carries one — every other place would cost a query per
        // sidebar read for a number `UI_SPEC.md` §4.1 does not show.
        count: place.count,
        depth: 0,
        group: null,
      }),
    ),
    ratings: sidebar.ratings.map(
      (rating): SidebarRow => ({
        id: rating.id,
        name: rating.name,
        query: rating.query,
        // Unlike the places, every one of these carries a count: one grouped
        // statement answers all five, and the number is what makes the row
        // worth a click.
        count: rating.count,
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
function detailOf(
  detail: AssetDetail,
  comments: readonly CommentRow[],
  tracks: readonly SubtitleRow[],
): WireAssetDetail {
  return {
    hash: detail.hash,
    name: detail.origName,
    ext: detail.ext,
    kind: kindOf(formatFromExtension(detail.ext)) satisfies AssetKind,
    size: detail.size,
    posterMs: detail.posterMs,
    width: detail.width,
    height: detail.height,
    storageMode: storageMode(detail.storageMode),
    refPath: detail.refPath,
    isPartialHash: detail.isPartialHash,
    createdAt: detail.createdAt,
    importedAt: detail.importedAt,
    trashedAt: detail.trashedAt,
    supersededBy: detail.supersededBy,
    rating: detail.rating,
    note: detail.note,
    isFavorite: detail.isFavorite,
    tags: detail.tags,
    folders: detail.folders,
    durationMs: detail.durationMs,
    pageCount: detail.pageCount,
    props: detail.props,
    comments: comments.map(commentOf),
    subtitles: tracks.map((track) => ({
      hash: track.trackHash,
      lang: track.lang,
      label: track.label,
      name: track.name,
      // Decided from the extension rather than by reading the file: the menu
      // draws before anything is fetched, and what cannot be converted here
      // needs a capability that may be absent (ADR-0017).
      servable: isConvertible(track.ext),
    })),
  };
}

/**
 * One comment, mapped field by field.
 *
 * The `hash` is dropped: these arrive inside the detail of the asset they are
 * on, so carrying it would be a second copy of what the reader asked by. `atMs`
 * keeps its name — it is the one number here that is milliseconds rather than
 * unix seconds (ADR-0023), and a field called `at` beside `createdAt` would
 * invite reading the two as the same kind of number.
 */
function commentOf(row: CommentRow): WireComment {
  return {
    id: row.id,
    atMs: row.atMs,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function storageMode(value: string): StorageMode {
  if (value !== "managed" && value !== "referenced") {
    throw new Error(`unknown storage mode in the index: ${value}`);
  }
  return value;
}

/**
 * How many files pass before another progress event is sent.
 *
 * `CONCEPT.md` §7 asks for at least 300 imports a second, so this is roughly
 * three events a second at the target rate — faster than a status bar can be
 * read and slow enough to cost nothing.
 */
const PROGRESS_EVERY = 100;

function progressOf(report: ImportReport, thumbnails: number): ImportProgress {
  return {
    scanned: report.scanned,
    imported: report.imported,
    duplicates: report.duplicates + report.partialDuplicates,
    failed: report.failed.length + report.partialCollisions,
    thumbnails,
  };
}

/**
 * The report, mapped field by field.
 *
 * The timings are dropped on purpose: they are a benchmark's business, and a
 * window that showed them would invite reading one run as a measurement.
 */
function reportOf(report: ImportReport, thumbnails: number): WireImportReport {
  return {
    scanned: report.scanned,
    imported: report.imported,
    duplicates: report.duplicates,
    partialDuplicates: report.partialDuplicates,
    partialCollisions: report.partialCollisions,
    bytes: report.bytes,
    thumbnails,
    elapsedMs: Math.round(report.elapsed),
    failed: report.failed.map((failure) => ({ path: failure.path, reason: failure.reason })),
  };
}
