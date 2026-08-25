import { basename, resolve } from "node:path";
import type { LibraryStats, LibrarySummary, Request, ResponseOf } from "@roost/contract";
import { logger } from "@roost/core";
import { Library } from "@roost/library";

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
        const path = resolve(request.path);
        // An empty name is allowed on the wire and resolved here, the way the
        // CLI resolves it: the directory's own name is what someone who left
        // the field alone meant.
        const name = request.name.trim() === "" ? basename(path) : request.name;
        return this.#open(await Library.create(path, name, { exclusive: true }));
      }

      case "library:current":
        return this.#library === undefined ? null : summarize(this.#library);

      case "library:close":
        await this.close();
        return null;

      case "library:stats":
        return statsOf(this.#require());
    }
  }

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
