import BetterSqlite3, { type Database } from "better-sqlite3";
import { applyMigrations, latestSchemaVersion, readSchemaVersion } from "./migrations.js";
import { attachPictures } from "./pictures.js";
import { Repo } from "./repo.js";

/** The file that holds the index, inside the library root. */
export const INDEX_FILE = "index.db";

/**
 * An open index database.
 *
 * **One writer, by construction.** The engine is single-threaded for database
 * work and is the only process that opens the index for writing, so
 * `SQLITE_BUSY` cannot happen between Roost's own connections. That removes the
 * mutex, the connection pool, and the retry loops the Rust build needed — not
 * because the discipline changed, but because the process model enforces it
 * (ADR-0006). The case that remains is a second Roost on the same library,
 * which the single-instance lock is for.
 *
 * The API is synchronous because `better-sqlite3` is. Wrapping a blocking
 * in-process call in a promise would buy an async veneer over the same block;
 * running it off the UI thread is what actually helps, and that is what the
 * engine process does.
 */
export class Db {
  readonly #db: Database;
  readonly #path: string;

  /** Statements and the connection they were compiled against, together. */
  readonly repo: Repo;

  private constructor(db: Database, path: string) {
    this.#db = db;
    this.#path = path;
    this.repo = new Repo(db);
  }

  /**
   * Opens (creating if absent) the index at `path`, attaches the thumbnail
   * database beside it (ADR-0051), and migrates the index to the current
   * schema version.
   */
  static open(path: string): Db {
    const db = new BetterSqlite3(path);
    try {
      // WAL is a persistent property of the file, but setting it is cheap and
      // makes an externally created or copied database safe to use. It is a
      // no-op on `:memory:`, where SQLite reports `memory` instead.
      db.pragma("journal_mode = WAL");
      configure(db);
      // Before the migrations, because 0002 copies the pictures into it.
      attachPictures(db, path);
      const before = readSchemaVersion(db);
      applyMigrations(db);
      // 0002 dropped the table that held nearly all of the file, and a drop
      // frees pages without returning them. Once, on the open that ran it: the
      // index is small without the pictures, so this rewrites only the rows.
      if (before === 1) db.exec("VACUUM main");
    } catch (error) {
      // Nothing else can close it: the `Db` that would own the connection is
      // never constructed, so the handle would be held until the process ends.
      // `SchemaTooNewError` is a path a person reaches from the picker and then
      // retries, so "until the process ends" means the rest of the session.
      db.close();
      throw error;
    }
    return new Db(db, path);
  }

  /**
   * A temporary in-memory index. Tests only.
   *
   * The Rust build needed a shared-cache URI here so its pooled readers saw the
   * writer's database. One connection needs no such trick.
   */
  static openInMemory(): Db {
    return Db.open(":memory:");
  }

  /** The schema version currently applied to this database. */
  schemaVersion(): number {
    return readSchemaVersion(this.#db);
  }

  /** The version this build understands, for comparison against the above. */
  static latestSchemaVersion(): number {
    return latestSchemaVersion();
  }

  get path(): string {
    return this.#path;
  }

  /**
   * Runs `fn` in a transaction, committing on return and rolling back on throw.
   *
   * Import and replay batch thousands of records into one transaction: SQLite
   * commits — and, under `synchronous = NORMAL`, syncs the WAL — once per
   * transaction rather than once per statement, which is the difference between
   * a rebuild that takes seconds and one that takes minutes. Nested calls
   * become savepoints, so a caller need not know whether it is already inside
   * one.
   */
  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn)();
  }

  /** Whether a transaction is open on this connection. */
  get inTransaction(): boolean {
    return this.#db.inTransaction;
  }

  /**
   * Manual transaction control, for a writer that has to span `await` points.
   *
   * {@link transaction} is the right tool everywhere else and should stay the
   * default: it commits and rolls back for you. It cannot be used for a
   * rebuild, though — `better-sqlite3` refuses a transaction function that
   * returns a promise, because an `await` inside one would let unrelated
   * statements interleave into the same transaction. Replay reads files, so it
   * awaits by nature.
   *
   * What makes the manual form sound here is the process model: the engine is
   * single-threaded and holds the only writing connection (ADR-0006), and a
   * rebuild is not serving reads while it runs. What is *not* sound is calling
   * these without a `finally` — an unclosed transaction holds the WAL open and
   * a failed rebuild leaves a partial index behind.
   */
  beginTransaction(): void {
    this.#db.exec("BEGIN");
  }

  commitTransaction(): void {
    this.#db.exec("COMMIT");
  }

  rollbackTransaction(): void {
    this.#db.exec("ROLLBACK");
  }

  /**
   * Escape hatch for a statement that is genuinely not a repository method:
   * `PRAGMA`, `ANALYZE`, `EXPLAIN QUERY PLAN`. Not a way around invariant 3 —
   * anything that reads or writes user data belongs in {@link Repo}.
   */
  pragma(source: string): unknown {
    return this.#db.pragma(source);
  }

  /**
   * Hands the thumbnail database's free pages back to the filesystem, and says
   * how many bytes that was (ADR-0051 §6).
   *
   * Deleting a picture frees its pages inside the file without shrinking it.
   * The file is created with `auto_vacuum = INCREMENTAL`, so this returns them
   * without the rewrite a plain `VACUUM` would do. It is what *Reclaim space…*
   * runs, after the cleaner.
   */
  reclaimPictureSpace(): number {
    // Both casts are what `simple: true` returns for these two pragmas: a
    // single integer column, which SQLite cannot answer in another shape.
    const pageSize = this.#db.pragma("pictures.page_size", { simple: true }) as number;
    const free = this.#db.pragma("pictures.freelist_count", { simple: true }) as number;
    this.#db.pragma("pictures.incremental_vacuum");
    return pageSize * free;
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * Per-connection pragmas.
 *
 * `foreign_keys` is set here even though `better-sqlite3` already turns it on
 * for every connection it opens — measured, not assumed. SQLite's own default
 * is off, the setting is per-connection, and the schema's `ON DELETE CASCADE`
 * rules quietly stop applying on whichever connection missed it. One line to
 * keep the guarantee ours rather than a driver's, and to keep migration 0001's
 * comment about it true of this code.
 */
function configure(db: Database): void {
  db.pragma("foreign_keys = ON");
  // NORMAL is the standard pairing with WAL: durable across application
  // crashes, at risk only from an OS-level one. For a cache that is rebuildable
  // from the journal, that trade is clearly worth the write speed.
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
}
