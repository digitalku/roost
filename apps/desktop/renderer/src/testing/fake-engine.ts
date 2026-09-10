import type {
  AssetCard,
  AssetPage,
  ImportProgress,
  LibraryStats,
  LibrarySummary,
  Outcome,
  Request,
  RequestOf,
  RequestType,
  ResponseOf,
  SidebarFolderRow,
  WireAbout,
  WireAssetDetail,
  WireComment,
  WireCursor,
  WireDeriveFailures,
  WireDeriveStatus,
  WireEagleReport,
  WireEagleSurvey,
  WireExportReport,
  WireFiled,
  WireFolderRef,
  WireImportReport,
  WirePasted,
  WireProblem,
  WireRecentLibrary,
  WireReclaimable,
  WireSelectionSummary,
  WireSettings,
  WireSidebar,
  WireSort,
  WireStars,
  WireTagRule,
} from "@roost/contract";
import type { WindowBridge } from "../bridge.js";

/**
 * A `window.roost` a test can control.
 *
 * Installed at the same seam the real one occupies, so a component test
 * exercises exactly the code the window runs — the React flow, the outcome
 * handling, and the rendering — and nothing of the three processes behind it.
 * Those have their own tests: the engine's message loop, main's security
 * policy, and the contract's validators.
 *
 * The native dialogs are the reason this exists rather than an end-to-end
 * driver. A GTK folder chooser cannot be clicked by a script, so the request
 * that opens one is answered here instead.
 */

export interface FakeLibrary {
  readonly root: string;
  readonly name: string;
}

export interface FakeEngineOptions {
  /** This library's preferences. Defaults to what a new library has. */
  readonly settings?: WireSettings;
  /**
   * What `clipboard:paste` finds. Defaults to an empty clipboard.
   *
   * Modelled as an answer rather than as a clipboard, because the shape is
   * decided in main (ADR-0026 §5) and the renderer's whole job is what it does
   * with each of the four.
   */
  readonly clipboard?: WirePasted;
  /** What `dialog:openLibrary` answers with. `null` is a cancelled dialog. */
  readonly openLibraryDialog?: string | null;
  /** What `dialog:chooseLocation` answers with. */
  readonly chooseLocationDialog?: string | null;
  /** Libraries that already exist, by path. */
  readonly existing?: readonly FakeLibrary[];
  /**
   * Directories that are there and hold no library.
   *
   * The engine draws this distinction in `readManifest`, and the picker depends
   * on it: a folder chosen in a dialog is `not_a_library`, while a path on a
   * drive that is not mounted is `library_not_found`. A fake with one failure
   * for both would let the picker pass while telling somebody a library they
   * have not lost is damaged.
   */
  readonly plainDirectories?: readonly string[];
  /**
   * What the picker's recent list starts with.
   *
   * Opening a library here appends to it, exactly as the engine does, so a test
   * can drive "open one, come back, see it listed" rather than asserting on a
   * list somebody handed the component.
   */
  readonly recent?: readonly WireRecentLibrary[];
  /** Counts every library reports. */
  readonly stats?: Partial<LibraryStats>;
  /** What the grid pages through for the empty query, newest first. */
  readonly assets?: readonly AssetCard[];
  /**
   * What a given RQL query answers with.
   *
   * Spelled out per query rather than interpreted: a fake that answered RQL
   * with a substring match would let a component test pass while believing
   * something about a language this file does not implement. A query with no
   * entry here fails, which is what a query the engine cannot parse does too.
   */
  readonly byQuery?: Readonly<Record<string, readonly AssetCard[]>>;
  /** The navigation pane. Absent means an empty one. */
  readonly sidebar?: WireSidebar;
  /** How many files a copy put on the clipboard; defaults to the whole selection. */
  readonly copiedFiles?: number;
  /**
   * Queries the engine would refuse to parse, and where each one stopped.
   *
   * Spelled out for the same reason as {@link FakeEngineOptions.byQuery}: this
   * file implements no grammar, and one that guessed would let a test believe
   * something about RQL that is not true.
   */
  readonly invalid?: Readonly<Record<string, { message: string; at: number | null }>>;
  /** Assets the inspector can read, by hash. */
  readonly details?: readonly WireAssetDetail[];
  /** What `asset:openExternally` answers with. */
  readonly opensExternally?: boolean;
  /** What `asset:reveal` and `asset:copyPath` answer with. */
  readonly desktopAnswers?: boolean;
  /** What an export reports. */
  readonly exportReport?: Partial<WireExportReport>;
  /** How many assets `assets:emptyTrash` reports having removed. */
  readonly trashSize?: number;
  /** Bytes a removal reports having freed from `originals/` (ADR-0031). */
  readonly freedBytes?: number;
  /** What `library:reclaimable` answers with; the reclaim itself echoes it. */
  readonly reclaimable?: WireReclaimable;
  /** What `dialog:chooseImport` answers with. `null` is a cancelled dialog. */
  readonly importDialog?: readonly string[] | null;
  /** What `dialog:chooseSubtitle` answers with. Files only, in the real one. */
  readonly subtitleDialog?: readonly string[] | null;
  /** What an import reports, and the progress it emits on the way. */
  readonly importReport?: Partial<WireImportReport>;
  /** Rows an import adds to what the empty query answers with. */
  readonly importAdds?: readonly AssetCard[];
  /** What `import:fileDuplicates` answers with (ADR-0037 §3). */
  readonly filed?: WireFiled;
  readonly importProgress?: readonly ImportProgress[];
  /** What `dialog:chooseEagle` answers with. `null` is a cancelled dialog. */
  readonly eagleDialog?: string | null;
  /** What `eagle:survey` answers with, over an otherwise empty one. */
  readonly eagleSurvey?: Partial<WireEagleSurvey>;
  /** What `eagle:import` reports. */
  readonly eagleReport?: Partial<WireEagleReport>;
  /** What `derive:status` and `derive:retry` answer with. */
  readonly deriveStatus?: WireDeriveStatus;
  /** What `derive:failures` answers with for `failed`, over an empty list. */
  readonly deriveFailures?: Partial<WireDeriveFailures>;
  /** What it answers with for `blocked` — work parked rather than broken. */
  readonly deriveBlocked?: Partial<WireDeriveFailures>;
  /**
   * What `app:about` answers with, over a packaged build's answer.
   *
   * Present so the *unpackaged* case is reachable: main sends no version at all
   * there, and that is the state every developer and every CI run is in.
   */
  readonly about?: Partial<WireAbout>;
  /**
   * Requests whose reply waits on a promise the test resolves.
   *
   * The progress *events* still fire immediately, which is the point: it is the
   * gap between the first event and the reply that the running state lives in.
   */
  readonly hold?: Partial<Record<RequestType, Promise<void>>>;
}

const EMPTY_SURVEY: WireEagleSurvey = {
  version: "4.0.0",
  items: 0,
  bytes: 0,
  folders: 0,
  tagGroups: 0,
  tags: 0,
  rated: 0,
  notes: 0,
  sources: 0,
  comments: 0,
  subtitles: 0,
  trashed: 0,
  renamedFolders: [],
  missing: 0,
  unreadable: 0,
};

const EMPTY_EAGLE_REPORT: WireEagleReport = {
  items: 0,
  assets: 0,
  imported: 0,
  duplicates: 0,
  collapsed: 0,
  folders: 0,
  tagGroups: 0,
  tagged: 0,
  ratings: 0,
  notes: 0,
  sources: 0,
  preserved: 0,
  comments: 0,
  trashed: 0,
  subtitles: 0,
  bytes: 0,
  thumbnails: 0,
  elapsedMs: 0,
  failed: [],
};

const EMPTY_REPORT: WireImportReport = {
  scanned: 0,
  imported: 0,
  duplicates: 0,
  partialDuplicates: 0,
  partialCollisions: 0,
  bytes: 0,
  subtitles: 0,
  subtitlesUnattached: 0,
  thumbnails: 0,
  elapsedMs: 0,
  failed: [],
  duplicateNames: [],
};

/** A detail with everything filled in, so a test spells out only what it means. */
export function fakeDetail(index: number, over: Partial<WireAssetDetail> = {}): WireAssetDetail {
  const card = fakeAsset(index);
  return {
    hash: card.hash,
    name: card.name,
    ext: card.ext,
    kind: "image",
    // A JPEG unless a test says otherwise, which is the case the pane takes for
    // granted: the original goes straight into an `<img>`.
    browserDrawable: true,
    posterMs: null,
    size: card.size,
    width: card.width,
    height: card.height,
    storageMode: "managed",
    refPath: null,
    isPartialHash: false,
    createdAt: null,
    importedAt: card.importedAt,
    trashedAt: null,
    supersededBy: null,
    rating: null,
    note: null,
    sourceUrl: null,
    durationMs: null,
    pageCount: null,
    props: {},
    tags: [],
    folders: [],
    comments: [],
    subtitles: [],
    ...over,
  };
}

const EMPTY_SIDEBAR: WireSidebar = {
  places: [],
  ratings: [],
  folders: [],
  smartFolders: [],
  tags: [],
  types: [],
};

/**
 * An asset with everything a cell needs and nothing a test has to spell out.
 *
 * `importedAt` descends with the index so that the fake's paging order matches
 * the real one — newest first — and a cursor means the same thing in both.
 */
export function fakeAsset(index: number, over: Partial<AssetCard> = {}): AssetCard {
  return {
    hash: index.toString(16).padStart(64, "0"),
    name: `asset-${index}.png`,
    ext: "png",
    kind: "image",
    posterMs: null,
    size: 1024 + index,
    width: 800,
    height: 600,
    importedAt: 2_000_000_000 - index,
    rating: null,
    ...over,
  };
}

const EMPTY_STATS: LibraryStats = {
  assets: 0,
  managed: 0,
  referenced: 0,
  partialHashes: 0,
  totalBytes: 0,
  tags: 0,
  tagGroups: 0,
  folders: 0,
  smartFolders: 0,
  rated: 0,
  notes: 0,
  trashed: 0,
  thumbnails: 0,
};

export class FakeEngine {
  /** Every request the component made, in order. */
  readonly seen: Request[] = [];

  /** The last text `clipboard:copyText` was given, or `undefined` for none. */
  copied: string | undefined;

  readonly #options: FakeEngineOptions;
  readonly #libraries = new Map<string, FakeLibrary>();
  /** Mutable: an edit changes what the next read answers with. */
  readonly details = new Map<string, WireAssetDetail>();
  /** Mutable: an import adds rows, newest first. */
  assets: readonly AssetCard[];
  /**
   * The next comment id, minted the way the engine mints one: `max(id) + 1`.
   *
   * Modelled rather than stubbed because the renderer names an edit by the id
   * the list handed it, and a fake that reused one would let a component pass
   * while editing the wrong comment.
   */
  #nextCommentId = 1;
  /**
   * Distinguishes the hashes a save mints, so two edits of one asset are two
   * assets. Modelled because a save *moves* what the pane is looking at: a fake
   * that answered with the hash it was given would let the pane pass while
   * still showing the version it just replaced.
   */
  #saves = 0;
  /**
   * Mutable: the folder tree an edit changes (ADR-0033).
   *
   * Modelled rather than stubbed because the sidebar re-reads after a create or
   * a delete, and a fake that answered with the tree it was constructed with
   * would let a component pass while showing a folder that is gone.
   */
  folders: readonly SidebarFolderRow[];
  /** This library's preferences, as the engine would hold them (ADR-0019). */
  settings: WireSettings;
  #nextFolderId: number;
  #open: LibrarySummary | undefined;
  #recent: readonly WireRecentLibrary[];
  #listeners = new Set<(event: unknown) => void>();

  constructor(options: FakeEngineOptions = {}) {
    this.#options = options;
    this.folders = options.sidebar?.folders ?? [];
    this.settings = options.settings ?? {
      showSubfolderContents: false,
      fitVideoToWindow: false,
      mediaVolume: 100,
      mediaMuted: false,
      sortKey: "added",
      sortDescending: true,
      shuffleSeed: 0,
      gridView: "icons",
      matchImageProportions: true,
      gridZoom: 240,
    };
    this.#nextFolderId = Math.max(0, ...this.folders.map((row) => row.folder)) + 1;
    for (const library of options.existing ?? []) this.#libraries.set(library.root, library);
    for (const detail of options.details ?? []) {
      // Ordered on the way in, not only on the way out: the engine answers in
      // the repository's order whatever order the rows were written in, and a
      // fake that returned a test's own spelling would be kinder than the wire.
      this.details.set(detail.hash, { ...detail, comments: ordered(detail.comments) });
      for (const comment of detail.comments) {
        this.#nextCommentId = Math.max(this.#nextCommentId, comment.id + 1);
      }
    }
    this.assets = options.assets ?? [];
    this.#recent = options.recent ?? [];
  }

  /** Moves a library to the front of the recent list, as the engine's `#open` does. */
  #remember(summary: LibrarySummary): void {
    const kept = this.#recent.filter((entry) => entry.root !== summary.root);
    const previous = this.#recent.find((entry) => entry.root === summary.root);
    this.#recent = [
      {
        root: summary.root,
        name: summary.name,
        id: summary.id,
        openedAt: Math.floor(Date.now() / 1000),
        pinned: previous?.pinned ?? false,
        available: true,
      },
      ...kept,
    ];
  }

  /** The bridge the renderer will find on `window`. */
  bridge(): WindowBridge {
    return {
      invoke: <T extends RequestType>(request: RequestOf<T>): Promise<Outcome<ResponseOf<T>>> => {
        // Cast because the answer is chosen by the request's own type, which is
        // exactly what the contract's mapped types express and what a switch
        // over a union cannot narrow for the caller.
        const answer = this.#answer(request) as Outcome<ResponseOf<T>>;
        // Held open when a test asked for it, so the *running* state exists
        // long enough to be looked at. Without this every request resolves in
        // the same microtask that started it, and "shows progress while it
        // runs" is a claim nothing can check.
        const holding = this.#options.hold?.[request.type];
        return holding === undefined ? Promise.resolve(answer) : holding.then(() => answer);
      },
      onEvent: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
      // A dropped `File` carries no path; in a test it carries whatever the
      // test put on it, which is the only way to stand in for the preload.
      pathForFile: (file: File): string => droppedPaths.get(file) ?? "",
    };
  }

  /** Emits an event, the way the engine would. */
  emit(event: unknown): void {
    for (const listener of this.#listeners) listener(event);
  }

  /** Whether a library exists at `root` in this fake filesystem. */
  has(root: string): boolean {
    return this.#libraries.has(root);
  }

  /**
   * A library appears at `root` — a removable drive being plugged in.
   *
   * The only way a test can make an unavailable recent row available, which is
   * the case the row's retry exists for.
   */
  attach(library: FakeLibrary): void {
    this.#libraries.set(library.root, library);
  }

  /**
   * Applies an edit and announces the change, the way the engine does.
   *
   * The answer is `null`: every edit reads back rather than trusting what it
   * sent, and a fake that returned the new state would let a component pass
   * while skipping the re-read.
   */
  #mutate(
    hashes: readonly string[],
    change: (detail: WireAssetDetail) => WireAssetDetail,
  ): Outcome<unknown> {
    for (const hash of hashes) {
      const found = this.details.get(hash);
      if (found !== undefined) this.details.set(hash, change(found));
    }
    this.emit({ type: "library:changed" });
    return ok(null);
  }

  /**
   * Applies a change to every comment in the fake, by id.
   *
   * Across all assets rather than one, because `comment:set` and
   * `comment:remove` name a comment by its id and never say which asset it is
   * on — so a fake that needed to be told would be a kinder wire than the real
   * one. Returning `undefined` from `change` drops the comment.
   */
  #mutateComments(change: (comment: WireComment) => WireComment | undefined): Outcome<unknown> {
    for (const [hash, detail] of this.details) {
      const kept = detail.comments
        .map(change)
        .filter((comment): comment is WireComment => comment !== undefined);
      this.details.set(hash, { ...detail, comments: ordered(kept) });
    }
    this.emit({ type: "library:changed" });
    return ok(null);
  }

  /**
   * The same aggregate the engine computes in SQL, over whatever details this
   * fake was given.
   *
   * Written out rather than stubbed with a fixed answer: the shared-versus-
   * partial tag distinction is the part of the inspector most likely to be got
   * wrong, and a fake that returned a constant would let that pass.
   */
  #summarize(hashes: readonly string[]): WireSelectionSummary {
    const found = hashes
      .map((hash) => this.details.get(hash))
      .filter((detail): detail is WireAssetDetail => detail !== undefined);

    const rated = found.filter((detail) => detail.rating !== null);
    const agreed =
      found.length > 0 &&
      rated.length === found.length &&
      rated.every((detail) => detail.rating === rated[0]?.rating);

    const carrying = new Map<string, number>();
    for (const detail of found) {
      for (const tag of detail.tags) carrying.set(tag, (carrying.get(tag) ?? 0) + 1);
    }
    const names = [...carrying.keys()].sort();

    // Keyed by id, because the id is what an edit names — two folders may be
    // called `Icons` and the panel has to tell them apart.
    const inFolders = new Map<number, { ref: WireFolderRef; carrying: number }>();
    for (const detail of found) {
      for (const ref of detail.folders) {
        const held = inFolders.get(ref.id);
        inFolders.set(ref.id, { ref, carrying: (held?.carrying ?? 0) + 1 });
      }
    }
    const folders = [...inFolders.values()].sort((a, b) => a.ref.path.localeCompare(b.ref.path));

    const kinds = [...new Set(found.map((detail) => detail.ext))].slice(0, 5);

    return {
      count: found.length,
      totalBytes: found.reduce((total, detail) => total + detail.size, 0),
      rating: agreed ? (rated[0]?.rating ?? null) : null,
      ratingMixed: rated.length > 0 && !agreed,
      sharedTags: names.filter((name) => carrying.get(name) === found.length),
      partialTags: names.filter((name) => carrying.get(name) !== found.length),
      sharedFolders: folders.filter((f) => f.carrying === found.length).map((f) => f.ref),
      partialFolders: folders.filter((f) => f.carrying !== found.length).map((f) => f.ref),
      kinds,
    };
  }

  /** The rows a query answers with, or `undefined` if it was never taught one. */
  #rowsFor(query: string): readonly AssetCard[] | undefined {
    if (query.trim() === "") return this.assets;
    return this.#options.byQuery?.[query];
  }

  #answer(request: Request): Outcome<unknown> {
    this.seen.push(request);

    switch (request.type) {
      case "dialog:openLibrary":
        return ok(this.#options.openLibraryDialog ?? null);

      case "dialog:chooseLocation":
        return ok(this.#options.chooseLocationDialog ?? null);

      case "library:open": {
        const found = this.#libraries.get(request.path);
        if (found === undefined) {
          return (this.#options.plainDirectories ?? []).includes(request.path)
            ? problem("not_a_library", `${request.path} is not a Roost library`, {
                path: request.path,
              })
            : problem("library_not_found", `${request.path} is not there`, { path: request.path });
        }
        this.#open = summarize(found);
        this.#remember(this.#open);
        return ok(this.#open);
      }

      case "library:create": {
        if (request.name.includes("/")) {
          return problem(
            "invalid_library_name",
            `"${request.name}" cannot be a library name: it contains a path separator`,
            { name: request.name },
          );
        }
        // The suffix is the engine's to add, and this stands in for it — which
        // is also what makes a wrong assumption in the renderer visible here.
        const root = `${request.parent}/${request.name}.roost`;
        if (this.#libraries.has(root)) {
          return problem("already_a_library", `${root} already contains a Roost library`, {
            path: root,
          });
        }
        const library = { root, name: request.name };
        this.#libraries.set(root, library);
        this.#open = summarize(library);
        this.#remember(this.#open);
        return ok(this.#open);
      }

      case "asset:summary":
        return ok(this.#summarize(request.hashes));

      case "library:current":
        return ok(this.#open ?? null);

      case "recent:list":
        // Availability is answered from this fake's filesystem rather than
        // from what the entry was constructed with, because the engine answers
        // it with a `stat` taken at read time: an entry whose library has since
        // appeared comes back available, and one whose library never existed
        // comes back missing however the test spelled it.
        return ok(this.#recent.map((entry) => ({ ...entry, available: this.has(entry.root) })));

      case "recent:forget":
        this.#recent = this.#recent.filter((entry) => entry.root !== request.root);
        return ok(this.#recent);

      case "recent:pin":
        this.#recent = this.#recent.map((entry) =>
          entry.root === request.root ? { ...entry, pinned: request.pinned } : entry,
        );
        return ok(this.#recent);

      case "library:close":
        this.#open = undefined;
        return ok(null);

      // Recorded in `seen` like every other request and otherwise a no-op: a
      // test asserts that the menu asked to quit, not that a process ended.
      case "app:quit":
        return ok(null);

      // A packaged build with a commit — the case with the most to draw, so a
      // dialog that dropped a part of the line fails here. The unpackaged one,
      // where main answers with no version at all, is `describe`'s own test.
      case "app:about":
        return ok({
          version: "1.0.0",
          commit: "abc1234",
          electron: "43.4.1",
          chromium: "150.0.7871.224",
          ...this.#options.about,
        });

      case "library:sidebar":
        if (this.#open === undefined) {
          return problem("remote", "No library is open", {});
        }
        return ok({ ...(this.#options.sidebar ?? EMPTY_SIDEBAR), folders: this.folders });

      case "library:stats":
        if (this.#open === undefined) {
          return problem("remote", "No library is open", {});
        }
        // The asset count follows what an import actually added, because the
        // window decides whether to re-page the grid from it.
        return ok({ ...EMPTY_STATS, assets: this.assets.length, ...this.#options.stats });

      case "asset:detail":
        return ok(this.details.get(request.hash) ?? null);

      case "asset:rate":
        return this.#mutate(request.hashes, (detail) => ({ ...detail, rating: request.rating }));

      case "asset:poster":
        // Nothing on the wire detail changes: the moment lives in the library
        // and what it produces is a thumbnail, which this fake does not draw.
        // The request itself is what a component test asserts on.
        return ok(null);

      case "asset:note": {
        // The engine drops an all-whitespace note; the fake does too, because a
        // component test that relied on the difference would be testing a fake
        // that is kinder than the thing it stands for.
        const trimmed = request.note === null ? null : request.note.trim();
        return this.#mutate([request.hash], (detail) => ({
          ...detail,
          note: trimmed === "" ? null : trimmed,
        }));
      }

      case "asset:source": {
        // Trimmed, and empty means absent — the rule the engine follows for the
        // note and for this.
        const trimmed = request.url === null ? null : request.url.trim();
        return this.#mutate([request.hash], (detail) => ({
          ...detail,
          sourceUrl: trimmed === "" ? null : trimmed,
        }));
      }

      case "link:open":
        // Whether main would open it, decided the way main decides: the window
        // only ever offers the affordance for an `http(s)` value, so a test that
        // saw `true` for anything else would be testing a kinder fake.
        return ok(/^https?:\/\/\S+$/.test(request.url));

      case "clipboard:paste":
        return ok(this.#options.clipboard ?? { kind: "empty" });

      case "asset:addSubtitle": {
        // The engine's list of what counts as a subtitle, as much of it as a
        // fake needs: the window never learns one, so a test that dropped a
        // mixed handful has to see the split happen somewhere.
        const tracks = request.paths.filter((path) => /\.(srt|vtt|ass|ssa|sub)$/i.test(path));
        const ignored = request.paths.filter((path) => !tracks.includes(path));

        const detail = this.details.get(request.hash);
        if (detail === undefined || tracks.length === 0) return ok({ attached: 0, ignored });
        this.details.set(request.hash, {
          ...detail,
          subtitles: [
            ...detail.subtitles,
            ...tracks.map((path, index) => ({
              hash: `${(index + 0xc0).toString(16)}${"0".repeat(62)}`,
              lang: null,
              label: null,
              name: path.split("/").pop() ?? path,
              servable: true,
            })),
          ],
        });
        this.emit({ type: "library:changed" });
        return ok({ attached: tracks.length, ignored });
      }

      case "asset:subtitleDelete": {
        // Detached *and* trashed, in that order, the way the engine journals
        // it: a trashed asset still attached would be a track nobody can see
        // and nothing can find.
        const trashed = this.details.get(request.track);
        if (trashed !== undefined) {
          this.details.set(request.track, { ...trashed, trashedAt: 1_700_000_000 });
        }
        return this.#mutate([request.hash], (detail) => ({
          ...detail,
          subtitles: detail.subtitles.filter((track) => track.hash !== request.track),
        }));
      }

      case "asset:create": {
        const text = request.text;
        if (text === "") {
          return problem("empty_file", `${request.name} has nothing in it`, {});
        }
        const held = [...this.details.values()].find(
          (detail) => detail.name === request.name && detail.size === text.length,
        );
        if (held !== undefined) return ok({ hash: held.hash, created: false });

        this.#saves += 1;
        const hash = `${(this.#saves + 0xa0).toString(16)}${fakeDetail(1).hash.slice(2)}`;
        this.details.set(hash, {
          ...fakeDetail(1),
          hash,
          name: request.name,
          ext: request.name.split(".").pop() ?? "",
          kind: "other",
          size: text.length,
        });
        this.emit({ type: "library:changed" });
        return ok({ hash, created: true });
      }

      case "asset:rename":
        return this.#mutate([request.hash], (detail) => ({
          ...detail,
          name: request.name.trim(),
        }));

      case "asset:tagAdd":
        return this.#mutate(request.hashes, (detail) => ({
          ...detail,
          tags: [...new Set([...detail.tags, ...request.tags.map((tag) => tag.trim())])],
        }));

      case "asset:tagRemove": {
        const gone = new Set(request.tags.map((tag) => tag.trim().toLowerCase()));
        return this.#mutate(request.hashes, (detail) => ({
          ...detail,
          tags: detail.tags.filter((tag) => !gone.has(tag.toLowerCase())),
        }));
      }

      // The fake holds memberships on the detail rather than in a tree of its
      // own: what a renderer test asserts is what the panel sent and what it
      // draws afterwards, and neither needs a folder the window has not seen.
      case "asset:folderAdd": {
        const added = this.folders.find((folder) => folder.folder === request.folder);
        if (added === undefined) {
          return problem("unknown_folder", `no folder ${request.folder}`, {});
        }
        const ref: WireFolderRef = { id: added.folder, path: added.path };
        return this.#mutate(request.hashes, (detail) => ({
          ...detail,
          folders: detail.folders.some((held) => held.id === ref.id)
            ? detail.folders
            : [...detail.folders, ref],
        }));
      }

      case "asset:folderRemove":
        return this.#mutate(request.hashes, (detail) => ({
          ...detail,
          folders: detail.folders.filter((held) => held.id !== request.folder),
        }));

      case "folder:create": {
        const folder = this.#nextFolderId;
        this.#nextFolderId += 1;
        const under = this.folders.find((row) => row.folder === request.parent);
        const path = under === undefined ? request.name : `${under.path}/${request.name}`;
        this.folders = [
          ...this.folders,
          {
            id: `folder:${folder}`,
            name: request.name,
            query: `folder:"${path}"`,
            count: 0,
            depth: under === undefined ? 0 : under.depth + 1,
            group: null,
            stars: null,
            folder,
            path,
            descendants: 0,
          },
        ];
        this.emit({ type: "library:changed" });
        return ok(folder);
      }

      case "folder:rename": {
        this.folders = this.folders.map((row) =>
          row.folder === request.folder ? { ...row, name: request.name } : row,
        );
        this.emit({ type: "library:changed" });
        return ok(null);
      }

      case "folder:move": {
        const moved = this.folders.find((row) => row.folder === request.folder);
        const under = this.folders.find((row) => row.folder === request.parent);
        if (moved === undefined)
          return problem("unknown_folder", `no folder ${request.folder}`, {});
        // Refused the way the engine refuses it: a folder cannot go inside its
        // own subtree, or that subtree is cut off from the root.
        if (under?.path.startsWith(`${moved.path}/`) === true) {
          return problem("folder_cycle", "a folder cannot go inside itself", {});
        }
        const path = under === undefined ? moved.name : `${under.path}/${moved.name}`;
        const depth = under === undefined ? 0 : under.depth + 1;
        this.folders = this.folders.map((row) =>
          row.folder === moved.folder ? { ...row, path, depth, query: `folder:"${path}"` } : row,
        );
        this.emit({ type: "library:changed" });
        return ok(null);
      }

      case "folder:delete": {
        // Descendants go with it, the way the cascade does in the index. By
        // path rather than by walking parents: the wire row has no parent, and
        // a path is exactly the ancestry it does carry.
        const target = this.folders.find((row) => row.folder === request.folder);
        const inside = (row: SidebarFolderRow): boolean =>
          target !== undefined &&
          (row.folder === target.folder || row.path.startsWith(`${target.path}/`));
        // The row's own count is already a subtree count, so it *is* what the
        // engine would trash. Summing the descendants would count them twice.
        const trashed = request.trashContents ? (target?.count ?? 0) : 0;
        this.folders = this.folders.filter((row) => !inside(row));
        this.emit({ type: "library:changed" });
        return ok({ trashed });
      }

      case "comment:add": {
        const body = request.body.trim();
        const id = this.#nextCommentId;
        this.#nextCommentId += 1;
        return this.#mutate([request.hash], (detail) => ({
          ...detail,
          comments: ordered([
            ...detail.comments,
            { id, atMs: request.atMs, body, createdAt: 1_700_000_000, updatedAt: null },
          ]),
        }));
      }

      case "comment:set":
        return this.#mutateComments((comment) =>
          comment.id === request.id
            ? {
                ...comment,
                atMs: request.atMs,
                body: request.body.trim(),
                updatedAt: 1_700_000_100,
              }
            : comment,
        );

      case "comment:remove":
        return this.#mutateComments((comment) => (comment.id === request.id ? undefined : comment));

      // Trashing is modelled as removal from `assets`, because that is what the
      // window sees: every query but the Trash place is scoped to live assets,
      // and the fake has no query engine to scope with. Restoring is deliberately
      // *not* modelled — a fake that could put a row back would be pretending to
      // a query language it does not have, and the tests that matter here are
      // about what the renderer sends.
      case "assets:trash": {
        const gone = new Set(request.hashes);
        this.assets = this.assets.filter((asset) => !gone.has(asset.hash));
        this.emit({ type: "library:changed" });
        return ok(null);
      }

      case "assets:remove": {
        const gone = new Set(request.hashes);
        this.assets = this.assets.filter((asset) => !gone.has(asset.hash));
        this.emit({ type: "library:changed" });
        return ok({ assets: gone.size, bytes: this.#options.freedBytes ?? 0 });
      }

      case "assets:restore":
        this.emit({ type: "library:changed" });
        return ok(null);

      case "assets:emptyTrash":
        this.emit({ type: "library:changed" });
        return ok({
          assets: this.#options.trashSize ?? 0,
          bytes: this.#options.freedBytes ?? 0,
        });

      // The real one walks the object store twice — once for the numbers the
      // confirmation shows, once before deleting anything. The fake answers the
      // same shape to both, because what the renderer must get right is which
      // of the three outcomes it is looking at: blocked, nothing, or a size.
      case "library:reclaimable":
        return ok(this.#options.reclaimable ?? { objects: 0, bytes: 0, blocked: null });

      case "library:reclaim": {
        const answer = this.#options.reclaimable ?? { objects: 0, bytes: 0, blocked: null };
        this.emit({ type: "library:changed" });
        return ok({ objects: answer.objects, bytes: answer.bytes, blocked: null });
      }

      case "asset:openExternally":
        return ok(this.#options.opensExternally ?? true);

      case "asset:reveal":
      case "asset:copyPath":
        return ok(this.#options.desktopAnswers ?? true);

      // A count rather than a yes: "three files are on the clipboard" and
      // "one is" are different sentences, and the window says which.
      case "asset:copyFiles":
        return ok(this.#options.copiedFiles ?? request.hashes.length);

      case "assets:export":
        return ok({
          exported: request.hashes.length,
          renamed: 0,
          missing: 0,
          failed: 0,
          ...this.#options.exportReport,
        });

      case "dialog:chooseImport":
        return ok(this.#options.importDialog ?? null);

      case "dialog:chooseSubtitle":
        return ok(this.#options.subtitleDialog ?? null);

      case "dialog:chooseEagle":
        return ok(this.#options.eagleDialog ?? null);

      case "eagle:survey":
        // No library needed, as in the engine: a survey reads somebody else's
        // directory and writes nothing.
        return ok({ ...EMPTY_SURVEY, ...this.#options.eagleSurvey });

      case "eagle:import": {
        if (this.#open === undefined) return problem("remote", "No library is open", {});
        for (const step of this.#options.importProgress ?? []) {
          this.emit({ type: "import:progress", ...step });
        }
        this.assets = [...(this.#options.importAdds ?? []), ...this.assets];
        this.emit({ type: "library:changed" });
        return ok({ ...EMPTY_EAGLE_REPORT, ...this.#options.eagleReport });
      }

      case "import:paths": {
        if (this.#open === undefined) return problem("remote", "No library is open", {});
        // Emitted before the reply, the way the engine does: the reply is what
        // ends the run, so progress that arrived after it would never be seen.
        for (const step of this.#options.importProgress ?? []) {
          this.emit({ type: "import:progress", ...step });
        }
        this.assets = [...(this.#options.importAdds ?? []), ...this.assets];
        this.emit({ type: "library:changed" });
        return ok({
          ...EMPTY_REPORT,
          scanned: request.paths.length,
          imported: request.paths.length,
          ...this.#options.importReport,
        });
      }

      case "import:fileDuplicates": {
        if (this.#open === undefined) return problem("remote", "No library is open", {});
        // The engine keeps the last run's list; the fake keeps whatever a test
        // said it should answer with.
        this.emit({ type: "library:changed" });
        return ok(this.#options.filed ?? { filed: 0, expired: false });
      }

      case "derive:status":
      case "derive:retry":
        // A fake queue with nothing in it, unless a test taught it otherwise:
        // most of them are about the grid and never look at this.
        return ok(
          this.#options.deriveStatus ?? {
            ready: 0,
            running: 0,
            blocked: 0,
            failed: 0,
            reasons: [],
            capabilities: [],
          },
        );

      case "derive:failures": {
        // One fixture per state, because a test about parked work and a test
        // about failures are never the same test.
        const asked =
          request.state === "blocked" ? this.#options.deriveBlocked : this.#options.deriveFailures;
        const groups = asked?.groups ?? [];
        const counted = groups.reduce((sum, group) => sum + group.count, 0);
        return ok({
          total: asked?.total ?? counted,
          read: asked?.read ?? counted,
          hidden: asked?.hidden ?? 0,
          groups,
        });
      }

      case "clipboard:copyText":
        this.copied = request.text;
        return ok(true);

      /*
       * A **deliberately small** stand-in for `@roost/search`'s own reading and
       * writing of a query (ADR-0035). It handles a flat run of terms with
       * quoted values, and nothing else — no parentheses, no `OR`, no negation.
       *
       * Quoting is here because it is the thing the tests are about: a renderer
       * that spelled `tag:brand assets` itself would send two terms and get the
       * wrong answer, so the fake has to be able to give the right one. What
       * the real grammar does with everything this cannot read is tested where
       * it lives, in `facets.test.ts`.
       *
       * Importing that would put the grammar in the renderer's dependencies,
       * which is the one thing `UI_SPEC.md` §4.1 exists to prevent. A fake
       * engine is allowed to be a fake.
       */
      case "query:split": {
        const tags: string[] = [];
        const stars: WireStars[] = [];
        const exts: string[] = [];
        let unrated = false;
        let tagRule: WireTagRule = "any";
        const place: string[] = [];
        for (const conjunct of terms(request.query)) {
          // A parenthesised run is one facet's `OR`. Several bare `tag:` terms
          // are the `all` rule (ADR-0035 §7) — the two shapes this has to tell
          // apart to read back what its own `query:join` wrote.
          const group = /^\((.*)\)$/s.exec(conjunct);
          const parts = group?.[1] === undefined ? [conjunct] : terms(group[1]);
          const read = parts.filter((part) => part !== "OR").map(named);
          if (read.some((part) => part === undefined)) {
            place.push(conjunct);
            continue;
          }
          for (const part of read) {
            if (part === undefined) continue;
            if (part.field === "tag") {
              if (group === null && tags.length > 0) tagRule = "all";
              tags.push(part.value);
            } else if (part.field === "ext") exts.push(part.value);
            else if (part.field === "rating") stars.push(Number(part.value) as WireStars);
            else unrated = true;
          }
        }
        // The depth the query names, read off the place the same way the real
        // splitter does (ADR-0036).
        const depths = place.map(folderDepth).filter((depth) => depth !== undefined);
        const [depth] = depths;
        return ok({
          place: place.join(" "),
          facets: { tags, tagRule, stars, unrated, exts },
          subfolders: depths.length === 1 && depth !== undefined ? depth === "folder" : null,
          representable: true,
        });
      }

      case "query:subfolders": {
        const wanted = request.on ? "folder" : "infolder";
        let changed = false;
        const rewritten = terms(request.query).map((conjunct) => {
          const held = folderDepth(conjunct);
          if (held === undefined || held === wanted) return conjunct;
          changed = true;
          return `${wanted}:${conjunct.slice(conjunct.indexOf(":") + 1)}`;
        });
        return ok(changed ? rewritten.join(" ") : request.query);
      }

      case "settings:read":
        return ok(this.settings);

      case "settings:write": {
        // A patch: every key absent means "leave it alone" (ADR-0019), so the
        // fake takes whatever is present rather than naming each one.
        const { type: _type, showSubfolderContents, ...rest } = request;
        this.settings = { ...this.settings, ...rest };
        if (showSubfolderContents !== undefined) {
          this.settings = { ...this.settings, showSubfolderContents };
          // The real engine rewrites every folder row's query when this
          // changes, and the window re-reads the pane because of it.
          this.folders = this.folders.map((row) => ({
            ...row,
            query: `${showSubfolderContents ? "folder" : "infolder"}:"${row.path}"`,
          }));
          this.emit({ type: "library:changed" });
        }
        return ok(this.settings);
      }

      case "query:join": {
        const or = (written: readonly string[]): readonly string[] =>
          written.length <= 1 ? written : [`(${written.join(" OR ")})`];
        const tagged = request.facets.tags.map((tag) => `tag:${quote(tag)}`);
        const written = [
          ...(request.facets.tagRule === "all" ? tagged : or(tagged)),
          ...or([
            ...[...request.facets.stars].sort((a, b) => b - a).map((n) => `rating:${n}`),
            ...(request.facets.unrated ? ["is:unrated"] : []),
          ]),
          ...or(request.facets.exts.map((ext) => `ext:${quote(ext)}`)),
        ];
        return ok([request.place.trim(), ...written].filter((part) => part !== "").join(" "));
      }

      case "query:check": {
        const bad = this.#options.invalid?.[request.query];
        return ok(
          bad === undefined
            ? { ok: true, message: null, at: null }
            : { ok: false, message: bad.message, at: bad.at },
        );
      }

      case "assets:count": {
        if (this.#open === undefined) return problem("remote", "No library is open", {});
        const rows = this.#rowsFor(request.query);
        return rows === undefined
          ? problem("remote", "the fake engine was not told what this query answers", {
              query: request.query,
            })
          : ok(rows.length);
      }

      case "assets:page": {
        if (this.#open === undefined) {
          return problem("remote", "No library is open", {});
        }
        const rows = this.#rowsFor(request.query);
        if (rows === undefined) {
          return problem("remote", "the fake engine was not told what this query answers", {
            query: request.query,
          });
        }
        return ok(pageOf(sorted(rows, request.sort), request.limit, request.after));
      }
    }
  }
}

/**
 * Comments in the order the repository answers with: timed first, in timeline
 * order, ties broken by id.
 *
 * `ORDER BY at_ms IS NULL, at_ms, id` in SQL. Repeated here because the order
 * is what the inspector draws and the strip reads, and a fake that returned
 * insertion order would let a component pass while showing the wrong list.
 */
function ordered(comments: readonly WireComment[]): WireComment[] {
  return [...comments].sort((left, right) => {
    if ((left.atMs === null) !== (right.atMs === null)) return left.atMs === null ? 1 : -1;
    if (left.atMs !== right.atMs) return (left.atMs ?? 0) - (right.atMs ?? 0);
    return left.id - right.id;
  });
}

/**
 * The rows in the order a page asked for (ADR-0039).
 *
 * Enough of the engine's order to tell a component test that the grid asked for
 * one and drew what came back — not a second implementation of it. `random` is
 * the rotation the engine uses, because it is four lines and a fake that
 * shuffled differently would make a window check and a component test disagree
 * about the same seed.
 */
function sorted(assets: readonly AssetCard[], sort: WireSort | null): readonly AssetCard[] {
  if (sort === null || sort.key === "added") return assets;
  const rotate = 1 + (Math.abs(Math.trunc(sort.seed)) % 63);
  const keyOf = (asset: AssetCard): number | string => {
    switch (sort.key) {
      case "created":
        return asset.importedAt;
      case "name":
        return asset.name.toLowerCase();
      case "size":
        return asset.size;
      case "rating":
        return asset.rating ?? 0;
      default:
        return asset.hash.slice(rotate) + asset.hash.slice(0, rotate);
    }
  };
  const way = sort.descending ? -1 : 1;
  return [...assets].sort((left, right) => {
    const a = keyOf(left);
    const b = keyOf(right);
    if (a !== b) return a < b ? -way : way;
    return left.hash < right.hash ? -way : way;
  });
}

/** Keyset paging over a plain array, the way the engine does it over SQLite. */
function pageOf(assets: readonly AssetCard[], limit: number, after: WireCursor | null): AssetPage {
  const start = after === null ? 0 : assets.findIndex((asset) => asset.hash === after.hash) + 1;
  const slice = assets.slice(start, start + limit);
  const last = slice[slice.length - 1];
  return {
    assets: slice,
    // A short page is the last page, which is the rule the grid stops on.
    next:
      slice.length < limit || last === undefined ? null : { key: last.importedAt, hash: last.hash },
  };
}

function summarize(library: FakeLibrary): LibrarySummary {
  return {
    root: library.root,
    name: library.name,
    id: "00000000-0000-4000-8000-000000000000",
    formatVersion: 1,
    // A stand-in, not a claim: the renderer never reads this number, and it
    // cannot import the migration list to learn the real one.
    schemaVersion: 6,
  };
}

function ok(value: unknown): Outcome<unknown> {
  return { ok: true, value };
}

function problem(code: string, message: string, detail: WireProblem["detail"]): Outcome<unknown> {
  return { ok: false, problem: { code, message, detail } };
}

/**
 * Paths for files a test drops on the window.
 *
 * The real one comes from `webUtils.getPathForFile` in the preload, which has
 * no meaning for a `File` a test constructed. {@link droppedFile} is how a test
 * says where its file pretends to live.
 */
const droppedPaths = new WeakMap<File, string>();

/** A `File` that answers `pathForFile` with `path`. */
export function droppedFile(path: string): File {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const file = new File([], name);
  droppedPaths.set(file, path);
  return file;
}

/** Installs a bridge on `window` for the duration of a test. */
export function install(engine: FakeEngine): void {
  Object.defineProperty(window, "roost", {
    value: engine.bridge(),
    configurable: true,
    writable: true,
  });
}

/** Splits on whitespace, keeping a `"quoted value"` and a `(group)` whole. */
function terms(query: string): string[] {
  return query.match(/\([^)]*\)|(?:[^\s"]|"[^"]*")+/g) ?? [];
}

/** One `field:value` the fake understands, or `undefined` for anything else. */
/** Whether a conjunct is a plain folder term, and at which depth (ADR-0036). */
function folderDepth(term: string): "folder" | "infolder" | undefined {
  const match = /^(in)?folder:/.exec(term);
  return match === null ? undefined : match[1] === undefined ? "folder" : "infolder";
}

function named(term: string): { field: string; value: string } | undefined {
  if (term === "is:unrated") return { field: "unrated", value: "" };
  const match = /^(tag|ext|rating):(.*)$/s.exec(term);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const value = unquote(match[2]);
  if (match[1] === "rating" && !/^[1-5]$/.test(value)) return undefined;
  return { field: match[1], value };
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1)
    : value;
}

/** `quoteValue`'s rule, small enough to restate and only ever used by the fake. */
function quote(value: string): string {
  return value !== "" && !/[\s"():]/.test(value) ? value : `"${value.replaceAll('"', '""')}"`;
}
