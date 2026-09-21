import { join } from "node:path";
import BetterSqlite3, { type Database, type Statement } from "better-sqlite3";
import type { AssetId } from "../model/index.js";
import { INDEX_FILE } from "./database.js";
import type { FileRecord } from "./repo.js";

/**
 * A read-only view of one library's index, for the `roost://` protocol handler.
 *
 * ADR-0008 is explicit that this is an exception to "the engine owns the
 * database" (`ARCHITECTURE.md` §3.2), and that the exception is narrow:
 * thumbnails are WebP BLOBs inside `index.db`, the protocol handler runs in
 * main, and the alternative is bytes crossing IPC — which invariant 12 forbids.
 * So main opens exactly one connection that **cannot** write, and this class is
 * the whole of what it may ask.
 *
 * `readonly: true` is enforced by SQLite, not by convention: a write statement
 * on this connection throws `SQLITE_READONLY` rather than succeeding quietly.
 * There is a test that runs one, so the guarantee stays a checked claim.
 *
 * WAL makes concurrent readers free, so this does not contend with the engine's
 * writer and needs no coordination with it.
 *
 * The ADR called this factory `ThumbnailReader`. It answers where an asset's
 * own file is as well, because `roost://file/<id>` needs the same connection
 * and a second one would be a second exception; the name follows the job.
 */
/**
 * How main's connection is opened.
 *
 * A named constant rather than an object literal inside {@link
 * ReadOnlyIndex.open}, so that a test can open a connection **the same way**
 * and prove what these flags actually do. Asserting `readonly: true` is
 * asserting a spelling; asserting that an `INSERT` throws on a connection
 * opened with this object is asserting the guarantee, and flipping the flag
 * here breaks that test.
 */
export const READ_ONLY_OPTIONS = { readonly: true, fileMustExist: true } as const;

export class ReadOnlyIndex {
  readonly #db: Database;
  readonly #cache = new Map<string, Statement>();

  private constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Opens the index inside `libraryRoot`.
   *
   * `fileMustExist` rather than creating: a missing index is a library that was
   * never opened, and an empty database created here would answer every
   * thumbnail with a 404 that looks like a missing thumbnail rather than a
   * missing library.
   */
  static open(libraryRoot: string): ReadOnlyIndex {
    const db = new BetterSqlite3(join(libraryRoot, INDEX_FILE), READ_ONLY_OPTIONS);
    // Not `journal_mode`: that is a write. A reader inherits WAL from the file.
    db.pragma("busy_timeout = 5000");
    return new ReadOnlyIndex(db);
  }

  #s(sql: string): Statement {
    const cached = this.#cache.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.#db.prepare(sql);
    this.#cache.set(sql, prepared);
    return prepared;
  }

  /** One thumbnail's WebP bytes, or `undefined` if it has not been generated. */
  thumbnail(id: AssetId, size: number): Buffer | undefined {
    const row = this.#s("SELECT data FROM thumbs WHERE asset_id = ? AND size = ?").get(id, size) as
      | { data: Buffer }
      | undefined;
    return row?.data;
  }

  /**
   * What is needed to find one asset's file.
   *
   * Two columns in version 2 rather than four: every asset's bytes are under
   * `files/` (RL-19), so there is no mode to branch on and no absolute path to
   * read back. The id and the extension are the whole address (RL-9).
   */
  findFile(id: AssetId): FileRecord | undefined {
    return this.#s("SELECT ext, size FROM assets WHERE id = ?").get(id) as FileRecord | undefined;
  }

  /**
   * The name the library shows for an asset (ADR-0034).
   *
   * Its own statement rather than a third column on {@link ReadOnlyIndex.findFile}:
   * that one runs on every preview the window opens, while this is asked once
   * per file being handed to another application. The name carries no
   * extension (RL-33), so a caller joining the two is what produces a filename.
   */
  displayName(id: AssetId): string | undefined {
    const row = this.#s("SELECT name FROM assets WHERE id = ?").get(id) as
      | { name: string }
      | undefined;
    return row?.name;
  }

  close(): void {
    this.#cache.clear();
    this.#db.close();
  }
}
