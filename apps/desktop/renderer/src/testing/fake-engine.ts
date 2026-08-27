import type {
  AssetCard,
  AssetPage,
  LibraryStats,
  LibrarySummary,
  Outcome,
  Request,
  RequestOf,
  RequestType,
  ResponseOf,
  RoostBridge,
  WireProblem,
  WireSidebar,
} from "@roost/contract";

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
  #open: LibrarySummary | undefined;
  #listeners = new Set<(event: unknown) => void>();

  constructor(options: FakeEngineOptions = {}) {
    this.#options = options;
    for (const library of options.existing ?? []) this.#libraries.set(library.root, library);
  }

  /** The bridge the renderer will find on `window`. */
  bridge(): RoostBridge {
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

  /** The rows a query answers with, or `undefined` if it was never taught one. */
  #rowsFor(query: string): readonly AssetCard[] | undefined {
    if (query.trim() === "") return this.#options.assets ?? [];
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
        return ok({ ...EMPTY_STATS, ...this.#options.stats });

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
    schemaVersion: 5,
  };
}

function ok(value: unknown): Outcome<unknown> {
  return { ok: true, value };
}

function problem(code: string, message: string, detail: WireProblem["detail"]): Outcome<unknown> {
  return { ok: false, problem: { code, message, detail } };
}

/** Installs a bridge on `window` for the duration of a test. */
export function install(engine: FakeEngine): void {
  Object.defineProperty(window, "roost", {
    value: engine.bridge(),
    configurable: true,
    writable: true,
  });
}
