import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireLock,
  Db,
  FileStore,
  INDEX_FILE,
  IndexSink,
  type InstanceLock,
  IoError,
  Journal,
  logger,
  type ReplayReport,
  replay,
  type Stats,
  type Storage,
} from "@roost/core";
import { LibraryBusyError } from "./error.js";
import {
  indexMatchesJournal,
  type JournalNotice,
  journalFingerprint,
  journalNotice,
  NOTHING_SKIPPED,
  rememberFold,
  rememberSkips,
} from "./journal-state.js";
import {
  type Manifest,
  newManifest,
  readManifest,
  refuseExistingLibrary,
  writeManifest,
} from "./manifest.js";
import { readSettings, type Settings, writeSettings } from "./settings.js";

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
 * journal, and the derived index. The file store is made on demand: there is
 * one of them in version 2 (RL-19), and it holds no state worth keeping.
 */
export class Library {
  readonly root: string;
  readonly manifest: Manifest;

  #db: Db;
  #journal: Journal;
  #lock: InstanceLock | undefined;
  #settings: Settings;
  #closed = false;
  #notice: JournalNotice = NOTHING_SKIPPED;

  private constructor(
    root: string,
    manifest: Manifest,
    db: Db,
    journal: Journal,
    lock: InstanceLock | undefined,
    settings: Settings,
  ) {
    this.root = root;
    this.manifest = manifest;
    this.#db = db;
    this.#journal = journal;
    this.#lock = lock;
    this.#settings = settings;
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
      // Read once and held, so a synchronous read path — the sidebar builds a
      // row's query from it — never has to reach the filesystem. Nothing here
      // can fail: an absent or damaged file is the defaults (ADR-0019).
      const settings = await readSettings(root);
      const library = new Library(root, manifest, db, journal, lock, settings);

      // The index is a cache the format does not describe (RL-2), so a library
      // written by another implementation arrives with no cache of ours — or
      // with one built before that implementation last appended. Either way the
      // journal is the library and the index is behind it, and a window that
      // drew the stale one would show an empty grid and say nothing. Through M4
      // that is exactly what it did.
      const fingerprint = await journalFingerprint(journal.dir);
      if (indexMatchesJournal(db, fingerprint)) library.#notice = journalNotice(db);
      else await library.#fold(fingerprint);

      log.debug("library opened", {
        root,
        schema: db.schemaVersion(),
        format: manifest.roost_library_version,
        exclusive: lock !== undefined,
      });
      return library;
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

  /**
   * What the last fold of this journal could not do (RL-26a, RL-28).
   *
   * Answered from the index rather than by replaying, so every open can say it
   * and not only the opens that rebuilt. Empty is the ordinary answer.
   */
  get notice(): JournalNotice {
    return this.#notice;
  }

  /** This library's preferences (ADR-0019). */
  get settings(): Settings {
    return this.#settings;
  }

  /**
   * Changes preferences, and says whether the change reached the disk.
   *
   * The in-memory value is updated either way: a library on read-only media
   * keeps the setting for the session and loses it on close, which ADR-0019
   * calls the correct outcome rather than a failure.
   */
  async updateSettings(patch: Partial<Settings>): Promise<boolean> {
    this.#settings = { ...this.#settings, ...patch };
    return writeSettings(this.root, patch);
  }

  get journal(): Journal {
    return this.#journal;
  }

  /** Where this library's asset bytes live: `files/`, and nowhere else. */
  get storage(): Storage {
    return new FileStore(this.root);
  }

  stats(): Stats {
    return this.#db.repo.stats();
  }

  /**
   * Records that the index now reflects the journal as it stands on disk.
   *
   * Called after every append, by the two places that write one — the edit path
   * and the import path. Without it every mutation would leave the index
   * looking stale to the next open, and the next open would fold the whole
   * journal to discover that nothing had changed.
   *
   * It is deliberately a separate step rather than something the journal does
   * on its own. The journal must not know the index exists (invariant 9's
   * direction), and the mark has to go down **after** the fold, or a crash
   * between the two would leave a mark claiming records the index never got.
   */
  async noteJournalAppended(): Promise<void> {
    rememberFold(this.#db, await journalFingerprint(this.#journal.dir));
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

    return this.#fold(await journalFingerprint(journalDir));
  }

  /**
   * Folds the whole journal into the index, and writes down that it did.
   *
   * Shared by `rebuild` and by an open that found the index behind the journal,
   * so there is one answer to "what does folding mean" rather than two that can
   * drift. It does **not** empty the index first — `rebuild` has already done
   * that, and an open must not: a fold triggered by another implementation
   * having appended one file would otherwise throw away every thumbnail in the
   * library to learn about that file. Replaying over what is there converges
   * on the same state, because every operation sets a value rather than
   * toggling one and the journal never loses a line.
   *
   * **The fingerprint is taken before the replay, not after.** A journal that
   * grows while this is running would otherwise be recorded as folded further
   * than it was, and those records would never be read. Under-claiming costs
   * one redundant fold at the next open; over-claiming loses data.
   */
  async #fold(fingerprint: Record<string, number>): Promise<ReplayReport> {
    const report = await replay(this.#journal.dir, new IndexSink(this.#db));

    this.#db.transaction(() => {
      rememberSkips(this.#db, report);
      rememberFold(this.#db, fingerprint);
    });
    this.#notice = journalNotice(this.#db);

    // Every counter on one line: a fold is the operation most worth being able
    // to reconstruct after the fact.
    log.info("journal folded", {
      months: report.months.length,
      applied: report.applied,
      unknownOps: report.unknownOps.size,
      dangling: report.dangling.length,
      malformed: report.malformed.length,
      tornTrailing: report.tornTrailing.length,
    });
    if (report.unknownOps.size > 0) {
      // Logged here and told to the person by whichever frontend is running —
      // RL-28 requires the second, and a log line is not it.
      log.warn("journal holds operations this build does not know; they were skipped", {
        ops: [...report.unknownOps.keys()].join(","),
      });
    }
    if (report.dangling.length > 0) {
      // Not an error: a record naming something another build deleted is the
      // ordinary result of editing one library from two of them (RL-26a).
      log.info("journal records named entities that are not there; they were skipped", {
        count: report.dangling.length,
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
