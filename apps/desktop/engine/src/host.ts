import { resolve } from "node:path";
import type {
  AssetKind,
  AssetPage,
  DeriveProgress,
  ImportProgress,
  InstallableBackend,
  LibraryStats,
  LibrarySummary,
  QueryCheck,
  Request,
  ResponseOf,
  SidebarFolderRow,
  SidebarRow,
  WireAssetDetail,
  WireComment,
  WireCursor,
  WireDeriveStatus,
  WireEagleReport,
  WireEagleSurvey,
  WireFiled,
  WireImportReport,
  WireSidebar,
  WireSort,
  WireTransferReport,
} from "@roost/contract";
import {
  type AssetDetail,
  type AssetId,
  type CommentRow,
  type Cursor,
  lastCursor,
  logger,
  parseAssetId,
  type SearchHit,
  type SubtitleRow,
  type Take,
} from "@roost/core";
import {
  addComment,
  addSubtitles,
  addToFolder,
  catchUp,
  check as checkLibrary,
  compileFor,
  createAsset,
  createFolder,
  type DeriveReport,
  deleteFolder,
  deleteSubtitle,
  deriveFailures,
  type EagleReport,
  type EagleSurvey,
  emptyTrash,
  enqueueMissing,
  ensurePreview,
  exportAssets,
  type FileWatcher,
  type FoldProgress,
  forgetLibrary,
  type ImportReport,
  importEagle,
  importInto,
  Library,
  libraryDirectory,
  libraryNameFromPath,
  listRecent,
  matches,
  moveFolder,
  pageOf,
  pinLibrary,
  queueStatus,
  type Redrawn,
  Requested,
  rate,
  readSidebar,
  reclaim,
  reclaimableBytes,
  releaseNowSupported,
  rememberLibrary,
  removeAssets,
  removeComment,
  removeFromFolder,
  renameAsset,
  renameFolder,
  restoreAssets,
  retryBlocked,
  retryFailed,
  runDerives,
  setComment,
  setNote,
  setPoster,
  setSource,
  surveyEagle,
  type TransferProgress,
  type TransferReport,
  TransferRunningError,
  tagAdd,
  tagRemove,
  transferToLibrary,
  trashAssets,
  unsoundForReclaim,
  Wanted,
  watchFiles,
} from "@roost/library";
import { capabilities, GRID_SIZE, installBackend, refreshCapabilities } from "@roost/media";
import {
  formatFromExtension,
  isBrowserDrawable,
  isConvertible,
  kindOf,
} from "@roost/media/serving";
import { joinQuery, QueryError, splitQuery, withSubfolders } from "@roost/search";

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
   * The duplicates the last import found, waiting for an answer (ADR-0037 §3).
   *
   * Held here rather than sent to the window because a re-import of a large
   * directory produces more hashes than a dialog should be handed and then
   * hand back. It is replaced by the next run and dropped with the library, so
   * a dialog left open across either is answered with `expired`.
   */
  #duplicates: AssetId[] | undefined;

  /**
   * Answers one request.
   *
   * Exhaustive over the union with no `default`: a member added to the contract
   * then fails to compile here, which is the only place that failure is cheap.
   */
  async handle(request: Request): Promise<ResponseOf<Request["type"]>> {
    switch (request.type) {
      case "library:open":
        return this.#open(
          await Library.open(resolve(request.path), {
            exclusive: true,
            onFold: this.#foldAnnouncer(),
          }),
        );

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
        return this.#page(request.query, request.limit, request.after, request.sort);

      case "assets:count":
        return matches(this.#require(), request.query);

      case "query:check":
        return check(this.#require(), request.query);

      // Both are pure functions of a string and neither touches the library,
      // but they live here rather than in the renderer for the reason
      // `UI_SPEC.md` §4.1 gives: the grammar has one implementation, and it is
      // not in the sandbox.
      case "query:split":
        return splitQuery(request.query);

      case "query:join":
        return joinQuery(request.place, request.facets);

      case "query:subfolders":
        return withSubfolders(request.query, request.on);

      case "settings:read":
        return this.#require().settings;

      case "settings:write": {
        const library = this.#require();
        // A patch, so a build that learns a second setting need not send the
        // first one back. The write may not reach the disk — ADR-0019 calls
        // that the correct outcome for a library nobody can write to — and the
        // answer is what the engine now holds either way.
        if (request.showSubfolderContents !== undefined) {
          await library.updateSettings({
            showSubfolderContents: request.showSubfolderContents,
          });
          // Announced like an edit, though nothing in the library changed: this
          // setting decides the **term every folder row carries**, so a pane
          // that was not re-read would keep rows asking the other depth — stale
          // counts, and the row for the folder on screen no longer matching the
          // query, so it would quietly stop being marked as current.
          this.onChanged?.();
        }
        // Everything else here is a preference about how the window draws what
        // it already has — the video's fit (ADR-0024 §8), the volume, the
        // order, the view, the zoom, which panes are drawn (ADR-0028 §6) — so
        // none of them is announced: no query answers
        // differently, and the window that sent it is already drawing the new
        // state. The keys are applied in one write rather than one each,
        // because a menu can change two at once (choosing `random` rolls a
        // seed) and two writes would be two reads of the file.
        const quiet = {
          ...(request.fitVideoToWindow !== undefined && {
            fitVideoToWindow: request.fitVideoToWindow,
          }),
          ...(request.mediaVolume !== undefined && { mediaVolume: request.mediaVolume }),
          ...(request.mediaMuted !== undefined && { mediaMuted: request.mediaMuted }),
          ...(request.sortKey !== undefined && { sortKey: request.sortKey }),
          ...(request.sortDescending !== undefined && { sortDescending: request.sortDescending }),
          ...(request.shuffleSeed !== undefined && { shuffleSeed: request.shuffleSeed }),
          ...(request.gridView !== undefined && { gridView: request.gridView }),
          ...(request.matchImageProportions !== undefined && {
            matchImageProportions: request.matchImageProportions,
          }),
          ...(request.gridZooms !== undefined && { gridZooms: request.gridZooms }),
          ...(request.showFolders !== undefined && { showFolders: request.showFolders }),
          ...(request.showSidebar !== undefined && { showSidebar: request.showSidebar }),
          ...(request.showInspector !== undefined && { showInspector: request.showInspector }),
          ...(request.sidebarWidth !== undefined && { sidebarWidth: request.sidebarWidth }),
          ...(request.inspectorWidth !== undefined && { inspectorWidth: request.inspectorWidth }),
        };
        if (Object.keys(quiet).length > 0) await library.updateSettings(quiet);
        return library.settings;
      }

      case "asset:detail": {
        const library = this.#require();
        const found = library.db.repo.assetDetail(parseAssetId(request.id));
        if (found === undefined) return null;
        // The preview size is made on first use, which is what asking for an
        // asset's detail is: the inspector and the preview pane both draw
        // `@512`, and generating it for every asset up front would be 34 GB at
        // a million (`serving.ts`). One asset, and only if it already has a
        // grid thumbnail — proof that something here can draw it.
        await ensurePreview(library, request.id);
        // Opened while the queue is paused: its thumbnail is made now, and the
        // rest keeps waiting (ADR-0049). A file with nothing queued is skipped
        // by the runner, so there is nothing to check here first.
        if (this.#paused) {
          this.#requested.open(found.id);
          void this.#runDerives();
        }
        return detailOf(
          found,
          library.db.repo.commentsFor(found.id),
          library.db.repo.subtitlesFor(found.id),
          library.db.repo.stalledReasons("derive", [found.id]).get(found.id) ?? null,
        );
      }

      case "asset:summary":
        return this.#require().db.repo.selectionSummary(ids(request.ids));

      case "asset:rate":
        return this.#edit(() => rate(this.#require(), ids(request.ids), request.rating));

      case "asset:note":
        return this.#edit(() => setNote(this.#require(), ids(request.ids), request.note));

      case "asset:source":
        return this.#edit(() => setSource(this.#require(), ids(request.ids), request.url));

      case "asset:poster":
        return this.#edit(async () => {
          const pinned = await setPoster(this.#require(), parseAssetId(request.id), request.atMs);
          // A gesture about this one file, so a pause does not hold it back.
          if (pinned && this.#paused) this.#requested.open(parseAssetId(request.id));
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
          const id = await createAsset(
            this.#require(),
            request.name,
            new TextEncoder().encode(request.text),
          );
          // Always a new asset in version 2, so the derive always has work.
          if (this.#paused) this.#requested.open(parseAssetId(id));
          void this.#runDerives();
          return { id };
        });

      case "asset:addSubtitle":
        // Answers a count rather than `null`, because "nothing was attached"
        // and "three were" are different outcomes of the same gesture and the
        // status bar says which.
        return this.#editReporting(() =>
          addSubtitles(this.#require(), parseAssetId(request.id), request.paths),
        );

      case "asset:subtitleDelete":
        return this.#edit(() =>
          deleteSubtitle(this.#require(), parseAssetId(request.id), parseAssetId(request.track)),
        );

      case "asset:rename":
        return this.#edit(() =>
          renameAsset(this.#require(), parseAssetId(request.id), request.name),
        );

      case "asset:tagAdd":
        return this.#edit(() => tagAdd(this.#require(), ids(request.ids), request.tags));

      case "asset:tagRemove":
        return this.#edit(() => tagRemove(this.#require(), ids(request.ids), request.tags));

      // Both raise on a folder that is not there rather than doing nothing:
      // a window offering a folder the library has lost is a window reading a
      // stale tree, and silence would leave it reading one.
      case "asset:folderAdd":
        return this.#edit(() => addToFolder(this.#require(), ids(request.ids), request.folder));

      case "asset:folderRemove":
        return this.#edit(() =>
          removeFromFolder(this.#require(), ids(request.ids), request.folder),
        );

      // The tree's own three (ADR-0033). `create` answers with the id because
      // the window goes to the folder it just made; the other two follow the
      // house rule and answer with what the caller could not have known —
      // nothing, and how many assets went to the trash.
      case "folder:create":
        return this.#editReporting(() =>
          createFolder(this.#require(), request.name, request.parent),
        );

      case "folder:rename":
        return this.#edit(() => renameFolder(this.#require(), request.folder, request.name));

      // Raises on a cycle rather than doing nothing: the pane offered the drop,
      // and a refusal it cannot see is a gesture that appears to have worked.
      case "folder:move":
        return this.#edit(() => moveFolder(this.#require(), request.folder, request.parent));

      case "folder:delete":
        return this.#editReporting(() =>
          deleteFolder(this.#require(), request.folder, {
            trashContents: request.trashContents,
          }),
        );

      // The id `addComment` mints is deliberately dropped: the caller re-reads
      // the asset like every other edit, and an id held in the renderer would
      // be a second idea of a list the engine already answers with.
      case "comment:add":
        return this.#edit(async () => {
          await addComment(
            this.#require(),
            parseAssetId(request.asset),
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
        return this.#edit(() => trashAssets(this.#require(), ids(request.ids)));

      case "assets:restore":
        return this.#edit(() => restoreAssets(this.#require(), ids(request.ids)));

      case "assets:remove":
        // Reporting, because the bytes freed are the half of this that used to
        // be missing (ADR-0031): a person deleting to make room needs to see
        // that room appear.
        return this.#editReporting(() => removeAssets(this.#require(), ids(request.ids)));

      case "assets:emptyTrash":
        return this.#editReporting(() => emptyTrash(this.#require()));

      case "library:reclaimable": {
        const report = await checkLibrary(this.#require());
        return {
          objects: report.orphans.length,
          bytes: reclaimableBytes(report),
          blocked: unsoundForReclaim(report) ?? null,
        };
      }

      case "library:reclaim": {
        const library = this.#require();
        // Checked again rather than trusting the numbers the dialog showed:
        // this deletes files, and that report is a screenful old.
        const report = await checkLibrary(library);
        const bytes = await reclaim(library, report);
        return { objects: report.orphans.length, bytes, blocked: null };
      }

      case "import:paths":
        return this.#import(request.paths, request.take, request.tags, request.folder);

      case "import:fileDuplicates":
        return this.#fileDuplicates(request.folder);

      case "eagle:survey":
        // No library is required, and none is opened: this reads somebody
        // else's directory and writes nothing (ADR-0032 §6).
        return wireSurvey(await surveyEagle(request.path));

      case "eagle:import":
        return this.#importEagle(request.path, request.take);

      case "derive:status":
        return this.#deriveStatus();

      case "derive:failures":
        return deriveFailures(this.#require(), { state: request.state });

      case "derive:pause": {
        // Remembered before anything stops, so a crash in between still comes
        // back paused — which is what was asked for (ADR-0049).
        await this.#require().updateSettings({ derivePaused: true });
        this.#paused = true;
        // What is in flight finishes; nothing new is claimed.
        this.#stopDeriving?.abort();
        return this.#deriveStatus();
      }

      case "folder:covers": {
        // Four per folder, at the grid's size: a tile draws a 2×2 of them.
        const covers = this.#require().db.repo.folderCovers(request.folders, GRID_SIZE, 4);
        return [...covers].map(([folder, assets]) => ({
          folder,
          assets: assets.map((asset) => ({
            id: asset.id,
            posterMs: asset.posterMs,
            derivedAt: asset.derivedAt,
          })),
        }));
      }

      case "derive:retryAsset": {
        const library = this.#require();
        const id = parseAssetId(request.id);
        // Probed again first, for the reason `derive:retry` is: the tool this
        // file was waiting for may have been installed a minute ago.
        await refreshCapabilities();
        if (!library.db.repo.requeueJobFor("derive", id)) return false;
        // Next, whichever way the queue is running: somebody is looking at it.
        if (this.#paused) this.#requested.open(id);
        else this.#wanted.add([id]);
        void this.#runDerives();
        return true;
      }

      case "derive:resume": {
        await this.#require().updateSettings({ derivePaused: false });
        this.#paused = false;
        this.#requested.clear();
        // A paused run working an opened file may be in flight, and a second
        // caller joins the run in flight rather than starting one — so it is
        // stopped, and the whole queue started once it has let go.
        this.#stopDeriving?.abort();
        const letting = this.#deriving;
        if (letting === undefined) void this.#runDerives();
        else void letting.catch(() => undefined).then(() => this.#runDerives());
        return this.#deriveStatus();
      }

      case "derive:wanted":
        // Nothing is started here. Work is only ever wanted because it is
        // queued, and a queue with work in it is already being worked: the run
        // in flight reads this at its next claim.
        if (this.#library !== undefined) this.#wanted.add(ids(request.ids));
        return null;

      case "derive:retry": {
        const library = this.#require();
        // **Probe again first.** The whole point of this button is that
        // somebody has just installed the thing that was missing, and the
        // capabilities are cached for the life of the process (ADR-0017) — so
        // without this, releasing the work only hands it back to a backend this
        // process still believes is absent. It was never wired until the day
        // libheif arrived and proved it (ADR-0040 §6).
        await refreshCapabilities();
        // Paused, the button still does what it says — for what it releases,
        // and not for the rest of the queue (ADR-0049). Read before the release,
        // which is what turns these rows back into ordinary queued work.
        if (this.#paused) {
          const everything = Number.MAX_SAFE_INTEGER;
          const parked = library.db.repo
            .jobsIn("derive", "blocked", everything)
            .filter((row) => request.reason === null || row.reason === request.reason);
          const failed = library.db.repo.jobsIn("derive", "failed", everything);
          this.#requested.queue([...parked, ...failed].map((row) => row.assetId));
        }
        retryBlocked(library, request.reason ?? undefined);
        // Every failure, however many times it has already been tried. The
        // attempts cap belongs to the sweep that offers work again on its own;
        // a person who has just read what went wrong and pressed the button has
        // asked for this one, and a button that silently declined would be the
        // same dead end it is replacing.
        retryFailed(library, Number.MAX_SAFE_INTEGER);
        // The queue is worked in the background rather than awaited: the button
        // that sent this should not sit disabled through a thousand videos, and
        // the window learns what happened from `job:progress` like any other
        // run.
        void this.#runDerives();
        return this.#deriveStatus();
      }

      case "capability:install": {
        // No library is required and none is touched: this is a fact about the
        // machine, not about a collection. A window with nothing open can still
        // be told what it is missing, and can still fix it.
        const outcome = await installBackend(request.backend, (line) => {
          this.onInstallProgress?.(request.backend, line);
        });
        // Either way, and before answering: a refusal is often "already
        // installed", which means the probe this process is holding is the
        // thing that is wrong (ADR-0040 §6).
        await refreshCapabilities();
        return {
          installed: outcome.installed,
          detail: outcome.detail,
          capabilities: await wireCapabilities(),
        };
      }

      case "assets:export":
        // No journal line: nothing about the library changed. An export reads
        // the store and writes outside it, which is the one direction that is
        // not a mutation.
        return exportAssets(this.#require(), ids(request.ids), request.destination);

      case "assets:transfer":
        // Reporting, because what arrived, what merged and what stayed behind
        // are different outcomes of one gesture, and the status bar says which.
        // The target is opened and closed inside the call and never becomes
        // this host's library (ADR-0054 §3.7).
        return this.#editReporting(async () =>
          wireTransfer(
            await this.#transfer(resolve(request.target), ids(request.ids), request.take),
          ),
        );

      case "assets:transferCancel": {
        const running = this.#transferring !== undefined;
        this.#transferring?.controller.abort();
        return running;
      }

      case "clipboard:paste":
      case "clipboard:copyText":
      case "link:open":
      case "dialog:chooseImport":
      case "dialog:chooseSubtitle":
      case "dialog:chooseEagle":
      case "asset:openExternally":
      case "asset:reveal":
      case "asset:copyPath":
      case "asset:copyFiles":
      case "asset:copyImage":
      case "asset:dragOut":
      case "handoff:cost":
      case "dialog:openLibrary":
      case "dialog:chooseLocation":
      case "app:quit":
      case "app:about":
        // A dialog belongs to a window and this process has none, the clipboard
        // and the browser belong to the desktop, quitting is the application's
        // business rather than the library's, and which build this is belongs
        // to the shell that was launched. Main answers these
        // before forwarding; one
        // arriving here is a routing bug, and it fails loudly rather than
        // returning a plausible null.
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
  #page(query: string, limit: number, after: WireCursor | null, sort: WireSort | null): AssetPage {
    const library = this.#require();
    // `parseAssetId` rather than a cast: the contract already checked the
    // shape, and this is the engine checking it again at its own boundary —
    // which is the boundary ADR-0007 says matters.
    const cursor: Cursor | undefined =
      after === null ? undefined : { key: after.key, id: parseAssetId(after.id) };

    // Spread rather than assigned: `exactOptionalPropertyTypes` makes an
    // explicit `after: undefined` a different thing from an absent one.
    const hits = pageOf(library, query, {
      limit,
      ...(sort !== null && { sort }),
      ...(cursor && { after: cursor }),
    });
    const last = hits.length < limit ? undefined : lastCursor(hits);
    const stalled = library.db.repo.stalledReasons(
      "derive",
      hits.map((hit) => hit.id),
    );
    return {
      assets: hits.map((hit) => cardOf(hit, stalled.get(hit.id) ?? null)),
      next: last === undefined ? null : { key: last.key, id: last.id },
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
    take: Take,
    tags: readonly string[],
    folder: number | null,
  ): Promise<WireImportReport> {
    const library = this.#require();
    let announced = 0;

    const options = { take, tags: [...tags], ...(folder === null ? {} : { folder }) };
    const report = await importInto(library, paths, options, (_path, running) => {
      if (handled(running) - announced < PROGRESS_EVERY) return;
      announced = handled(running);
      this.onProgress?.(progressOf(running, 0));
    });
    this.onProgress?.(progressOf(report, 0));

    // Derived work is part of the same run here, unlike the CLI, where `import`
    // and `thumb` are separate commands. A headless import into a library
    // nobody is looking at should not pay for pictures; an import someone is
    // watching produces a screen of placeholders without them.
    //
    // The importer has already queued the jobs, in the transaction that wrote
    // the rows — this only works the queue. A paused queue works these and no
    // others: an import is somebody asking for these files now (ADR-0049).
    if (this.#paused) this.#requested.queue(report.importedIds);
    const derived = await this.#runDerives((running) => {
      this.onProgress?.(progressOf(report, running.derived));
    });

    // Kept only once the run finished. A run that threw has no answer to
    // offer, and leaving the previous run's list in place would offer the
    // wrong one.
    this.#duplicates = report.duplicateIds;

    this.onChanged?.();
    return reportOf(report, derived?.derived ?? 0);
  }

  /**
   * Files the last import's duplicates into a folder (ADR-0037 §3.2).
   *
   * An add, not a move: `asset_folders` is many-to-many, so nothing leaves the
   * folders these assets are already in.
   *
   * The list is filtered before it is applied. An asset removed between the
   * import and the click would otherwise fail the whole batch, and the answer
   * to "one of these is gone" is to file the rest.
   */
  async #fileDuplicates(folder: number): Promise<WireFiled> {
    const library = this.#require();
    const held = this.#duplicates;
    if (held === undefined) return { filed: 0, expired: true };

    // A Set because one run can meet the same bytes twice: the second copy of
    // a file inside the same import is a duplicate of the first.
    const live = [...new Set(held)].filter((hash) => library.db.repo.findAsset(hash) !== undefined);
    if (live.length === 0) return { filed: 0, expired: false };

    await addToFolder(library, live, folder);
    this.onChanged?.();
    return { filed: live.length, expired: false };
  }

  /**
   * Importing an Eagle library, and then the pictures for it (ADR-0032).
   *
   * The same shape as {@link #import} and for the same reason: the CLI keeps
   * `import` and `thumb` apart because a headless run into a library nobody is
   * looking at should not pay for pictures, and a run somebody *is* watching
   * produces a screen of placeholders without them.
   *
   * Progress is reported in items rather than files. An Eagle item can be two
   * files — a video and the `.srt` beside it — and the number somebody watches
   * is the one that matches the number the survey showed them.
   */
  async #importEagle(path: string, take: Take): Promise<WireEagleReport> {
    const library = this.#require();

    const report = await importEagle(library, path, { take }, (done, total) => {
      this.onProgress?.({
        scanned: done,
        imported: done,
        duplicates: 0,
        failed: 0,
        thumbnails: 0,
        total,
      });
    });

    if (this.#paused) this.#requested.queue(report.importedIds);
    const derived = await this.#runDerives((running) => {
      this.onProgress?.({
        scanned: report.survey.items,
        imported: report.assets,
        duplicates: report.duplicates,
        failed: report.failed.length,
        thumbnails: running.derived,
        total: report.survey.items,
      });
    });

    this.onChanged?.();
    return wireEagleReport(report, derived?.derived ?? 0);
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
    let announcedAt = Number.NEGATIVE_INFINITY;
    const announce = (report: DeriveReport): void => {
      this.onJobProgress?.({
        derived: report.derived,
        remaining: queueStatus(library).ready,
        blocked: report.blocked,
        failed: report.failed,
      });
    };
    // Paused, only what was asked for by name, and nothing when nothing was.
    const paused = this.#paused;
    if (paused && this.#requested.size === 0) return undefined;
    const run = runDerives(library, {
      signal: this.#stopDeriving.signal,
      ...(paused ? { only: this.#requested } : { wanted: this.#wanted }),
      // Per batch, unlike `onChanged` below. A card the window is already
      // holding is patched with its new cache key, so a cell whose file changed
      // redraws while the rest of the run is still going — and nothing re-reads
      // a page (ADR-0047).
      onDerived: (assets) => {
        this.onDerived?.(assets);
      },
      onProgress: (report) => {
        onProgress?.(report);
        // At most once a second. The window treats the event as a cue to
        // re-read the status rather than as the numbers (`DeriveStatus.tsx`),
        // and counting what remains is ~20 ms at a million queued — which a
        // run committing four times a second would pay four times over.
        const now = performance.now();
        if (now - announcedAt < PROGRESS_MS) return;
        announcedAt = now;
        announce(report);
      },
    }).finally(() => {
      this.#deriving = undefined;
    });

    this.#deriving = run;
    const report = await run;
    // The last word is never throttled away: a run that parked everything
    // changes nothing `onChanged` would announce, and the status line would
    // otherwise go on counting down work that has stopped.
    if (this.#library === library) announce(report);
    // Announced once at the end: the grid re-reads and the cells that were
    // placeholders find their thumbnails. Per batch would be a redraw every
    // hundred assets for a run that can take minutes.
    if (report.derived > 0) this.onChanged?.();
    // Asked for while this run was letting go — a file opened just as a pause
    // stopped the last one — would otherwise wait for the next trigger.
    if (this.#library === library && this.#paused && this.#requested.size > 0) {
      void this.#runDerives();
    }
    return report;
  }

  #watcher: FileWatcher | undefined;
  #stopWatching: AbortController | undefined;
  #catchingUp: Promise<void> | undefined;
  #deriving: Promise<DeriveReport> | undefined;
  #stopDeriving: AbortController | undefined;
  /** What the window is showing placeholders for. Forgotten with the library. */
  readonly #wanted = new Wanted();
  /** Whether the queue is paused, as the library remembers it (ADR-0049). */
  #paused = false;

  /**
   * The transfer that is running, if one is (ADR-0054 §3.9).
   *
   * Held so that it can be stopped from a second request, and so that closing
   * the library waits for it: the transfer removes from the source as its last
   * step, and a database closed under it would throw half way through that.
   */
  #transferring:
    | { readonly controller: AbortController; readonly done: Promise<unknown> }
    | undefined;

  /**
   * Moves or copies into another library, one at a time.
   *
   * Progress goes out at most every {@link TRANSFER_PROGRESS_MS}: a counted copy
   * reports every four megabytes, which is hundreds of times a second from a
   * fast disk, and each is a message across two process boundaries.
   */
  async #transfer(target: string, assets: AssetId[], take: Take): Promise<TransferReport> {
    if (this.#transferring !== undefined) throw new TransferRunningError();
    const library = this.#require();
    const controller = new AbortController();
    let told = 0;
    const running = transferToLibrary(
      library,
      target,
      assets,
      { take, signal: controller.signal },
      (progress) => {
        const now = performance.now();
        const last = progress.done === progress.total;
        if (!last && now - told < TRANSFER_PROGRESS_MS) return;
        told = now;
        this.onTransferProgress?.(progress);
      },
    );
    this.#transferring = { controller, done: running.catch(() => undefined) };
    try {
      return await running;
    } finally {
      this.#transferring = undefined;
    }
  }

  /** Set by `serve`, like {@link onProgress}. */
  onTransferProgress: ((progress: TransferProgress) => void) | undefined;
  /** What a paused queue still works: opened files and new imports. */
  readonly #requested = new Requested();

  /**
   * Called while an open folds the journal. Set by `serve`, like
   * {@link onChanged}.
   */
  onFolding: ((progress: FoldProgress) => void) | undefined;

  /**
   * A fold's progress, at most ten times a second and always the last one.
   *
   * Ten because it drives a bar, which a person watches move, where
   * `job:progress` drives a count and once a second is plenty. A fold reads a
   * chunk every few milliseconds, and a message per chunk would be hundreds a
   * second for a bar that cannot draw them.
   */
  #foldAnnouncer(): (progress: FoldProgress) => void {
    let announcedAt = Number.NEGATIVE_INFINITY;
    return (progress) => {
      const now = performance.now();
      if (progress.done < progress.total && now - announcedAt < 100) return;
      announcedAt = now;
      this.onFolding?.(progress);
    };
  }

  /** Called as the derive queue works. Set by `serve`, like {@link onChanged}. */
  onJobProgress: ((progress: DeriveProgress) => void) | undefined;

  /**
   * Called with the assets a batch redrew. Set by `serve`, like
   * {@link onChanged}.
   */
  onDerived: ((assets: readonly Redrawn[]) => void) | undefined;

  /** What the queue holds, and what this machine can draw. */
  async #deriveStatus(): Promise<WireDeriveStatus> {
    const status = queueStatus(this.#require());
    return {
      paused: this.#paused,
      ready: status.ready,
      running: status.running,
      blocked: status.blocked,
      failed: status.failed,
      reasons: status.reasons.map((row) => ({ reason: row.reason, count: row.count })),
      capabilities: await wireCapabilities(),
    };
  }

  /**
   * Called with each line a running install writes. Set by `serve`.
   *
   * A line rather than a fraction: a package manager's progress is its own
   * business, and parsing it would be a guess about a format nobody promised
   * (ADR-0042 §9).
   */
  onInstallProgress: ((backend: InstallableBackend, line: string) => void) | undefined;

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
    // The list names assets in the library that is going: it cannot mean
    // anything about the next one. Nor can what its window was waiting for.
    this.#duplicates = undefined;
    this.#wanted.clear();
    this.#requested.clear();
    this.#paused = false;

    // The watcher goes first of all: a pending refresh landing after the
    // database is closed would throw, and its whole subject is leaving anyway.
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#stopWatching?.abort();
    this.#stopWatching = undefined;
    await this.#catchingUp?.catch(() => undefined);
    this.#catchingUp = undefined;

    // The runner is stopped before the library is: it commits batch by batch,
    // so a run cut short here has already kept everything it finished, and a
    // batch that lands after the database is closed would throw instead.
    this.#stopDeriving?.abort();
    await this.#deriving?.catch(() => undefined);

    // Stopped, and waited for: what has arrived is removed from this library
    // as the transfer's last step, which needs the database still open.
    this.#transferring?.controller.abort();
    await this.#transferring?.done;

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

    // Work parked on a format this build has since learned to draw. First,
    // because it decides what the sweep below finds still missing — and because
    // a parked `unsupported:heic` is a fact about the build that wrote it
    // rather than about the file (ADR-0040 §6).
    releaseNowSupported(library);
    this.#paused = library.settings.derivePaused;

    // Whatever the last session left undone, plus whatever a rebuild dropped.
    // Queued and worked in the background, so opening a library is not held up
    // by a hundred thousand thumbnails — the window draws placeholders and they
    // fill in (`ARCHITECTURE.md` §4.5).
    enqueueMissing(library);
    void this.#runDerives();

    // The workspace half (ADR-0047). A file under `files/` may have been
    // edited by any application at any time (RL-20) and nothing about the bytes
    // is journalled (RL-23), so the only way to stay honest is to look.
    //
    // The watcher covers what happens from here on; the sweep covers what
    // happened while Roost was closed, and is the backstop for the events every
    // platform drops under load. **Neither is awaited** — a million `stat`
    // calls against a 1.5 s cold-start budget is not something to open a window
    // behind (`CONCEPT.md` §7).
    this.#stopWatching = new AbortController();
    const stopping = this.#stopWatching.signal;
    void watchFiles(library, {
      signal: stopping,
      onChanged: () => {
        void this.#runDerives();
      },
    })
      .then((watcher) => {
        // The library may already have closed while the watcher was starting.
        if (this.#library === library) this.#watcher = watcher;
        else watcher.close();
      })
      .catch((error: unknown) => {
        log.warn("could not watch the library's files", { error: String(error) });
      });

    this.#catchingUp = catchUp(library, { signal: stopping })
      .then((report) => {
        if (report.changed > 0) {
          log.info("files changed while the library was closed", { changed: report.changed });
          void this.#runDerives();
        }
      })
      .catch((error: unknown) => {
        log.warn("could not catch up with the library's files", { error: String(error) });
      });

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
    // Mapped field by field rather than spread: the engine's shape and the
    // wire's are allowed to differ, and this is the place that notices when
    // they do (ADR-0007).
    journal: {
      skipped: library.notice.skipped.map((skipped) => ({
        op: skipped.op,
        count: skipped.count,
        platform: skipped.platform,
        platformLabel: skipped.platformLabel,
      })),
      dangling: library.notice.dangling,
    },
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
    underived: counts.underived,
    totalBytes: counts.totalBytes,
    tags: counts.tags,
    tagGroups: counts.tagGroups,
    folders: counts.folders,
    smartFolders: counts.smartFolders,
    rated: counts.rated,
    notes: counts.notes,
    trashed: counts.trashed,
    thumbnails: counts.thumbnails,
  };
}

/**
 * One row, mapped field by field onto the wire shape.
 *
 * Field by field rather than by spreading, because the wire shape and the row
 * shape are allowed to differ and this is the place that has to notice when
 * they do (ADR-0007 — the duplication is the boundary).
 */
function cardOf(hit: SearchHit, undrawn: string | null): AssetPage["assets"][number] {
  return {
    id: hit.id,
    name: hit.name,
    ext: hit.ext,
    kind: kindOf(formatFromExtension(hit.ext)) satisfies AssetKind,
    size: hit.size,
    // Both part of the thumbnail's address rather than something a cell
    // draws: see `AssetCard` in the contract.
    posterMs: hit.posterMs,
    derivedAt: hit.derivedAt,
    undrawn,
    width: hit.width,
    height: hit.height,
    importedAt: hit.importedAt,
    rating: hit.rating,
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
        stars: null,
      }),
    ),
    ratings: sidebar.ratings.map(
      (rating): SidebarRow => ({
        id: rating.id,
        name: rating.name,
        query: rating.query,
        // Unlike the places, every one of these carries a count: one grouped
        // statement answers all six, and the number is what makes the row
        // worth a click.
        count: rating.count,
        depth: 0,
        group: null,
        stars: rating.stars,
      }),
    ),
    folders: sidebar.folders.map(
      (folder): SidebarFolderRow => ({
        id: `folder:${folder.id}`,
        name: folder.name,
        query: folder.query,
        count: folder.count,
        depth: depths.get(folder.id) ?? 0,
        group: null,
        stars: null,
        // The two the inspector edits by. `id` is a key for a list and says so
        // by being a string; this is the number an op names.
        folder: folder.id,
        path: folder.path,
        descendants: folder.descendants,
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
        stars: null,
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
        stars: null,
      }),
    ),
    // Straight across: the one vocabulary here that is not a row, because a
    // facet value carries no query of its own (ADR-0035).
    types: sidebar.types,
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
function ids(values: readonly string[]): AssetId[] {
  return values.map(parseAssetId);
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
  undrawn: string | null,
): WireAssetDetail {
  return {
    id: detail.id,
    name: detail.name,
    ext: detail.ext,
    kind: kindOf(formatFromExtension(detail.ext)) satisfies AssetKind,
    browserDrawable: isBrowserDrawable(formatFromExtension(detail.ext)),
    size: detail.size,
    posterMs: detail.posterMs,
    width: detail.width,
    height: detail.height,
    contentHash: detail.contentHash,
    derivedAt: detail.derivedAt,
    undrawn,
    createdAt: detail.createdAt,
    importedAt: detail.importedAt,
    trashedAt: detail.trashedAt,
    rating: detail.rating,
    note: detail.note,
    sourceUrl: detail.sourceUrl,
    tags: detail.tags,
    folders: detail.folders,
    durationMs: detail.durationMs,
    pageCount: detail.pageCount,
    props: detail.props,
    comments: comments.map(commentOf),
    subtitles: tracks.map((track) => ({
      id: track.trackId,
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

/**
 * How many files pass before another progress event is sent.
 *
 * `CONCEPT.md` §7 asks for at least 300 imports a second, so this is roughly
 * three events a second at the target rate — faster than a status bar can be
 * read and slow enough to cost nothing.
 */
const PROGRESS_EVERY = 100;

/** The shortest gap between two `job:progress` events from the derive queue. */
const PROGRESS_MS = 1000;

/**
 * The shortest gap between two `transfer:progress` events.
 *
 * Shorter than the derive queue's, because this one draws a percentage a
 * person is watching, and a second between steps reads as stuck.
 */
const TRANSFER_PROGRESS_MS = 250;

/**
 * How many files an import has actually *finished*.
 *
 * Not `scanned`, which is what the walk has **found**: the walk drains a window
 * of five hundred paths before any of them is hashed, so `scanned` jumps by a
 * batch at a time and reads as five hundred files done in an instant, then
 * nothing for a second. Measured on 2026-09-06 against a real window — a
 * 3,000-file import emitted six events during the import phase, every one of
 * them a multiple of five hundred, which is the shape of the *queue* rather
 * than of the work.
 */
function handled(report: ImportReport): number {
  return report.imported + report.duplicates + report.failed.length;
}

function progressOf(report: ImportReport, thumbnails: number): ImportProgress {
  return {
    scanned: report.scanned,
    imported: report.imported,
    duplicates: report.duplicates,
    failed: report.failed.length,
    thumbnails,
    // The walk is what produces the total, so there is nothing honest to say
    // here until it has finished — see {@link ImportProgress.total}.
    total: null,
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
    moved: report.moved,
    copied: report.copied,
    bytes: report.bytes,
    subtitles: report.subtitles,
    subtitlesUnattached: report.subtitlesUnattached,
    thumbnails,
    elapsedMs: Math.round(report.elapsed),
    failed: report.failed.map((failure) => ({ path: failure.path, reason: failure.reason })),
    // A preview. The rest stays in the engine, which is what the dialog's
    // button acts through (ADR-0037 §3.1).
    duplicateNames: report.duplicateNames,
  };
}

/** The survey, with everything unbounded reduced to a count (ADR-0032 §6). */
/**
 * What this machine can draw, for the window.
 *
 * One mapping, read by the derive status and by the install that may have just
 * changed the answer — a second copy would be a second chance to forget a field.
 */
async function wireCapabilities(): Promise<WireDeriveStatus["capabilities"]> {
  return (await capabilities()).map((capability) => ({
    name: capability.name,
    available: capability.available,
    version: capability.version,
    detail: capability.detail,
    install: capability.install,
    installable: capability.installable,
  }));
}

function wireTransfer(report: TransferReport): WireTransferReport {
  return {
    cancelled: report.cancelled,
    added: report.added,
    merged: report.merged,
    preserved: report.preserved,
    removed: report.removed,
    folders: report.folders,
    subtitles: report.subtitles,
    bytes: report.bytes,
    missing: report.missing,
    failed: report.failed.length,
  };
}

function wireSurvey(survey: EagleSurvey): WireEagleSurvey {
  return {
    version: survey.version,
    items: survey.items,
    bytes: survey.bytes,
    folders: survey.folders,
    tagGroups: survey.tagGroups,
    tags: survey.tags.length,
    rated: survey.rated,
    notes: survey.notes,
    sources: survey.sources,
    comments: survey.comments,
    subtitles: survey.subtitles,
    trashed: survey.trashed,
    renamedFolders: survey.renamedFolders.map((rename) => ({ from: rename.from, to: rename.to })),
    missing: survey.missing.length,
    unreadable: survey.unreadable.length,
  };
}

/** The report, mapped field by field. The timings are dropped, as {@link reportOf} drops them. */
function wireEagleReport(report: EagleReport, thumbnails: number): WireEagleReport {
  return {
    items: report.survey.items,
    assets: report.assets,
    imported: report.imported,
    duplicates: report.duplicates,
    collapsed: report.collapsed,
    folders: report.folders,
    tagGroups: report.tagGroups,
    tagged: report.tagged,
    ratings: report.ratings,
    notes: report.notes,
    sources: report.sources,
    preserved: report.preserved,
    comments: report.comments,
    trashed: report.trashed,
    subtitles: report.subtitles,
    bytes: report.bytes,
    thumbnails,
    elapsedMs: Math.round(report.elapsed),
    failed: report.failed.map((failure) => ({ path: failure.path, reason: failure.reason })),
  };
}
