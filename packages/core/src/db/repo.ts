import type { Database, Statement } from "better-sqlite3";
import type { AddRecord } from "../journal/index.js";
import type { ContentHash, JobKind, JobState } from "../model/index.js";
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
  /** Comments, not assets: one asset can carry many. */
  readonly comments: number;
  /** Assets in the trash. They are still rows, and still hold their bytes. */
  readonly trashed: number;
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
  /**
   * The moment a video's thumbnail is pinned to, or `null` for the default
   * frame (ADR-0024 stage 4).
   *
   * Carried with the target rather than looked up by the derive runner, because
   * the runner is handed a claim and never the asset: a second query per job
   * would be a round trip per thumbnail on a hundred thousand of them.
   */
  readonly posterMs: number | null;
}

/**
 * What a derive pass learned about a file.
 *
 * Every field is optional and `undefined` means "did not learn this", never
 * "clear it": a backend that reports a duration and no dimensions must not
 * erase dimensions probing already found. Derived values are only ever
 * overwritten by a later derive of the same bytes, so there is nothing to
 * clear.
 */
export interface DerivedMetadata {
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly pageCount?: number;
  /** Format-specific properties, from the vocabulary `DATA_MODEL.md` §2.5 fixes. */
  readonly props?: Readonly<Record<string, string>>;
}

/** A job claimed by a runner, with the bytes it is about. */
export interface JobClaim {
  readonly id: number;
  readonly hash: ContentHash;
  readonly attempts: number;
  readonly ext: string;
  readonly storageMode: string;
  readonly refPath: string | null;
  /** The moment a video's thumbnail is pinned to (ADR-0024 stage 4). */
  readonly posterMs: number | null;
}

/** How many jobs are in each state, for a status line. */
export interface JobCount {
  readonly kind: string;
  readonly state: JobState;
  readonly count: number;
}

/** Why jobs are not being done, most common first. */
export interface JobReason {
  readonly reason: string;
  readonly count: number;
}

/** Everything the detail view shows about one asset. */
/**
 * What a selection of several assets shares, and what it does not.
 *
 * The inspector edits a selection, so it has to be able to say "three assets,
 * mixed ratings" — and a tag two of three assets carry is a different thing from
 * one all three carry. Computed here in two statements rather than by reading
 * every asset's detail: a selection is routinely hundreds of rows, and the panel
 * shows a summary of them, not each of them.
 */
export interface SelectionSummary {
  readonly count: number;
  readonly totalBytes: number;
  /** The rating they all carry, or `null` when they disagree or none is rated. */
  readonly rating: number | null;
  readonly ratingMixed: boolean;
  /** Tags every selected asset carries. Removing one removes it from all. */
  readonly sharedTags: readonly string[];
  /** Tags some of them carry. Shown apart, because "remove" means less here. */
  readonly partialTags: readonly string[];
  /** The commonest extensions present, most first. At most five. */
  readonly kinds: readonly string[];
}

export interface AssetDetail {
  readonly hash: ContentHash;
  readonly ext: string;
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  readonly pageCount: number | null;
  readonly origName: string;
  readonly storageMode: string;
  readonly refPath: string | null;
  readonly isPartialHash: boolean;
  readonly createdAt: number | null;
  readonly importedAt: number;
  /** Unix seconds if this asset is in the trash, `null` if it is live. */
  readonly trashedAt: number | null;
  /** The moment a video's thumbnail is pinned to (ADR-0024 stage 4). */
  readonly posterMs: number | null;
  /**
   * The asset that replaced this one, or `null` if this is the current version
   * (ADR-0026).
   *
   * One step forward, so following it walks the chain to the newest.
   */
  readonly supersededBy: ContentHash | null;
  readonly rating: number | null;
  readonly note: string | null;
  readonly isFavorite: boolean;
  readonly tags: string[];
  readonly folders: string[];
  /** Derived, format-specific properties. Empty for most assets. */
  readonly props: Readonly<Record<string, string>>;
}

/**
 * One caption track attached to an asset (ADR-0025).
 *
 * Carries the track's own name and extension because a menu names it, and
 * because the extension is what decides whether serving it needs a conversion
 * or an external tool.
 */
export interface SubtitleRow {
  readonly trackHash: ContentHash;
  readonly lang: string | null;
  readonly label: string | null;
  readonly name: string;
  readonly ext: string;
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

/**
 * One comment, and where in the asset it sits (ADR-0023).
 *
 * `atMs` is milliseconds into the medium, or `null` for a comment about the
 * asset rather than about a moment in it — which is what lets an asset with no
 * timeline carry comments at all.
 */
export interface CommentRow {
  readonly id: number;
  readonly hash: string;
  readonly atMs: number | null;
  readonly body: string;
  readonly createdAt: number;
  /** `null` until the comment is edited. */
  readonly updatedAt: number | null;
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

  /**
   * Marks an asset trashed as of `ts`, the timestamp on its journal line.
   *
   * Nothing else changes: the row, its tags, its rating, its note, its folder
   * memberships, and its thumbnail all stay. Only what sees it changes, and
   * that is one predicate (ADR-0022).
   *
   * A second `trash` overwrites the first with the later time rather than being
   * refused, so replay is order-dependent and idempotent in the way the journal
   * needs — trash, restore, trash again folds to the last one.
   */
  applyTrash(hash: ContentHash, ts: number): void {
    this.#s("UPDATE assets SET trashed_at = ? WHERE hash = ?").run(ts, hash);
  }

  applyRestore(hash: ContentHash): void {
    this.#s("UPDATE assets SET trashed_at = NULL WHERE hash = ?").run(hash);
  }

  /** Whether an asset is in the trash. `undefined` when there is no such asset. */
  trashedAt(hash: ContentHash): number | null | undefined {
    const row = this.#s("SELECT trashed_at AS trashedAt FROM assets WHERE hash = ?").get(hash) as
      | { trashedAt: number | null }
      | undefined;
    return row === undefined ? undefined : row.trashedAt;
  }

  /** How many assets are in the trash. */
  trashedCount(): number {
    return this.#count("SELECT count(*) AS n FROM assets WHERE trashed_at IS NOT NULL");
  }

  /**
   * How many live assets carry each rating, one row per rating in use.
   *
   * One grouped statement rather than five counts: the sidebar draws all of
   * them together, and a query per star would be five statements for a pane
   * that is re-read whenever anything changes.
   *
   * Scoped the way every other view is — no trashed rows, no superseded ones —
   * so the number beside a star is the number of assets that row would show.
   */
  ratingCounts(): { rating: number | null; count: number }[] {
    // `NULL` is in the grouping, not excluded from it: unrated is a row in the
    // sidebar, and one grouped statement answering all six is the reason these
    // rows carry counts at all.
    return this.#s(
      `SELECT rating, count(*) AS count
         FROM assets
        WHERE trashed_at IS NULL AND superseded_by IS NULL
        GROUP BY rating`,
    ).all() as { rating: number | null; count: number }[];
  }

  /**
   * Every trashed asset.
   *
   * For "Empty trash", which turns each one into a `remove`. Ordered by hash
   * rather than by `trashed_at`: the answer is a set the caller journals in one
   * batch, and a total order makes two runs write the same file.
   */
  trashedHashes(): ContentHash[] {
    const rows = this.#s(
      "SELECT hash FROM assets WHERE trashed_at IS NOT NULL ORDER BY hash",
    ).all() as { hash: ContentHash }[];
    return rows.map((row) => row.hash);
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
    this.#refreshFts(hash);
  }

  /**
   * Which frame a video's thumbnail comes from (ADR-0024 stage 4).
   *
   * `null` is the default frame, not the first one: the video backend takes a
   * frame a tenth of the way in, because a first frame tends to be a slate.
   * Nothing here touches `thumbs` — the picture is derived work, and this is
   * the instruction that produces it.
   */
  applyPosterSet(hash: ContentHash, posterMs: number | null): void {
    this.#s("UPDATE assets SET poster_ms = ? WHERE hash = ?").run(posterMs, hash);
  }

  /**
   * Marks one asset as replaced by another, or `null` to make it current again
   * (ADR-0026).
   *
   * Nothing here copies anything: the tags, folders, rating and the rest travel
   * to the replacement through their own operations, so a rebuild reconstructs
   * the carry-over from the journal rather than from a rule living in code.
   */
  applySupersede(hash: ContentHash, to: ContentHash | null): void {
    this.#s("UPDATE assets SET superseded_by = ? WHERE hash = ?").run(to, hash);
  }

  /**
   * Says that one asset captions another (ADR-0025).
   *
   * `ordinal` is not passed in: it is the count of what is already attached, so
   * a menu lists tracks in the order they were attached and a replay produces
   * the same order it recorded. Re-attaching the same pair updates the language
   * and label rather than adding a second row — the primary key is the pair,
   * and saying it twice is one sentence said twice.
   */
  applySubtitleAttach(
    hash: ContentHash,
    track: ContentHash,
    lang: string | undefined,
    label: string | undefined,
  ): void {
    this.#s(
      `INSERT INTO asset_subtitles (hash, track_hash, ordinal, lang, label)
       VALUES (
         ?, ?,
         (SELECT count(*) FROM asset_subtitles WHERE hash = ?),
         ?, ?
       )
       ON CONFLICT (hash, track_hash) DO UPDATE SET lang = excluded.lang, label = excluded.label`,
    ).run(hash, track, hash, lang ?? null, label ?? null);
  }

  /** Un-says it. Both assets stay; only the sentence goes. */
  applySubtitleDetach(hash: ContentHash, track: ContentHash): void {
    this.#s("DELETE FROM asset_subtitles WHERE hash = ? AND track_hash = ?").run(hash, track);
  }

  /** The caption tracks attached to one asset, in the order they were attached. */
  subtitlesFor(hash: ContentHash): SubtitleRow[] {
    return this.#s(
      `SELECT s.track_hash AS trackHash, s.lang, s.label, a.orig_name AS name, a.ext
         FROM asset_subtitles s
         JOIN assets a ON a.hash = s.track_hash
        WHERE s.hash = ?
        ORDER BY s.ordinal`,
    ).all(hash) as SubtitleRow[];
  }

  /**
   * The folder ids one asset belongs to.
   *
   * Ids rather than names, because this answers "put the replacement in the
   * same folders" and `folder_add` names an id. {@link assetDetail} resolves
   * names instead, for a person to read.
   */
  folderIdsFor(hash: ContentHash): number[] {
    const rows = this.#s(
      "SELECT folder_id AS id FROM asset_folders WHERE hash = ? ORDER BY folder_id",
    ).all(hash) as { id: number }[];
    return rows.map((row) => row.id);
  }

  /**
   * Forgets one derived picture, so the next derive makes it rather than
   * finding it already there.
   *
   * The preview size is generated on first use and never revisited
   * (`ensurePreview`), so a thumbnail whose *instruction* changed has to be
   * dropped or it would outlive the frame it was drawn from — a preview that
   * disagrees with its own grid cell is worse than either (ADR-0024).
   */
  dropThumbnail(hash: ContentHash, size: number): void {
    this.#s("DELETE FROM thumbs WHERE hash = ? AND size = ?").run(hash, size);
  }

  /** The moment a thumbnail is pinned to, or `null` for the default frame. */
  posterOf(hash: ContentHash): number | null {
    const row = this.#s("SELECT poster_ms AS posterMs FROM assets WHERE hash = ?").get(hash) as
      | { posterMs: number | null }
      | undefined;
    return row?.posterMs ?? null;
  }

  /**
   * Creates a comment at the id the journal recorded (ADR-0023).
   *
   * `ON CONFLICT` rather than a plain insert, for the reason `folder_create`
   * has one: replaying a journal twice must land on the same database, and a
   * duplicate id is what that looks like from here.
   */
  applyCommentAdd(
    id: number,
    hash: ContentHash,
    atMs: number | null,
    body: string,
    createdAt: number,
  ): void {
    this.#s(
      `INSERT INTO asset_comments (id, hash, at_ms, body, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         hash = excluded.hash, at_ms = excluded.at_ms, body = excluded.body,
         created_at = excluded.created_at, updated_at = NULL`,
    ).run(id, hash, atMs, body, createdAt);
    this.#refreshFts(hash);
  }

  /** Edits a comment in place, so it keeps its identity and its place in a list. */
  applyCommentSet(id: number, atMs: number | null, body: string, updatedAt: number): void {
    this.#s("UPDATE asset_comments SET at_ms = ?, body = ?, updated_at = ? WHERE id = ?").run(
      atMs,
      body,
      updatedAt,
      id,
    );
    const owner = this.#commentOwner(id);
    if (owner !== undefined) this.#refreshFts(owner);
  }

  applyCommentRemove(id: number): void {
    const owner = this.#commentOwner(id);
    this.#s("DELETE FROM asset_comments WHERE id = ?").run(id);
    if (owner !== undefined) this.#refreshFts(owner);
  }

  /**
   * One asset's comments, timed ones first and in timeline order.
   *
   * Untimed comments sort last rather than first: they are about the asset, and
   * a list that opens with them would bury the moment the person came for. `id`
   * breaks the tie so two comments on the same frame keep the order they were
   * written in.
   */
  commentsFor(hash: ContentHash): CommentRow[] {
    return this.#s(
      `SELECT id, hash, at_ms AS atMs, body, created_at AS createdAt, updated_at AS updatedAt
         FROM asset_comments
        WHERE hash = ?
        ORDER BY at_ms IS NULL, at_ms, id`,
    ).all(hash) as CommentRow[];
  }

  /** One comment, or `undefined` — which is how an edit learns the id is stale. */
  comment(id: number): CommentRow | undefined {
    return this.#s(
      `SELECT id, hash, at_ms AS atMs, body, created_at AS createdAt, updated_at AS updatedAt
         FROM asset_comments WHERE id = ?`,
    ).get(id) as CommentRow | undefined;
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
      `SELECT a.rowid AS rowid, a.orig_name AS origName, a.note AS note,
              (SELECT group_concat(t.name, ' ')
                 FROM asset_tags at JOIN tags t ON t.id = at.tag_id
                WHERE at.hash = a.hash) AS tags,
              (SELECT group_concat(c.body, ' ')
                 FROM asset_comments c
                WHERE c.hash = a.hash) AS comments
         FROM assets a WHERE a.hash = ?`,
    ).get(hash) as
      | {
          rowid: number;
          origName: string;
          note: string | null;
          tags: string | null;
          comments: string | null;
        }
      | undefined;

    if (row === undefined) return;

    this.#s("DELETE FROM assets_fts WHERE rowid = ?").run(row.rowid);
    this.#s(
      `INSERT INTO assets_fts (rowid, hash, orig_name, tags, note, comments)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.rowid, hash, row.origName, row.tags ?? "", row.note ?? "", row.comments ?? "");
  }

  /**
   * The asset a comment belongs to, or `undefined` if the comment is gone.
   *
   * Comment operations name the comment, not the asset, but the full-text row
   * is the asset's — so the hash has to be looked up, and for a removal it has
   * to be looked up **before** the delete, when there is still a row to ask.
   */
  #commentOwner(id: number): ContentHash | undefined {
    const row = this.#s("SELECT hash FROM asset_comments WHERE id = ?").get(id) as
      | { hash: ContentHash }
      | undefined;
    return row?.hash;
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
      `SELECT hash, ext, size, width, height, duration_ms AS durationMs,
              page_count AS pageCount, orig_name AS origName,
              storage_mode AS storageMode, ref_path AS refPath,
              is_partial_hash AS isPartialHash, created_at AS createdAt,
              imported_at AS importedAt, trashed_at AS trashedAt,
              rating, note, is_favorite AS isFavorite, poster_ms AS posterMs,
              superseded_by AS supersededBy
         FROM assets WHERE hash = ?`,
    ).get(hash) as
      | (Omit<AssetDetail, "isPartialHash" | "isFavorite" | "tags" | "folders" | "props"> & {
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
      props: this.props(hash),
    };
  }

  /**
   * Aggregates a selection.
   *
   * **The hashes arrive as one JSON parameter**, not as a list of placeholders.
   * `#s` caches a prepared statement per SQL string, so `IN (?, ?, ?)` would mint
   * and cache a new statement for every selection size anyone ever makes — and
   * it would run into SQLite's parameter ceiling on a large one. `json_each`
   * keeps the SQL a single constant string whatever the selection.
   */
  selectionSummary(hashes: readonly ContentHash[]): SelectionSummary {
    const list = JSON.stringify(hashes);

    const totals = this.#s(
      `SELECT count(*) AS count, coalesce(sum(size), 0) AS totalBytes,
              count(rating) AS rated, min(rating) AS lowest, max(rating) AS highest
         FROM assets WHERE hash IN (SELECT value FROM json_each(?))`,
    ).get(list) as {
      count: number;
      totalBytes: number;
      rated: number;
      lowest: number | null;
      highest: number | null;
    };

    const tagged = this.#s(
      `SELECT t.name AS name, count(*) AS carrying
         FROM asset_tags at JOIN tags t ON t.id = at.tag_id
        WHERE at.hash IN (SELECT value FROM json_each(?))
        GROUP BY t.id ORDER BY t.name`,
    ).all(list) as { name: string; carrying: number }[];

    const kinds = this.#s(
      `SELECT ext FROM assets WHERE hash IN (SELECT value FROM json_each(?))
        GROUP BY ext ORDER BY count(*) DESC, ext LIMIT 5`,
    ).all(list) as { ext: string }[];

    // `rated === count`, not `lowest !== null`. `min` and `max` skip NULLs, so
    // two fours and an unrated asset would agree on 4 and read as "they are all
    // four" — which is the case that has to come out mixed. The schema's rating
    // is 1..5 or NULL; there is no zero to confuse this with.
    const allRated = totals.count > 0 && totals.rated === totals.count;
    const agreed = allRated && totals.lowest === totals.highest;

    return {
      count: totals.count,
      totalBytes: totals.totalBytes,
      rating: agreed ? totals.lowest : null,
      // No rating anywhere is agreement, not disagreement: it is what an
      // untouched selection looks like, and the stars should show empty.
      ratingMixed: totals.rated > 0 && !agreed,
      sharedTags: tagged.filter((t) => t.carrying === totals.count).map((t) => t.name),
      partialTags: tagged.filter((t) => t.carrying !== totals.count).map((t) => t.name),
      kinds: kinds.map((k) => k.ext),
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
      comments: this.#count("SELECT count(*) AS n FROM asset_comments"),
      trashed: this.#count("SELECT count(*) AS n FROM assets WHERE trashed_at IS NOT NULL"),
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
      `SELECT hash, ext, storage_mode AS storageMode, ref_path AS refPath, poster_ms AS posterMs
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
              a.ref_path AS refPath, a.poster_ms AS posterMs
         FROM assets a
        WHERE ${probes}
        ORDER BY a.imported_at DESC
        LIMIT ?`,
    ).all(...sizes, limit) as ThumbnailTarget[];
  }

  // --- Derived data and the job queue ---------------------------------------
  //
  // None of this is journalled: it is computed from bytes, so a rebuild drops
  // it and re-running the derive pass restores it (`DATA_MODEL.md` §2.5).

  /**
   * Folds what a derive learned into the asset row and its properties.
   *
   * `coalesce(?, column)` rather than a plain assignment, so a backend that
   * reports one field leaves the others alone. Probing at import already found
   * an image's dimensions; a later pass that only knows a page count must not
   * blank them.
   */
  putDerived(hash: ContentHash, meta: DerivedMetadata): void {
    this.#s(
      `UPDATE assets
          SET width       = coalesce(?, width),
              height      = coalesce(?, height),
              duration_ms = coalesce(?, duration_ms),
              page_count  = coalesce(?, page_count)
        WHERE hash = ?`,
    ).run(
      meta.width ?? null,
      meta.height ?? null,
      meta.durationMs ?? null,
      meta.pageCount ?? null,
      hash,
    );

    if (meta.props === undefined) return;
    const put = this.#s(
      `INSERT INTO asset_props (hash, key, value) VALUES (?, ?, ?)
       ON CONFLICT(hash, key) DO UPDATE SET value = excluded.value`,
    );
    for (const [key, value] of Object.entries(meta.props)) put.run(hash, key, value);
  }

  /** One asset's derived properties. Empty for most assets. */
  props(hash: ContentHash): Record<string, string> {
    const rows = this.#s("SELECT key, value FROM asset_props WHERE hash = ? ORDER BY key").all(
      hash,
    ) as { key: string; value: string }[];
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  /**
   * Queues one job, or moves an existing one back to the front of the queue.
   *
   * `ON CONFLICT` makes this idempotent, which is what lets the importer queue
   * without checking and the UI re-queue on demand. Re-queuing deliberately
   * clears `reason` and lowers `priority` if the new one is more urgent: asking
   * again for something that failed, or that someone is now looking at, has to
   * mean it will be tried again and tried sooner.
   */
  enqueueJob(kind: JobKind, hash: ContentHash, priority: number, now: number): void {
    this.#s(
      `INSERT INTO jobs (kind, hash, priority, state, enqueued_at) VALUES (?, ?, ?, 'ready', ?)
       ON CONFLICT(kind, hash) DO UPDATE SET
           state = 'ready',
           reason = NULL,
           priority = min(jobs.priority, excluded.priority),
           enqueued_at = excluded.enqueued_at`,
    ).run(kind, hash, priority, now);
  }

  /**
   * Queues a derive for every asset missing a thumbnail at any of `sizes`.
   *
   * `DO NOTHING` on conflict, unlike {@link enqueueJob}: this is the backfill
   * sweep, and it must not disturb a job that is already blocked — a format
   * nothing in this build can draw would otherwise be retried on every sweep,
   * forever, and the sweep would never converge. Un-blocking is a deliberate
   * act ({@link requeueBlocked}), taken when a backend appears.
   *
   * Returns how many were added.
   */
  enqueueMissingDerives(
    kind: JobKind,
    sizes: readonly number[],
    priority: number,
    now: number,
    limit: number,
  ): number {
    if (sizes.length === 0) return 0;

    // Built from `sizes.length`, never from its contents, exactly as
    // `assetsMissingThumbnails` does — the values stay bound.
    const probes = sizes
      .map(() => "NOT EXISTS (SELECT 1 FROM thumbs t WHERE t.hash = a.hash AND t.size = ?)")
      .join(" OR ");

    const result = this.#s(
      `INSERT INTO jobs (kind, hash, priority, state, enqueued_at)
       SELECT ?, a.hash, ?, 'ready', ?
         FROM assets a
        WHERE ${probes}
        ORDER BY a.imported_at DESC
        LIMIT ?
       ON CONFLICT(kind, hash) DO NOTHING`,
    ).run(kind, priority, now, ...sizes, limit);
    return result.changes;
  }

  /**
   * Claims up to `limit` jobs, marking them `running`.
   *
   * One `UPDATE ... RETURNING` rather than a select followed by an update: two
   * statements would let a second runner claim the same rows in between, and
   * the CLI can be running a backfill while the app has a library open.
   */
  claimJobs(kind: JobKind, limit: number): JobClaim[] {
    const claimed = this.#s(
      `UPDATE jobs SET state = 'running', attempts = attempts + 1
        WHERE id IN (
              SELECT id FROM jobs
               WHERE kind = ? AND state = 'ready'
               ORDER BY priority, id
               LIMIT ?)
       RETURNING id, hash, attempts, priority`,
    ).all(kind, limit) as {
      id: number;
      hash: ContentHash;
      attempts: number;
      priority: number;
    }[];

    // `RETURNING` reports rows in the order the UPDATE visited them, which is
    // rowid order — the subquery's `ORDER BY` picks *which* rows, not the order
    // they come back in. The runner works the batch in the order it is handed,
    // so an interactive job queued last would otherwise wait behind the
    // backfill it was supposed to overtake.
    claimed.sort((a, b) => a.priority - b.priority || a.id - b.id);

    const claims: JobClaim[] = [];
    for (const job of claimed) {
      const target = this.thumbnailTarget(job.hash);
      // The asset is gone: the row will cascade away with it, and there is
      // nothing to derive from.
      if (target === undefined) {
        this.completeJob(job.id);
        continue;
      }
      claims.push({ id: job.id, attempts: job.attempts, ...target });
    }
    return claims;
  }

  /** Removes a finished job. The derived data it produced is the record of it. */
  completeJob(id: number): void {
    this.#s("DELETE FROM jobs WHERE id = ?").run(id);
  }

  /**
   * Parks a job on something the machine does not have.
   *
   * Distinct from {@link failJob} because the fix is different: a blocked job
   * waits for a backend to be installed or a format to become drawable, and
   * retrying it now would produce the same answer at the same cost. `reason` is
   * shown to the user, so it names the capability rather than the exception.
   */
  blockJob(id: number, reason: string): void {
    this.#s("UPDATE jobs SET state = 'blocked', reason = ? WHERE id = ?").run(reason, id);
  }

  /** Records a job that was tried and did not survive. */
  failJob(id: number, reason: string): void {
    this.#s("UPDATE jobs SET state = 'failed', reason = ? WHERE id = ?").run(reason, id);
  }

  /**
   * Returns claimed jobs to the queue, and reports how many.
   *
   * Run at start-up: `running` describes a process, and after a crash it
   * describes one that no longer exists. A derive is idempotent — same bytes,
   * same answer — so repeating one that was in flight is cheaper than
   * establishing whether it finished.
   */
  resetRunningJobs(): number {
    return this.#s("UPDATE jobs SET state = 'ready' WHERE state = 'running'").run().changes;
  }

  /**
   * Un-blocks jobs, optionally only those parked on one reason.
   *
   * The reason is matched exactly, so installing ffmpeg can release the videos
   * without also retrying every format this build cannot draw.
   */
  requeueBlocked(kind: JobKind, reason?: string): number {
    return reason === undefined
      ? this.#s(
          "UPDATE jobs SET state = 'ready', reason = NULL WHERE kind = ? AND state = 'blocked'",
        ).run(kind).changes
      : this.#s(
          `UPDATE jobs SET state = 'ready', reason = NULL
            WHERE kind = ? AND state = 'blocked' AND reason = ?`,
        ).run(kind, reason).changes;
  }

  /** Retries jobs that failed, up to `maxAttempts` tries each. */
  requeueFailed(kind: JobKind, maxAttempts: number): number {
    return this.#s(
      `UPDATE jobs SET state = 'ready', reason = NULL
        WHERE kind = ? AND state = 'failed' AND attempts < ?`,
    ).run(kind, maxAttempts).changes;
  }

  /** How many jobs sit in each state. */
  jobCounts(): JobCount[] {
    return this.#s(
      "SELECT kind, state, count(*) AS count FROM jobs GROUP BY kind, state ORDER BY kind, state",
    ).all() as JobCount[];
  }

  /** What is holding jobs up, most common first. */
  jobReasons(state: JobState): JobReason[] {
    return this.#s(
      `SELECT coalesce(reason, 'unknown') AS reason, count(*) AS count
         FROM jobs WHERE state = ?
        GROUP BY reason ORDER BY count DESC, reason`,
    ).all(state) as JobReason[];
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

  nextCommentId(): number {
    return this.#count("SELECT coalesce(max(id), 0) + 1 AS n FROM asset_comments");
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
    // Trashed assets are excluded, because `folder:` excludes them too — a
    // count beside a query has to be the count *of* that query, or the sidebar
    // is telling the user something the grid then contradicts (ADR-0022).
    const rows = this.#s(
      `SELECT af.folder_id AS folderId, count(*) AS n
         FROM asset_folders af
         JOIN assets a ON a.hash = af.hash
        WHERE a.trashed_at IS NULL
        GROUP BY af.folder_id`,
    ).all() as { folderId: number; n: number }[];
    return new Map(rows.map((row) => [row.folderId, row.n]));
  }

  /**
   * Every tag, with its live asset count and its group.
   *
   * The count excludes trashed assets, for the reason {@link folderCounts}
   * gives. The joins stay `LEFT` so that a tag every one of whose assets is in
   * the trash is still listed, at zero — the tag has not been deleted, and a
   * row vanishing from the sidebar is a different statement from a count
   * falling to nothing.
   */
  tags(): TagRow[] {
    return this.#s(
      `SELECT t.name AS name, count(a.hash) AS count, g.name AS "group"
         FROM tags t
         LEFT JOIN asset_tags at ON at.tag_id = t.id
         LEFT JOIN assets a ON a.hash = at.hash AND a.trashed_at IS NULL
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
                 a.rating AS rating, a.is_favorite AS isFavorite,
                 a.poster_ms AS posterMs
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
