import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "better-sqlite3";
import { migrationSql } from "./migrations.js";

/**
 * The thumbnail database, relative to the library root (ADR-0051).
 *
 * Inside `thumbs/`, which the format reserves (RL-56) and leaves to each
 * implementation (RL-2), and named for this one so that another program using
 * the same directory cannot collide with it.
 */
export const THUMBNAILS_FILE = join("thumbs", "roost.db");

/** The schema name the thumbnail database is attached under. */
export const PICTURES_SCHEMA = "pictures";

/** The one version of `thumbs_schema.sql`, kept in `PRAGMA user_version`. */
const PICTURES_VERSION = 1;

/**
 * Where the thumbnail database for the index at `indexPath` lives.
 *
 * Beside the index, because both are caches of the same library. An in-memory
 * index gets an in-memory one, so a test that opens one never touches a disk.
 */
export function picturesPathFor(indexPath: string): string {
  return indexPath === ":memory:" ? ":memory:" : join(dirname(indexPath), THUMBNAILS_FILE);
}

/**
 * Attaches the thumbnail database to `db` as {@link PICTURES_SCHEMA}, creating
 * it and its directory where absent.
 *
 * It runs before the index's migrations, because migration 0002 copies the
 * pictures across into it.
 *
 * A file at a version this build does not know is emptied and made again
 * rather than refused: nothing in it is data (RL-2), so the only cost is the
 * time it takes to draw the pictures again.
 */
export function attachPictures(db: Database, indexPath: string): void {
  const path = picturesPathFor(indexPath);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  db.prepare(`ATTACH DATABASE ? AS ${PICTURES_SCHEMA}`).run(path);

  const version = db.pragma(`${PICTURES_SCHEMA}.user_version`, { simple: true });
  if (version === PICTURES_VERSION) {
    configurePictures(db);
    return;
  }

  db.exec(`DROP TABLE IF EXISTS ${PICTURES_SCHEMA}.thumbs`);
  db.exec(`DROP TABLE IF EXISTS ${PICTURES_SCHEMA}.sources`);
  // Only takes effect on a file with no tables yet, which after the two drops
  // above is every file this branch creates. Deleting rows then frees pages
  // that `incremental_vacuum` can hand back, instead of a `VACUUM` that would
  // rewrite gigabytes.
  db.pragma(`${PICTURES_SCHEMA}.auto_vacuum = INCREMENTAL`);
  configurePictures(db);
  db.exec("BEGIN");
  try {
    db.exec(migrationSql("thumbs_schema.sql"));
    db.pragma(`${PICTURES_SCHEMA}.user_version = ${PICTURES_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * The per-schema pragmas, the same pairing the index has (`database.ts`).
 *
 * WAL for the same reason as the index: main reads thumbnails on its own
 * connection while the engine writes them, and neither may block the other.
 */
function configurePictures(db: Database): void {
  db.pragma(`${PICTURES_SCHEMA}.journal_mode = WAL`);
  db.pragma(`${PICTURES_SCHEMA}.synchronous = NORMAL`);
}
