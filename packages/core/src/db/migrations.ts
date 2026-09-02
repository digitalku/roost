import { readFileSync } from "node:fs";
import type { Database } from "better-sqlite3";
import {
  MigrationFailedError,
  SchemaTooNewError,
  UnreadableSchemaVersionError,
} from "../model/index.js";

/** One numbered migration, and the file in `packages/core/migrations/` holding it. */
interface Migration {
  readonly version: number;
  readonly name: string;
  readonly file: string;
}

/**
 * Every migration, in ascending version order.
 *
 * **Append only.** The runner records the version number and not the SQL it
 * ran, so editing an entry that has shipped leaves already-migrated libraries
 * silently unlike new ones.
 *
 * Migrations 0001–0005 are carried over verbatim from the Rust implementation,
 * numbers included, because a library created there arrives already at v5 with
 * those five versions in its bookkeeping. A fresh consolidated baseline would
 * either re-run against it or disagree about what version it is. The first
 * migration this repository authors is 0006 (`DATA_MODEL.md` port note).
 */
const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial", file: "0001_initial.sql" },
  { version: 2, name: "m2_organize", file: "0002_m2_organize.sql" },
  { version: 3, name: "keyset_index", file: "0003_keyset_index.sql" },
  { version: 4, name: "tag_groups", file: "0004_tag_groups.sql" },
  { version: 5, name: "grid_filter_indexes", file: "0005_grid_filter_indexes.sql" },
  { version: 6, name: "m4_derive", file: "0006_m4_derive.sql" },
  { version: 7, name: "trash", file: "0007_trash.sql" },
  { version: 8, name: "comments", file: "0008_comments.sql" },
  { version: 9, name: "poster", file: "0009_poster.sql" },
];

/** The schema version this build understands. */
export function latestSchemaVersion(): number {
  return MIGRATIONS.at(-1)?.version ?? 0;
}

const sqlCache = new Map<string, string>();

/**
 * The SQL of one migration, read from `packages/core/migrations/`.
 *
 * Read from disk rather than inlined into this file so that the `.sql` files
 * stay the single source of truth — `tests/spec-conformance.test.ts` compares
 * them against the published schema, and a second copy in TypeScript is a
 * second thing to keep in step.
 *
 * The relative path works from `src/db/` and from `dist/db/` alike, because
 * both sit one directory below the package root. Packaging has to carry
 * `migrations/` into the app bundle; `TODO.md` records that for M6.
 */
export function migrationSql(file: string): string {
  const cached = sqlCache.get(file);
  if (cached !== undefined) return cached;
  const sql = readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8");
  sqlCache.set(file, sql);
  return sql;
}

/** Every migration's version, name, and SQL, for the conformance test. */
export function allMigrations(): { version: number; name: string; sql: string }[] {
  return MIGRATIONS.map((m) => ({ version: m.version, name: m.name, sql: migrationSql(m.file) }));
}

/**
 * Brings `db` up to {@link latestSchemaVersion}, returning the version now in
 * place.
 *
 * Forward-only, one transaction per migration. A bad migration is fixed by
 * writing another one — and because the index is a derived cache, the nuclear
 * option of deleting `index.db` and replaying the journal is always available.
 * Keeping that available is what makes forward-only tolerable.
 */
export function applyMigrations(db: Database): number {
  const current = readSchemaVersion(db);
  const latest = latestSchemaVersion();

  if (current > latest) throw new SchemaTooNewError(current, latest);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    const sql = migrationSql(migration.file);
    // `exec` runs a batch and cannot be wrapped by `db.transaction`, which
    // refuses statements that manage transactions themselves. BEGIN/COMMIT by
    // hand is what leaves a failed migration with nothing half-applied.
    db.exec("BEGIN");
    try {
      db.exec(sql);
      // Prepared here rather than once above the loop: `better-sqlite3`
      // compiles at prepare time, and on a fresh database `meta` does not exist
      // until the statement two lines up has run.
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(migration.version));
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw new MigrationFailedError(migration.version, migration.name, cause);
    }
  }

  return latest;
}

/**
 * Reads `meta.schema_version`.
 *
 * A database with no `meta` table is version 0 — that is what an empty file
 * looks like before migration 1 runs.
 */
export function readSchemaVersion(db: Database): number {
  // Both casts are guaranteed by the projection three lines above them: the
  // column list is written here and SQLite cannot return a different shape.
  const hasMeta = db
    .prepare(
      `SELECT EXISTS (
         SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'
       ) AS present`,
    )
    .get() as { present: number };
  if (hasMeta.present === 0) return 0;

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;

  // A `meta` table with no version row is an interrupted first migration, or a
  // file that is not ours. Either way, reporting 0 would replay migration 1
  // over existing tables and blame a `CREATE TABLE` for it.
  if (row === undefined) throw new UnreadableSchemaVersionError("<missing>");

  // Digits only, and not via `Number`: it reads "" and " " as 0, which is the
  // one wrong answer here — it would re-run every migration over a live schema.
  if (!/^\d+$/.test(row.value)) throw new UnreadableSchemaVersionError(row.value);
  return Number(row.value);
}
