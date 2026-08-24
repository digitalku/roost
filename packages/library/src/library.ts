import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireLock,
  Db,
  INDEX_FILE,
  IndexSink,
  type InstanceLock,
  IoError,
  Journal,
  logger,
  ManagedStorage,
  ReferencedStorage,
  type ReplayReport,
  replay,
  type Stats,
  type Storage,
  type StorageMode,
} from "@roost/core";
import { LibraryBusyError } from "./error.js";
import {
  type Manifest,
  newManifest,
  readManifest,
  refuseExistingLibrary,
  writeManifest,
} from "./manifest.js";

const log = logger("library");

/** Current unix time in **seconds**, which is what the schema and journal use. */
export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

export interface OpenOptions {
  /**
   * Refuse if another live process holds the library.
   *
   * A second *window* is not the same as a second CLI run. Folder ids are
   * minted as `max(id) + 1` from each process's own view of the index, so two
   * windows each creating a folder would mint the same id and the journal —
   * the source of truth — would carry both. WAL cannot help: the collision is
   * decided before the write, and a journal append is not a database
   * transaction at all.
   *
   * The CLI does not want this. Two `roost tag` runs at once is an ordinary
   * thing to want, and WAL is built for exactly that.
   */
  readonly exclusive?: boolean;
}

/**
 * An open Roost library.
 *
 * Holds the three pieces a library is on disk — the manifest, the append-only
 * journal, and the derived index. The object store is made on demand, because
 * which one applies depends on the import mode rather than on the library.
 */
export class Library {
  readonly root: string;
  readonly manifest: Manifest;

  #db: Db;
  #journal: Journal;
  #lock: InstanceLock | undefined;
  #closed = false;

  private constructor(
    root: string,
    manifest: Manifest,
    db: Db,
    journal: Journal,
    lock: InstanceLock | undefined,
  ) {
    this.root = root;
    this.manifest = manifest;
    this.#db = db;
    this.#journal = journal;
    this.#lock = lock;
  }

  /** Creates a library at `root` and opens it. */
  static async create(root: string, name: string, options: OpenOptions = {}): Promise<Library> {
    await refuseExistingLibrary(root);
    try {
      await mkdir(root, { recursive: true });
    } catch (cause) {
      throw new IoError("mkdir", root, cause);
    }
    await writeManifest(root, newManifest(name, nowUnix()));
    return Library.open(root, options);
  }

  static async open(root: string, options: OpenOptions = {}): Promise<Library> {
    // The manifest is read before the lock is taken, so that pointing at the
    // wrong folder reports "not a library" rather than "busy": the lock path is
    // derived from the canonical root and says nothing about whether a library
    // is there at all.
    const manifest = await readManifest(root);

    let lock: InstanceLock | undefined;
    if (options.exclusive === true) {
      const outcome = await acquireLock(root);
      if (outcome.kind === "busy") throw new LibraryBusyError(root, outcome.pid);
      lock = outcome.lock;
    }

    try {
      const db = Db.open(join(root, INDEX_FILE));
      const journal = await Journal.open(root);
      log.debug("library opened", {
        root,
        schema: db.schemaVersion(),
        format: manifest.roost_library_version,
        exclusive: lock !== undefined,
      });
      return new Library(root, manifest, db, journal, lock);
    } catch (error) {
      // A lock taken and then abandoned would keep the library shut until
      // someone deleted the file by hand.
      await lock?.release();
      throw error;
    }
  }

  get db(): Db {
    return this.#db;
  }

  get journal(): Journal {
    return this.#journal;
  }

  /** The object store for `mode`. */
  storageFor(mode: StorageMode): Storage {
    return mode === "managed" ? new ManagedStorage(this.root) : new ReferencedStorage();
  }

  stats(): Stats {
    return this.#db.repo.stats();
  }

  /**
   * Releases the journal handle, the database, and the lock.
   *
   * Explicit, and not optional: the journal buffers up to 64 KiB, so a library
   * dropped without closing loses whatever had not been flushed. The third
   * place in this codebase where JavaScript's lack of a destructor becomes part
   * of an API.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#journal.close();
    this.#db.close();
    await this.#lock?.release();
  }

  /**
   * Deletes the index and rebuilds it by replaying the journal.
   *
   * This is invariant 1 made executable: everything in `index.db` other than
   * the derived caches comes from the journal, so throwing it away has to be
   * survivable. Thumbnails do not come back — they derive from bytes, not from
   * records — and `roost thumb` is what restores them.
   *
   * The Rust build consumed the library and returned a new one, so a stale
   * handle was a type error. Here the handles are replaced in place instead:
   * the caller's reference stays valid, which matters more in a language where
   * "the old object is unusable now" cannot be expressed.
   */
  async rebuild(): Promise<ReplayReport> {
    const journalDir = this.#journal.dir;

    // Every connection has to be closed before the file underneath them goes.
    await this.#journal.close();
    this.#db.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      const path = join(this.root, `${INDEX_FILE}${suffix}`);
      try {
        await rm(path, { force: true });
      } catch (cause) {
        throw new IoError("remove", path, cause);
      }
    }

    this.#db = Db.open(join(this.root, INDEX_FILE));
    this.#journal = await Journal.open(this.root);

    const report = await replay(journalDir, new IndexSink(this.#db));

    // Every counter on one line: a rebuild is the operation most worth being
    // able to reconstruct after the fact.
    log.info("rebuild complete", {
      months: report.months.length,
      applied: report.applied,
      unknownOps: report.unknownOps.size,
      malformed: report.malformed.length,
      tornTrailing: report.tornTrailing.length,
    });
    if (report.unknownOps.size > 0) {
      log.warn("journal holds operations this build does not know; they were skipped", {
        ops: [...report.unknownOps.keys()].join(","),
      });
    }
    if (report.malformed.length > 0) {
      log.error("journal lines could not be read — this is data loss, not a version gap", {
        count: report.malformed.length,
      });
    }

    return report;
  }
}
