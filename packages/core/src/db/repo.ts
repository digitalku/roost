import type { Database, Statement } from "better-sqlite3";
import type { AddRecord } from "../journal/index.js";
import type { ContentHash } from "../model/index.js";
import type { Cursor, Filter, Page, SearchHit } from "./query.js";

/**
 * Summary counts for `roost stats`.
 *
 * Every field is a count or a byte total, so every field is an integer. None of
 * them can reach 2^53: `totalBytes` would need nine petabytes in one library,
 * and `better-sqlite3` reads past that boundary by silently rounding rather
 * than by switching to `bigint` (`DATA_MODEL.md` §4).
 */
export interface Stats {
  readonly assets: number;
  readonly managed: number;
  readonly referenced: number;
  readonly partialHashes: number;
  readonly totalBytes: number;
  readonly tags: number;
  readonly tagGroups: number;
  readonly folders: number;
  readonly smartFolders: number;
  readonly rated: number;
  readonly favorites: number;
  readonly notes: number;
  readonly thumbnails: number;
}

/**
 * The same counts with derived data zeroed.
 *
 * Use this, not a whole-object comparison, to check a rebuilt index against
 * what it replaced. Thumbnails are derived and deliberately absent from the
 * journal, so a *correct* rebuild must come back without them — comparing every
 * field would report that correct behaviour as a violation of invariant 1.
 */
export function withoutDerived(stats: Stats): Stats {
  return { ...stats, thumbnails: 0 };
}

/** What the index knows about an asset, for deduplication checks. */
export interface AssetSummary {
  readonly hash: ContentHash;
  readonly size: number;
  readonly ext: string;
  readonly origName: string;
}

/**
 * Where an asset's bytes are, and how big they are.
 *
 * Leaner than {@link AssetDetail} on purpose: serving a file needs four columns
 * and no joins, and this runs on every preview the window opens.
 */
export interface OriginalRecord {
  readonly ext: string;
  readonly size: number;
  readonly storageMode: string;
  /** Set for referenced assets, whose bytes never entered the object store. */
  readonly refPath: string | null;
}

/** An asset that needs a thumbnail, and where to find its bytes. */
export interface ThumbnailTarget {
  readonly hash: ContentHash;
  readonly ext: string;
  readonly storageMode: string;
  readonly refPath: string | null;
}

/** Everything the detail view shows about one asset. */
export interface AssetDetail {
  readonly hash: ContentHash;
  readonly ext: string;
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly origName: string;
  readonly storageMode: string;
  readonly refPath: string | null;
  readonly isPartialHash: boolean;
  readonly createdAt: number | null;
  readonly importedAt: number;
  readonly rating: number | null;
  readonly note: string | null;
  readonly isFavorite: boolean;
  readonly tags: string[];
  readonly folders: string[];
}

/** One row of the folder tree. */
export interface FolderRow {
  readonly id: number;
  readonly parentId: number | null;
  readonly name: string;
}

/** A saved query, and where it sits in the smart-folder tree. */
export interface SmartFolderRow {
  readonly id: number;
  readonly parentId: number | null;
  readonly name: string;
  readonly query: string;
}

/** A group arranges tags; it does not contain assets. */
export interface TagGroupRow {
  readonly id: number;
  readonly name: string;
}

/** A tag, how many assets carry it, and the group it is arranged under. */
export interface TagRow {
  readonly name: string;
  readonly count: number;
  /** `null` for a tag in no group. */
  readonly group: string | null;
}

/**
 * The only place in the workspace where SQL is written and executed
 * (invariant 3).
 *
 * Each `apply*` method folds one journal operation into the index, so the index
 * is exactly "the journal, folded". Rebuild and live mutation share these
 * methods rather than each having their own SQL, which is what makes "a rebuilt
 * database equals an incrementally built one" a property of the design rather
 * than a coincidence to be tested for.
 *
 * **Row casts.** Every `as` in this file is guaranteed by the projection
 * written immediately above it: the column list and its aliases are literals
 * here, and SQLite cannot return a shape the statement did not ask for. What it
 * *can* return is `null` where the schema allows it, and those columns are
 * typed `| null` accordingly.
 */
export class Repo {
  readonly #db: Database;
  readonly #cache = new Map<string, Statement>();

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Prepares once and reuses.
   *
   * `better-sqlite3` has no equivalent of `prepare_cached`, and replay compiles
   * the same handful of statements once per record — a million times over a
   * large rebuild. The cache is per-connection because a `Statement` is.
   */
  #s(sql: string): Statement {
    let stmt = this.#cache.get(sql);
    if (stmt === undefined) {
      stmt = this.#db.prepare(sql);
      this.#cache.set(sql, stmt);
    }
    return stmt;
  }

  // --- Mutations: one method per journal operation --------------------------

  /**
   * Inserts or updates the row for an `add` record.
   *
   * `ON CONFLICT ... DO UPDATE` rather than `INSERT OR REPLACE`: the latter
   * deletes the existing row first, and the schema's `ON DELETE CASCADE` would
   * take the asset's tags and folder memberships with it.
   */
  applyAdd(ts: number, add: AddRecord): void {
    this.#s(
      `INSERT INTO assets (
           hash, ext, size, width, height, orig_name, storage_mode,
           link_method, ref_path, is_partial_hash, created_at, imported_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET
           ext = excluded.ext,
           size = excluded.size,
           width = excluded.width,
           height = excluded.height,
           orig_name = excluded.orig_name,
           storage_mode = excluded.storage_mode,
           link_method = excluded.link_method,
           ref_path = excluded.ref_path,
           is_partial_hash = excluded.is_partial_hash,
           created_at = excluded.created_at,
           imported_at = excluded.imported_at`,
    ).run(
      add.hash,
      add.ext,
      add.size,
      // `?? null` throughout, never the bare `undefined`. It happens to bind as
      // NULL today, but the journal's optional fields are exactly the ones a
      // rebuild cannot recover from `originals/`, so nothing here rests on an
      // undocumented convenience.
      add.w ?? null,
      add.h ?? null,
      add.name,
      add.mode,
      add.link ?? null,
      add.ref ?? null,
      add.partial === true ? 1 : 0,
      add.created ?? null,
      ts,
    );
    this.#refreshFts(add.hash);
  }

  /**
   * Deletes an asset and everything hanging off it.
   *
   * Foreign keys cascade to `thumbs`, `asset_tags`, and `asset_folders`, but
   * `assets_fts` is a virtual table with no foreign keys, so its row has to go
   * explicitly or search keeps returning a deleted asset.
   */
  applyRemove(hash: ContentHash): void {
    // Read the rowid before deleting: it is the key into the FTS table, whose
    // `hash` column is UNINDEXED and therefore not searchable.
    const row = this.#s("SELECT rowid FROM assets WHERE hash = ?").get(hash) as
      | { rowid: number }
      | undefined;

    this.#s("DELETE FROM assets WHERE hash = ?").run(hash);

    if (row !== undefined) {
      this.#s("DELETE FROM assets_fts WHERE rowid = ?").run(row.rowid);
    }
  }

  applyTagAdd(hash: ContentHash, tags: readonly string[]): void {
    for (const tag of tags) {
      // `tags.name` is UNIQUE COLLATE NOCASE, so this both creates the tag and,
      // on a case variant, leaves the existing spelling alone.
      this.#s("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(tag);
      this.#s(
        `INSERT OR IGNORE INTO asset_tags (hash, tag_id)
         SELECT ?, id FROM tags WHERE name = ?`,
      ).run(hash, tag);
    }
    this.#refreshFts(hash);
  }

  applyTagRemove(hash: ContentHash, tags: readonly string[]): void {
    for (const tag of tags) {
      this.#s(
        `DELETE FROM asset_tags
          WHERE hash = ? AND tag_id IN (SELECT id FROM tags WHERE name = ?)`,
      ).run(hash, tag);
    }
    this.#refreshFts(hash);
  }

  /**
   * Creates a folder at the id the journal recorded.
   *
   * The id is inserted verbatim rather than autoassigned: `folder_add` records
   * refer to it, and letting SQLite choose during replay would make them dangle.
   */
  applyFolderCreate(id: number, parent: number | null, name: string): void {
    this.#s(
      `INSERT INTO folders (id, parent_id, name) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name`,
    ).run(id, parent, name);
  }

  applyFolderAdd(hash: ContentHash, folder: number): void {
    this.#s("INSERT OR IGNORE INTO asset_folders (hash, folder_id) VALUES (?, ?)").run(
      hash,
      folder,
    );
  }

  applyFolderRemove(hash: ContentHash, folder: number): void {
    this.#s("DELETE FROM asset_folders WHERE hash = ? AND folder_id = ?").run(hash, folder);
  }

  applyFolderRename(id: number, name: string): void {
    this.#s("UPDATE folders SET name = ? WHERE id = ?").run(name, id);
  }

  applyFolderMove(id: number, parent: number | null): void {
    this.#s("UPDATE folders SET parent_id = ? WHERE id = ?").run(parent, id);
  }

  /**
   * Deletes a folder. Descendants and memberships follow by cascade; the assets
   * themselves are untouched, which is the whole point of folders being
   * collections rather than locations.
   */
  applyFolderDelete(id: number): void {
    this.#s("DELETE FROM folders WHERE id = ?").run(id);
  }

  /**
   * Renames the asset's display name. The file on disk is named for its hash
   * and is not touched (invariant 2).
   */
  applyAssetRename(hash: ContentHash, name: string): void {
    this.#s("UPDATE assets SET orig_name = ? WHERE hash = ?").run(name, hash);
    this.#refreshFts(hash);
  }

  /**
   * Renames a tag, merging into the target if one already exists.
   *
   * Merging is not a convenience: `tags.name` is `UNIQUE COLLATE NOCASE`, so a
   * rename onto an existing name has no other outcome that both succeeds and
   * replays to the same state.
   */
  applyTagRename(from: string, to: string): void {
    const source = this.#s("SELECT id FROM tags WHERE name = ?").get(from) as
      | { id: number }
      | undefined;
    if (source === undefined) return;

    // Gathered before the change: afterwards the memberships have moved and
    // there is no way back to the list of assets whose text needs reindexing.
    const affected = this.#assetsWithTag(source.id);

    const target = this.#s("SELECT id FROM tags WHERE name = ?").get(to) as
      | { id: number }
      | undefined;

    if (target === undefined || target.id === source.id) {
      // A case-only rename resolves to the tag itself, because the column
      // compares case-insensitively. Renaming it in place is what was asked for.
      this.#s("UPDATE tags SET name = ? WHERE id = ?").run(to, source.id);
    } else {
      this.#s(
        `INSERT OR IGNORE INTO asset_tags (hash, tag_id)
         SELECT hash, ? FROM asset_tags WHERE tag_id = ?`,
      ).run(target.id, source.id);
      // Memberships of the source go with it, by cascade.
      this.#s("DELETE FROM tags WHERE id = ?").run(source.id);
    }

    for (const hash of affected) this.#refreshFts(hash);
  }

  /** `null` clears the rating, which the schema distinguishes from one star. */
  applyRate(hash: ContentHash, rating: number | null): void {
    this.#s("UPDATE assets SET rating = ? WHERE hash = ?").run(rating, hash);
  }

  /** `null` clears the note. */
  applyNoteSet(hash: ContentHash, note: string | null): void {
    this.#s("UPDATE assets SET note = ? WHERE hash = ?").run(note, hash);
  }

  applyFavoriteSet(hash: ContentHash, favorite: boolean): void {
    // `better-sqlite3` refuses to bind a boolean — it accepts numbers, strings,
    // bigints, buffers, and null, and throws on anything else. The column is
    // `INTEGER CHECK (is_favorite IN (0, 1))`, so this is the conversion the
    // schema was always asking for.
    this.#s("UPDATE assets SET is_favorite = ? WHERE hash = ?").run(favorite ? 1 : 0, hash);
  }

  /**
   * Creates a smart folder at the id the journal recorded, for the same reason
   * `folder_create` does: later records refer to it by that id.
   */
  applySmartFolderCreate(id: number, parent: number | null, name: string, query: string): void {
    this.#s(
      `INSERT INTO smart_folders (id, parent_id, name, query) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
           parent_id = excluded.parent_id,
           name = excluded.name,
           query = excluded.query`,
    ).run(id, parent, name, query);
  }

  applySmartFolderUpdate(id: number, name: string, query: string): void {
    this.#s("UPDATE smart_folders SET name = ?, query = ? WHERE id = ?").run(name, query, id);
  }

  applySmartFolderDelete(id: number): void {
    this.#s("DELETE FROM smart_folders WHERE id = ?").run(id);
  }

  applyTagGroupCreate(id: number, name: string): void {
    this.#s(
      `INSERT INTO tag_groups (id, name) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
    ).run(id, name);
  }

  applyTagGroupRename(id: number, name: string): void {
    this.#s("UPDATE tag_groups SET name = ? WHERE id = ?").run(name, id);
  }

  /**
   * Deletes a group. `tags.group_id` is `ON DELETE SET NULL`, so the tags in it
   * survive ungrouped rather than being deleted along with the arrangement.
   */
  applyTagGroupDelete(id: number): void {
    this.#s("DELETE FROM tag_groups WHERE id = ?").run(id);
  }

  /**
   * Puts a tag in a group, or takes it out.
   *
   * Creates the tag if it does not exist yet, so grouping a tag before anything
   * carries it works — which is how a user builds a taxonomy before importing.
   */
  applyTagGroupSet(tag: string, group: number | null): void {
    this.#s("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(tag);
    this.#s("UPDATE tags SET group_id = ? WHERE name = ?").run(group, tag);
  }

  // --- Internals ------------------------------------------------------------

  #assetsWithTag(tagId: number): ContentHash[] {
    const rows = this.#s("SELECT hash FROM asset_tags WHERE tag_id = ?").all(tagId) as {
      hash: ContentHash;
    }[];
    return rows.map((r) => r.hash);
  }

  /**
   * Rewrites an asset's full-text row from its current name and tags.
   *
   * Recomputing rather than patching keeps the search index derivable from the
   * same state as everything else, so a rebuild cannot produce different search
   * results from an incremental build.
   *
   * Keyed by **rowid**, deliberately. `assets_fts.hash` is an `UNINDEXED`
   * column, so `DELETE ... WHERE hash = ?` forces a full scan of the FTS table
   * once per imported asset — quadratic, and measured in the Rust build as a
   * 4x throughput collapse between 20k and 100k assets. Aligning the FTS rowid
   * with `assets.rowid` turns both the delete and the insert into rowid lookups.
   */
  #refreshFts(hash: ContentHash): void {
    const row = this.#s(
      `SELECT a.rowid AS rowid, a.orig_name AS origName,
              (SELECT group_concat(t.name, ' ')
                 FROM asset_tags at JOIN tags t ON t.id = at.tag_id
                WHERE at.hash = a.hash) AS tags
         FROM assets a WHERE a.hash = ?`,
    ).get(hash) as { rowid: number; origName: string; tags: string | null } | undefined;

    if (row === undefined) return;

    this.#s("DELETE FROM assets_fts WHERE rowid = ?").run(row.rowid);
    this.#s("INSERT INTO assets_fts (rowid, hash, orig_name, tags) VALUES (?, ?, ?, ?)").run(
      row.rowid,
      hash,
      row.origName,
      row.tags ?? "",
    );
  }

  // --- Reads ----------------------------------------------------------------

  findOriginal(hash: ContentHash): OriginalRecord | undefined {
    return this.#s(
      `SELECT ext, size, storage_mode AS storageMode, ref_path AS refPath
         FROM assets WHERE hash = ?`,
    ).get(hash) as OriginalRecord | undefined;
  }

  findAsset(hash: ContentHash): AssetSummary | undefined {
    return this.#s("SELECT hash, size, ext, orig_name AS origName FROM assets WHERE hash = ?").get(
      hash,
    ) as AssetSummary | undefined;
  }

  /** One asset with its tags and folder names resolved. */
  assetDetail(hash: ContentHash): AssetDetail | undefined {
    const base = this.#s(
      `SELECT hash, ext, size, width, height, orig_name AS origName,
              storage_mode AS storageMode, ref_path AS refPath,
              is_partial_hash AS isPartialHash, created_at AS createdAt,
              imported_at AS importedAt, rating, note, is_favorite AS isFavorite
         FROM assets WHERE hash = ?`,
    ).get(hash) as
      | (Omit<AssetDetail, "isPartialHash" | "isFavorite" | "tags" | "folders"> & {
          isPartialHash: number;
          isFavorite: number;
        })
      | undefined;

    if (base === undefined) return undefined;

    const tags = this.#s(
      `SELECT t.name AS name FROM asset_tags at JOIN tags t ON t.id = at.tag_id
        WHERE at.hash = ? ORDER BY t.name`,
    ).all(hash) as { name: string }[];

    const folders = this.#s(
      `SELECT f.name AS name FROM asset_folders af JOIN folders f ON f.id = af.folder_id
        WHERE af.hash = ? ORDER BY f.name`,
    ).all(hash) as { name: string }[];

    return {
      ...base,
      isPartialHash: base.isPartialHash !== 0,
      isFavorite: base.isFavorite !== 0,
      tags: tags.map((t) => t.name),
      folders: folders.map((f) => f.name),
    };
  }

  stats(): Stats {
    const totals = this.#s(
      `SELECT count(*) AS assets,
              coalesce(sum(storage_mode = 'managed'), 0) AS managed,
              coalesce(sum(storage_mode = 'referenced'), 0) AS referenced,
              coalesce(sum(is_partial_hash), 0) AS partialHashes,
              coalesce(sum(size), 0) AS totalBytes
         FROM assets`,
    ).get() as Pick<Stats, "assets" | "managed" | "referenced" | "partialHashes" | "totalBytes">;

    return {
      ...totals,
      tags: this.#count("SELECT count(*) AS n FROM tags"),
      tagGroups: this.#count("SELECT count(*) AS n FROM tag_groups"),
      folders: this.#count("SELECT count(*) AS n FROM folders"),
      smartFolders: this.#count("SELECT count(*) AS n FROM smart_folders"),
      rated: this.#count("SELECT count(*) AS n FROM assets WHERE rating IS NOT NULL"),
      favorites: this.#count("SELECT count(*) AS n FROM assets WHERE is_favorite = 1"),
      notes: this.#count("SELECT count(*) AS n FROM assets WHERE note IS NOT NULL"),
      thumbnails: this.#count("SELECT count(*) AS n FROM thumbs"),
    };
  }

  #count(sql: string): number {
    return (this.#s(sql).get() as { n: number }).n;
  }

  /**
   * Stores or replaces one thumbnail BLOB.
   *
   * Thumbnails are derived data and therefore never journalled: a rebuild
   * discards them, and regenerating from `originals/` restores them.
   */
  putThumbnail(hash: ContentHash, size: number, width: number, height: number, data: Buffer): void {
    this.#s(
      `INSERT INTO thumbs (hash, size, width, height, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hash, size) DO UPDATE SET
           width = excluded.width, height = excluded.height, data = excluded.data`,
    ).run(hash, size, width, height, data);
  }

  /** One thumbnail's bytes, or `undefined` if it has not been generated. */
  thumbnail(hash: ContentHash, size: number): Buffer | undefined {
    const row = this.#s("SELECT data FROM thumbs WHERE hash = ? AND size = ?").get(hash, size) as
      | { data: Buffer }
      | undefined;
    return row?.data;
  }

  /** Where one asset's bytes are, for generating a thumbnail on demand. */
  thumbnailTarget(hash: ContentHash): ThumbnailTarget | undefined {
    return this.#s(
      `SELECT hash, ext, storage_mode AS storageMode, ref_path AS refPath
         FROM assets WHERE hash = ?`,
    ).get(hash) as ThumbnailTarget | undefined;
  }

  /**
   * Assets missing a thumbnail at **any** of `sizes`.
   *
   * Not keyed on one size: the grid size is generated eagerly and the preview
   * size on first use, so an asset can hold one and lack the other, and a
   * single-size probe would report a backfill as already done.
   *
   * `NOT EXISTS` per size rather than a join or `IN`: `thumbs` is keyed on
   * `(hash, size)`, so each probe is a primary-key lookup instead of a set that
   * has to be materialised first.
   */
  assetsMissingThumbnails(sizes: readonly number[], limit: number): ThumbnailTarget[] {
    if (sizes.length === 0) return [];

    // Built from `sizes.length`, never from its contents — the values stay
    // bound. Every caller passes a compile-time constant, not user input.
    const probes = sizes
      .map(() => "NOT EXISTS (SELECT 1 FROM thumbs t WHERE t.hash = a.hash AND t.size = ?)")
      .join(" OR ");

    return this.#s(
      `SELECT a.hash AS hash, a.ext AS ext, a.storage_mode AS storageMode,
              a.ref_path AS refPath
         FROM assets a
        WHERE ${probes}
        ORDER BY a.imported_at DESC
        LIMIT ?`,
    ).all(...sizes, limit) as ThumbnailTarget[];
  }

  /** Every asset hash in the index, for comparing a rebuild against the original. */
  allHashes(): ContentHash[] {
    const rows = this.#s("SELECT hash FROM assets ORDER BY hash").all() as {
      hash: ContentHash;
    }[];
    return rows.map((r) => r.hash);
  }

  /**
   * Resolves a unique hash prefix to a full hash.
   *
   * Typing 64 hex characters is not a workflow. Two matches come back as two,
   * not as a silent pick, because the two assets are unrelated files.
   */
  resolveHashPrefix(prefix: string): ContentHash[] {
    const rows = this.#s("SELECT hash FROM assets WHERE hash LIKE ? || '%' LIMIT 2").all(
      prefix,
    ) as { hash: ContentHash }[];
    return rows.map((r) => r.hash);
  }

  /**
   * The next free folder id.
   *
   * Taken from the table rather than from `last_insert_rowid()`, as the
   * specification requires: the index is the journal folded in order, so its
   * maximum is the journal's maximum. Ids of deleted folders are reused, which
   * replays correctly because replay is total and ordered — the create, the
   * delete, and the re-create arrive in the order they happened.
   */
  nextFolderId(): number {
    return this.#count("SELECT coalesce(max(id), 0) + 1 AS n FROM folders");
  }

  nextSmartFolderId(): number {
    return this.#count("SELECT coalesce(max(id), 0) + 1 AS n FROM smart_folders");
  }

  nextTagGroupId(): number {
    return this.#count("SELECT coalesce(max(id), 0) + 1 AS n FROM tag_groups");
  }

  /**
   * Full-text rows whose asset no longer exists.
   *
   * `assets_fts` is a virtual table, so it has no foreign keys and nothing
   * cascades for it. A leaked row keeps returning a deleted asset from search.
   */
  orphanSearchRows(): number {
    return this.#count(
      `SELECT count(*) AS n FROM assets_fts f
        WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.rowid = f.rowid)`,
    );
  }

  // --- Folders, tags, and saved queries -------------------------------------
  //
  // The reads a navigation pane needs. They arrive with the commands that show
  // a tree rather than with replay, which never reads anything back.

  folder(id: number): FolderRow | undefined {
    return this.#s("SELECT id, parent_id AS parentId, name FROM folders WHERE id = ?").get(id) as
      | FolderRow
      | undefined;
  }

  /**
   * The whole folder tree, in the order a sidebar lists it.
   *
   * Ordered by `sort_order`, then name, then id — which is a display order and
   * **not** a topological one. A caller that needs parents before children has
   * to arrange that itself; the tree is small enough to walk in memory, which
   * is the point of returning all of it in one statement.
   */
  folders(): FolderRow[] {
    return this.#s(
      "SELECT id, parent_id AS parentId, name FROM folders ORDER BY sort_order, name, id",
    ).all() as FolderRow[];
  }

  /**
   * Resolves `["Design", "Icons"]` to a folder id, one segment at a time.
   *
   * Folder names are unique only among siblings, so a bare name is ambiguous in
   * a deep tree; walking the path is what makes `folder:Design/Icons` name
   * exactly one folder. An empty path resolves to nothing rather than to the
   * root, because there is no root row to return.
   */
  findFolderByPath(path: readonly string[]): number | undefined {
    let parent: number | null = null;
    for (const segment of path) {
      // `IS ?` rather than `= ?`: a top-level folder has a NULL parent, and
      // `= NULL` is never true.
      const row = this.#s("SELECT id FROM folders WHERE name = ? AND parent_id IS ?").get(
        segment,
        parent,
      ) as { id: number } | undefined;
      if (row === undefined) return undefined;
      parent = row.id;
    }
    return parent ?? undefined;
  }

  /**
   * Whether `id` is `ancestor` or lies beneath it.
   *
   * Guards `folder_move`: moving a folder into its own subtree detaches that
   * subtree from the root, leaving it unreachable in the sidebar and
   * undeletable through it.
   */
  folderIsWithin(id: number, ancestor: number): boolean {
    const row = this.#s(
      `WITH RECURSIVE subtree(id) AS (
           SELECT @ancestor
           UNION
           SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
       )
       SELECT id FROM subtree WHERE id = @id`,
    ).get({ ancestor, id }) as { id: number } | undefined;
    return row !== undefined;
  }

  /**
   * How many assets each folder holds **directly**.
   *
   * Direct membership only: a parent does not inherit its children's counts.
   * A caller that wants a subtree total sums it from the tree it already has,
   * rather than paying for a recursive query per folder.
   */
  folderCounts(): Map<number, number> {
    const rows = this.#s(
      "SELECT folder_id AS folderId, count(hash) AS n FROM asset_folders GROUP BY folder_id",
    ).all() as { folderId: number; n: number }[];
    return new Map(rows.map((row) => [row.folderId, row.n]));
  }

  /** Every tag, with its asset count and its group. */
  tags(): TagRow[] {
    return this.#s(
      `SELECT t.name AS name, count(at.hash) AS count, g.name AS "group"
         FROM tags t
         LEFT JOIN asset_tags at ON at.tag_id = t.id
         LEFT JOIN tag_groups g ON g.id = t.group_id
        GROUP BY t.id
        ORDER BY t.name`,
    ).all() as TagRow[];
  }

  tagGroups(): TagGroupRow[] {
    return this.#s(
      "SELECT id, name FROM tag_groups ORDER BY sort_order, name, id",
    ).all() as TagGroupRow[];
  }

  /** `tag_groups.name` is UNIQUE COLLATE NOCASE, so this matches case-insensitively. */
  findTagGroupByName(name: string): TagGroupRow | undefined {
    return this.#s("SELECT id, name FROM tag_groups WHERE name = ?").get(name) as
      | TagGroupRow
      | undefined;
  }

  smartFolders(): SmartFolderRow[] {
    return this.#s(
      `SELECT id, parent_id AS parentId, name, query FROM smart_folders
        ORDER BY sort_order, name, id`,
    ).all() as SmartFolderRow[];
  }

  /**
   * The oldest smart folder called `name`.
   *
   * Smart-folder names are not unique — nothing in the schema makes them so,
   * and two saved queries may legitimately share a name in different parts of
   * the tree. `ORDER BY id` makes the answer the first one created rather than
   * whichever row SQLite happened to reach first.
   */
  findSmartFolderByName(name: string): SmartFolderRow | undefined {
    return this.#s(
      `SELECT id, parent_id AS parentId, name, query FROM smart_folders
        WHERE name = ? ORDER BY id LIMIT 1`,
    ).get(name) as SmartFolderRow | undefined;
  }

  // --- Search ---------------------------------------------------------------

  /**
   * Runs a compiled query and returns one page of results.
   *
   * The statement is assembled here rather than in `@roost/search`, so the
   * projection, the ordering, the keyset predicate, and the limit all stay in
   * one place. The caller contributes a predicate and its values, nothing more.
   *
   * Ordering is `(imported_at DESC, hash)` — the exact order
   * `idx_assets_imported` holds after migration 0003 — so both the sort and the
   * resume are index seeks rather than a scan and a sort.
   */
  search(filter: Filter, page: Page): SearchHit[] {
    const named: { limit: number; cursorTs?: number; cursorHash?: string } = {
      limit: page.limit,
    };
    if (page.after !== undefined) {
      named.cursorTs = page.after.importedAt;
      named.cursorHash = page.after.hash;
    }

    const rows = this.#s(searchSql(filter.sql, page.after !== undefined)).all(
      ...filter.params,
      named,
    ) as (Omit<SearchHit, "isFavorite"> & { isFavorite: number })[];

    return rows.map((row) => ({ ...row, isFavorite: row.isFavorite !== 0 }));
  }

  /** How many assets a compiled query matches. */
  count(filter: Filter): number {
    const row = this.#s(`SELECT count(*) AS n FROM assets a WHERE (${filter.sql})`).get(
      ...filter.params,
    ) as { n: number };
    return row.n;
  }
}

/**
 * Assembles the statement {@link Repo.search} runs, around a compiled filter.
 *
 * **The cursor's timestamp is written twice and named once**, and that is the
 * whole point of naming it. Written as two placeholders, SQLite sees two
 * unrelated parameters, cannot prove the disjunction collapses to a range, and
 * answers by walking the index from the newest row and discarding everything
 * before the cursor — which is `OFFSET` by another name, and was measured in
 * the Rust build at 23x on page 200 of a 50,000-asset library. Given one
 * parameter in both places it recognises the range and seeks, and page 200
 * costs what page 1 costs.
 *
 * The Rust build spelled that shared parameter `?1`. Here it has to be a
 * *named* parameter: `better-sqlite3` treats `?NNN` as named and refuses to
 * bind it positionally, so the numbered form does not survive the port. Mixing
 * is what makes this work — the filter's anonymous `?` are bound positionally,
 * and everything appended is bound by name, which also means the filter's
 * parameter count no longer has to be threaded through.
 *
 * The predicate cannot be a row-value comparison — `(imported_at, hash) < (?, ?)`,
 * which would seek just as well — because the ordering is mixed: descending on
 * `imported_at`, ascending on `hash`. A row value would compare the tie-break
 * the wrong way round and silently skip rows.
 */
export function searchSql(filterSql: string, hasCursor: boolean): string {
  const keyset = hasCursor
    ? " AND (a.imported_at < @cursorTs OR (a.imported_at = @cursorTs AND a.hash > @cursorHash))"
    : "";

  return `SELECT a.hash AS hash, a.orig_name AS origName, a.ext AS ext, a.size AS size,
                 a.width AS width, a.height AS height, a.imported_at AS importedAt,
                 a.rating AS rating, a.is_favorite AS isFavorite
            FROM assets a
           WHERE (${filterSql})${keyset}
           ORDER BY a.imported_at DESC, a.hash
           LIMIT @limit`;
}

/** The cursor that resumes a listing after the last hit on a page. */
export function lastCursor(hits: readonly SearchHit[]): Cursor | undefined {
  const last = hits.at(-1);
  return last === undefined ? undefined : { importedAt: last.importedAt, hash: last.hash };
}
