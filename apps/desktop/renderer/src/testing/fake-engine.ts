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
  WireAssetDetail,
  WireDeriveStatus,
  WireImportReport,
  WireProblem,
  WireSidebar,
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
  /** What `dialog:openLibrary` answers with. `null` is a cancelled dialog. */
  readonly openLibraryDialog?: string | null;
  /** What `dialog:chooseLocation` answers with. */
  readonly chooseLocationDialog?: string | null;
  /** Libraries that already exist, by path. */
  readonly existing?: readonly FakeLibrary[];
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
  /** What `dialog:chooseImport` answers with. `null` is a cancelled dialog. */
  readonly importDialog?: readonly string[] | null;
  /** What an import reports, and the progress it emits on the way. */
  readonly importReport?: Partial<WireImportReport>;
  /** Rows an import adds to what the empty query answers with. */
  readonly importAdds?: readonly AssetCard[];
  readonly importProgress?: readonly ImportProgress[];
  /** What `derive:status` and `derive:retry` answer with. */
  readonly deriveStatus?: WireDeriveStatus;
}

const EMPTY_REPORT: WireImportReport = {
  scanned: 0,
  imported: 0,
  duplicates: 0,
  partialDuplicates: 0,
  partialCollisions: 0,
  bytes: 0,
  thumbnails: 0,
  elapsedMs: 0,
  failed: [],
};

/** A detail with everything filled in, so a test spells out only what it means. */
export function fakeDetail(index: number, over: Partial<WireAssetDetail> = {}): WireAssetDetail {
  const card = fakeAsset(index);
  return {
    hash: card.hash,
    name: card.name,
    ext: card.ext,
    kind: "image",
    size: card.size,
    width: card.width,
    height: card.height,
    storageMode: "managed",
    refPath: null,
    isPartialHash: false,
    createdAt: null,
    importedAt: card.importedAt,
    rating: null,
    note: null,
    durationMs: null,
    pageCount: null,
    props: {},
    isFavorite: false,
    tags: [],
    folders: [],
    ...over,
  };
}

const EMPTY_SIDEBAR: WireSidebar = { places: [], folders: [], smartFolders: [], tags: [] };

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
    size: 1024 + index,
    width: 800,
    height: 600,
    importedAt: 2_000_000_000 - index,
    rating: null,
    isFavorite: false,
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
  favorites: 0,
  notes: 0,
  thumbnails: 0,
};

export class FakeEngine {
  /** Every request the component made, in order. */
  readonly seen: Request[] = [];

  readonly #options: FakeEngineOptions;
  readonly #libraries = new Map<string, FakeLibrary>();
  /** Mutable: an edit changes what the next read answers with. */
  readonly details = new Map<string, WireAssetDetail>();
  /** Mutable: an import adds rows, newest first. */
  assets: readonly AssetCard[];
  #open: LibrarySummary | undefined;
  #listeners = new Set<(event: unknown) => void>();

  constructor(options: FakeEngineOptions = {}) {
    this.#options = options;
    for (const library of options.existing ?? []) this.#libraries.set(library.root, library);
    for (const detail of options.details ?? []) this.details.set(detail.hash, detail);
    this.assets = options.assets ?? [];
  }

  /** The bridge the renderer will find on `window`. */
  bridge(): WindowBridge {
    return {
      invoke: <T extends RequestType>(request: RequestOf<T>): Promise<Outcome<ResponseOf<T>>> =>
        // Cast because the answer is chosen by the request's own type, which is
        // exactly what the contract's mapped types express and what a switch
        // over a union cannot narrow for the caller.
        Promise.resolve(this.#answer(request) as Outcome<ResponseOf<T>>),
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
          return problem("not_a_library", `${request.path} is not a Roost library`, {
            path: request.path,
          });
        }
        this.#open = summarize(found);
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
        return ok(this.#open);
      }

      case "library:current":
        return ok(this.#open ?? null);

      case "library:close":
        this.#open = undefined;
        return ok(null);

      case "library:sidebar":
        if (this.#open === undefined) {
          return problem("remote", "No library is open", {});
        }
        return ok(this.#options.sidebar ?? EMPTY_SIDEBAR);

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

      case "asset:favorite":
        return this.#mutate(request.hashes, (detail) => ({
          ...detail,
          isFavorite: request.favorite,
        }));

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

      case "asset:openExternally":
        return ok(this.#options.opensExternally ?? true);

      case "dialog:chooseImport":
        return ok(this.#options.importDialog ?? null);

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
        return ok(pageOf(rows, request.limit, request.after));
      }
    }
  }
}

/** Keyset paging over a plain array, the way the engine does it over SQLite. */
function pageOf(
  assets: readonly AssetCard[],
  limit: number,
  after: { readonly importedAt: number; readonly hash: string } | null,
): AssetPage {
  const start = after === null ? 0 : assets.findIndex((asset) => asset.hash === after.hash) + 1;
  const slice = assets.slice(start, start + limit);
  const last = slice[slice.length - 1];
  return {
    assets: slice,
    // A short page is the last page, which is the rule the grid stops on.
    next:
      slice.length < limit || last === undefined
        ? null
        : { importedAt: last.importedAt, hash: last.hash },
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
