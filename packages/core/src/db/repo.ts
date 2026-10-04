import type { Database, Statement } from "better-sqlite3";
import type { AddRecord } from "../journal/index.js";
import type {
  AssetId,
  ContentHash,
  JobKind,
  JobState,
  Sort,
  SortKey,
  Take,
} from "../model/index.js";
import { DEFAULT_SORT, JOB_KINDS, rotationFor } from "../model/index.js";
import type { Cursor, CursorKey, Filter, Page, SearchHit } from "./query.js";

/**
 * The tables whose ids the journal mints explicitly (RL-17, RL-35).
 *
 * A closed union rather than a string, because these names are interpolated
 * into SQL: SQLite cannot parameterise a table name, so the only safe way to
 * write one statement for five tables is to make the compiler prove the name
 * came from this list. Invariant 5 binds *user input*, and none of this is.
 *
 * Assets are not among them, and cannot be: an asset's identity is a string
 * minted at random (RL-14), never a number taken from a maximum.
 */
export type IdentifiedTable =
  | "folders"
  | "smart_folders"
  | "tag_groups"
  | "asset_comments"
  | "watched_roots";

/** Where the high-water mark for each of those lives in `meta`. */
const ID_WATERMARK_PREFIX = "max_id.";

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
  /**
   * Assets whose bytes have not been read yet.
   *
   * Version 2 has this state and version 1 could not: an `add` no longer
   * carries a size, so a row exists from the moment it is journalled and every
   * fact about the file arrives afterwards, from the derive pass (RL-22).
   */
  readonly underived: number;
  /** As far as anything has read. A file edited since is a bigger or smaller one. */
  readonly totalBytes: number;
  readonly tags: number;
  readonly tagGroups: number;
  readonly folders: number;
  readonly smartFolders: number;
  readonly watchedRoots: number;
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
 * field would report that correct behaviour as a violation of invariant 1. In
 * version 2 the same is true of every column a derive fills, which is what puts
 * `underived` and `totalBytes` here beside them.
 */
export function withoutDerived(stats: Stats): Stats {
  return { ...stats, thumbnails: 0, underived: 0, totalBytes: 0 };
}

/** What the index knows about an asset, for duplicate reports and listings. */
export interface AssetSummary {
  readonly id: AssetId;
  /** `null` until the file has been read once. */
  readonly size: number | null;
  readonly ext: string;
  /** The display name, without the extension (RL-33). */
  readonly name: string;
}

/**
 * The three fields a person writes on an asset one value at a time.
 *
 * Read together because they are asked about together: an importer deciding
 * whether it has anything to add wants all three in one row rather than three
 * lookups (ADR-0032 §8). Every one is nullable, and `null` means nobody has
 * said anything — which is the whole question.
 */
export interface AssetJudgements {
  readonly rating: number | null;
  readonly note: string | null;
  readonly sourceUrl: string | null;
}

/**
 * What is needed to find and serve an asset's bytes.
 *
 * Two columns, because version 2 needs two: the id names the file and the
 * extension completes the name (RL-9). There is no mode to branch on and no
 * path to read — every asset's bytes are under `files/` (RL-19).
 *
 * `size` comes along because the window asks for it in the same breath, and it
 * is `null` until something has read the file. A stale size is ordinary rather
 * than alarming (RL-20): the bytes may have changed since, and the next derive
 * is what notices.
 */
export interface FileRecord {
  readonly ext: string;
  readonly size: number | null;
}

/** An asset that needs a thumbnail, and where to find its bytes. */
export interface ThumbnailTarget {
  readonly id: AssetId;
  readonly ext: string;
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
 * erase dimensions probing already found.
 *
 * **In version 2 this is the only source of everything it carries.** The
 * journal says nothing about the bytes (RL-23), so a size, a width or a hash is
 * in the index because a derive put it there and for no other reason. Clearing
 * is a separate act with its own method, for the file that changed under an id
 * that did not ({@link Repo.clearDerived}).
 */
export interface DerivedMetadata {
  /** The file's size when it was read, in bytes. */
  readonly size?: number;
  /** Its modification time when it was read, unix seconds. */
  readonly mtime?: number;
  /** BLAKE3 over the whole file (RL-18). Derived, never identity. */
  readonly contentHash?: ContentHash;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly pageCount?: number;
  /** Format-specific properties, from the vocabulary `DATA_MODEL.md` §2.5 fixes. */
  readonly props?: Readonly<Record<string, string>>;
}

/**
 * What an asset's pictures were drawn from (ADR-0051).
 *
 * `size` and `mtime` are the file's when it was drawn, in the units the index
 * stores; `metadata` is everything else the same derive learned.
 */
export interface PictureSource {
  readonly size: number;
  readonly mtime: number;
  readonly posterMs: number | null;
  readonly metadata: DerivedMetadata;
}

/** A `pictures.sources` row as SQLite returns it. */
interface PictureSourceRow {
  readonly size: number;
  readonly mtime: number;
  readonly posterMs: number | null;
  readonly contentHash: ContentHash | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  readonly pageCount: number | null;
  readonly props: string | null;
}

/**
 * A stored `props` object, read back.
 *
 * Written only by {@link Repo.putPictureSource} from a string-to-string
 * record, so anything else is a file this build did not write, and it is read
 * as no properties rather than trusted.
 */
function parseProps(text: string): Readonly<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const props: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") props[key] = value;
    }
    return props;
  } catch {
    return {};
  }
}

/** A job claimed by a runner, with the bytes it is about. */
export interface JobClaim {
  readonly id: number;
  readonly assetId: AssetId;
  readonly attempts: number;
  readonly ext: string;
  /** The moment a video's thumbnail is pinned to (ADR-0024 stage 4). */
  readonly posterMs: number | null;
}

/** A row an `UPDATE ... RETURNING` claimed, before its asset is looked up. */
interface ClaimedRow {
  readonly id: number;
  readonly assetId: AssetId;
  readonly attempts: number;
  readonly priority: number;
}

/**
 * Above this many members a folder's cover is found by walking the newest
 * assets rather than by sorting its own (`Repo.folderCovers`).
 */
const COVER_SORT_MAX = 20_000;

/** How far that walk goes before it gives up and sorts after all. */
const COVER_WALK = 50_000;

/** One picture on a folder's tile, and the parts of its thumbnail's address. */
export interface CoverAsset {
  readonly id: AssetId;
  readonly posterMs: number | null;
  readonly derivedAt: number | null;
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

/**
 * One asset a derive did not produce a picture for, with the file it is about.
 *
 * The name is here because an id is not something a person can look for. What
 * this answers is "which of my files, and what went wrong with them" — a count
 * alone leaves somebody with nothing to open.
 */
export interface StalledJob {
  readonly assetId: AssetId;
  readonly name: string;
  readonly ext: string;
  readonly attempts: number;
  readonly reason: string;
}

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
  /** Folders every selected asset is in. Removing one removes it from all. */
  readonly sharedFolders: readonly FolderMembership[];
  /** Folders some of them are in. Shown apart, exactly as the tags are. */
  readonly partialFolders: readonly FolderMembership[];
  /** The commonest extensions present, most first. At most five. */
  readonly kinds: readonly string[];
  /** What their notes say, together (ADR-0048). */
  readonly note: SharedText;
  /** What their sources say, together (ADR-0048). */
  readonly source: SharedText;
}

/**
 * One free-text field across a selection (ADR-0048).
 *
 * Counts rather than the values: a selection is routinely hundreds of rows, and
 * what the panel needs is whether they agree and whether writing would replace
 * something — never the eleven notes it is not showing.
 */
export interface SharedText {
  /** The value every asset holds, when they agree; `null` when none holds one or they differ. */
  readonly value: string | null;
  /** They do not all hold the same value. Every asset empty is agreement. */
  readonly mixed: boolean;
  /** How many different values are held, not counting empty. */
  readonly distinct: number;
  /** How many of the assets hold a value at all. */
  readonly holding: number;
}

/**
 * One folder an asset is in.
 *
 * **Both halves are needed and neither substitutes for the other.** The id is
 * what `folder_add` and `folder_remove` name, so it is what a control that
 * detaches an asset has to send; the path is what a person reads, and a bare
 * name would not be enough to read with — folder names are unique only among
 * siblings, so a library can hold three folders called `Icons`.
 */
export interface FolderMembership {
  readonly id: number;
  readonly path: string;
}

/** Everything the detail view shows about one asset. */
export interface AssetDetail {
  readonly id: AssetId;
  readonly ext: string;
  /**
   * From here to {@link AssetDetail.derivedAt} everything is **derived from the
   * bytes** (RL-22), and is `null` until they have been read.
   *
   * A window shows what it has and asks for the rest; it never reads a `null`
   * here as a fact about the file. The bytes may also have changed since, which
   * is ordinary (RL-20) rather than damage — the next derive is what notices.
   */
  readonly size: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  readonly pageCount: number | null;
  /** BLAKE3 over the whole file, lowercase hex (RL-18). Never identity. */
  readonly contentHash: ContentHash | null;
  /** When the derived columns above were last taken. */
  readonly derivedAt: number | null;
  /** The display name, without the extension (RL-33). */
  readonly name: string;
  readonly createdAt: number | null;
  readonly importedAt: number;
  /** Unix seconds if this asset is in the trash, `null` if it is live. */
  readonly trashedAt: number | null;
  /** The moment a video's thumbnail is pinned to (ADR-0024 stage 4). */
  readonly posterMs: number | null;
  readonly rating: number | null;
  readonly note: string | null;
  /** Where the file came from, as the user typed it (ADR-0030). */
  readonly sourceUrl: string | null;
  readonly isFavorite: boolean;
  readonly tags: string[];
  readonly folders: readonly FolderMembership[];
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
  readonly trackId: AssetId;
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
 * A directory the library keeps an eye on.
 *
 * `take` is what happens to a file found there — decided once, when the root is
 * registered, because nobody is at the screen when a watched folder catches
 * something.
 */
export interface WatchedRootRow {
  readonly id: number;
  readonly path: string;
  readonly take: Take;
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
  readonly assetId: AssetId;
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

/** Depth past which a parent chain is treated as corrupt rather than deep. */
const MAX_PATH_DEPTH = 64;

/**
 * Turns folder rows into full paths, walking each one up to its root.
 *
 * Written once and seeded twice — one asset's memberships, and a selection's —
 * because the walk is the part that is easy to get subtly different between two
 * copies. `seed` is a literal fragment from this file and never anything a
 * caller supplies; the only bound parameter is the one the seed itself carries
 * (invariant 5). Every seed projects the same five columns, `carrying` last: a
 * single asset seeds it with `1`, which is what "all of them" means when there
 * is one.
 *
 * A chain that does not reach a root within {@link MAX_PATH_DEPTH} is
 * corruption, and the cap is what stops a cycle spinning here. Such a folder
 * drops out of the answer rather than arriving with half a path — a path is
 * what a person reads and what a query names, and half of one addresses a
 * different folder.
 */
function pathsFrom(seed: string): string {
  return `WITH RECURSIVE up(id, parent, path, depth, carrying) AS (
            ${seed}
            UNION ALL
            SELECT u.id, p.parent_id, p.name || '/' || u.path, u.depth + 1, u.carrying
              FROM up u JOIN folders p ON p.id = u.parent
             WHERE u.depth < ${MAX_PATH_DEPTH}
          )
          SELECT id, path, carrying FROM up WHERE parent IS NULL ORDER BY path`;
}

/** A row {@link pathsFrom} answers with, before the count is spent. */
interface FolderRollup extends FolderMembership {
  /** How many of the assets asked about are in this folder. */
  readonly carrying: number;
}

/** Spends the count and keeps the two fields that leave this module. */
function membership(row: FolderRollup): FolderMembership {
  return { id: row.id, path: row.path };
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
   *
   * **Nothing derived is touched here, and that is the version 2 change.** An
   * `add` carries an id, an extension, a name and sometimes a date; the size,
   * the dimensions and the hash are not its business (RL-22, RL-23). Version 1
   * carried them and had to `coalesce` two of them on a re-fold to avoid
   * blanking what a derive had found — a class of bug that cannot occur here,
   * because this statement never names those columns.
   */
  applyAdd(ts: number, add: AddRecord): void {
    this.#s(
      `INSERT INTO assets (id, ext, name, created_at, imported_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
           ext = excluded.ext,
           name = excluded.name,
           created_at = excluded.created_at,
           imported_at = excluded.imported_at`,
    ).run(
      add.id,
      add.ext,
      add.name,
      // `?? null` rather than the bare `undefined`. It happens to bind as NULL
      // today, but `created` is the one fact about a file nothing can recover
      // afterwards, so nothing here rests on an undocumented convenience.
      add.created ?? null,
      ts,
    );
    this.#refreshFts(add.id);
  }

  /**
   * Deletes an asset and everything hanging off it.
   *
   * Foreign keys cascade to `asset_tags` and `asset_folders`, but not to the
   * pictures: they are in another database file (ADR-0051), where a foreign key
   * cannot reach. `assets_fts` is a virtual table with no foreign keys either.
   * Both have to go explicitly, or search keeps returning a deleted asset and
   * the thumbnail database keeps its picture.
   *
   * The file under `files/` is **not** this method's business: `FORMAT.md` §11.1
   * leaves that question open, and ADR-0031 is where this build answers it — in
   * the service that owns the bytes.
   */
  applyRemove(id: AssetId): void {
    // Read the rowid before deleting: it is the key into the FTS table, whose
    // `asset_id` column is UNINDEXED and therefore not searchable.
    const row = this.#s("SELECT rowid FROM assets WHERE id = ?").get(id) as
      | { rowid: number }
      | undefined;

    this.#s("DELETE FROM assets WHERE id = ?").run(id);
    this.#dropPictures(id);

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
  applyTrash(id: AssetId, ts: number): void {
    this.#s("UPDATE assets SET trashed_at = ? WHERE id = ?").run(ts, id);
  }

  applyRestore(id: AssetId): void {
    this.#s("UPDATE assets SET trashed_at = NULL WHERE id = ?").run(id);
  }

  /** Whether an asset is in the trash. `undefined` when there is no such asset. */
  trashedAt(id: AssetId): number | null | undefined {
    const row = this.#s("SELECT trashed_at AS trashedAt FROM assets WHERE id = ?").get(id) as
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
   * Scoped the way every other view is — no trashed rows — so the number beside
   * a star is the number of assets that row would show.
   */
  ratingCounts(): { rating: number | null; count: number }[] {
    // `NULL` is in the grouping, not excluded from it: unrated is a row in the
    // sidebar, and one grouped statement answering all six is the reason these
    // rows carry counts at all.
    return this.#s(
      `SELECT rating, count(*) AS count
         FROM assets
        WHERE trashed_at IS NULL
        GROUP BY rating`,
    ).all() as { rating: number | null; count: number }[];
  }

  /**
   * How many live assets there are of each extension, commonest first.
   *
   * The **Types** facet's vocabulary (ADR-0035). Scoped like `ratingCounts`,
   * and for the same reason: these counts sit beside a query, so they have to
   * count what that query would return.
   *
   * An asset with no extension is one row with an empty name. It is a real
   * answer to *what kinds are in here* and the facet draws it as `No extension`
   * rather than dropping it, which would leave a library whose totals do not
   * add up.
   */
  extCounts(): { ext: string; count: number }[] {
    return this.#s(
      `SELECT ext, count(*) AS count
         FROM assets
        WHERE trashed_at IS NULL
        GROUP BY ext
        ORDER BY count DESC, ext`,
    ).all() as { ext: string; count: number }[];
  }

  /**
   * Every trashed asset.
   *
   * For "Empty trash", which turns each one into a `remove`. Ordered by id
   * rather than by `trashed_at`: the answer is a set the caller journals in one
   * batch, and a total order makes two runs write the same file.
   */
  trashedIds(): AssetId[] {
    const rows = this.#s(
      "SELECT id FROM assets WHERE trashed_at IS NOT NULL ORDER BY id",
    ).all() as {
      id: AssetId;
    }[];
    return rows.map((row) => row.id);
  }

  applyTagAdd(id: AssetId, tags: readonly string[]): void {
    for (const tag of tags) {
      // `tags.name` is UNIQUE COLLATE NOCASE, so this both creates the tag and,
      // on a case variant, leaves the existing spelling alone.
      this.#s("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(tag);
      this.#s(
        `INSERT OR IGNORE INTO asset_tags (asset_id, tag_id)
         SELECT ?, id FROM tags WHERE name = ?`,
      ).run(id, tag);
    }
    this.#refreshFts(id);
  }

  applyTagRemove(id: AssetId, tags: readonly string[]): void {
    for (const tag of tags) {
      this.#s(
        `DELETE FROM asset_tags
          WHERE asset_id = ? AND tag_id IN (SELECT id FROM tags WHERE name = ?)`,
      ).run(id, tag);
    }
    this.#refreshFts(id);
  }

  /**
   * Creates a folder at the id the journal recorded.
   *
   * The id is inserted verbatim rather than autoassigned (RL-35): `folder_add`
   * records refer to it, and letting SQLite choose during replay would make
   * them dangle.
   */
  applyFolderCreate(id: number, parent: number | null, name: string): void {
    this.#s(
      `INSERT INTO folders (id, parent_id, name) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name`,
    ).run(id, parent, name);
    this.noteIdUsed("folders", id);
  }

  applyFolderAdd(asset: AssetId, folder: number): void {
    this.#s("INSERT OR IGNORE INTO asset_folders (asset_id, folder_id) VALUES (?, ?)").run(
      asset,
      folder,
    );
  }

  applyFolderRemove(asset: AssetId, folder: number): void {
    this.#s("DELETE FROM asset_folders WHERE asset_id = ? AND folder_id = ?").run(asset, folder);
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
   * Renames the asset's display name.
   *
   * **The file on disk is not touched**, and cannot need to be: it is named by
   * the id (RL-9), so a rename cannot fail on a locked file, an invalid
   * character or a path that grew too long, and the name it writes carries no
   * extension (RL-33).
   */
  applyAssetRename(id: AssetId, name: string): void {
    this.#s("UPDATE assets SET name = ? WHERE id = ?").run(name, id);
    this.#refreshFts(id);
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
        `INSERT OR IGNORE INTO asset_tags (asset_id, tag_id)
         SELECT asset_id, ? FROM asset_tags WHERE tag_id = ?`,
      ).run(target.id, source.id);
      // Memberships of the source go with it, by cascade.
      this.#s("DELETE FROM tags WHERE id = ?").run(source.id);
    }

    for (const id of affected) this.#refreshFts(id);
  }

  /** `null` clears the rating, which the schema distinguishes from one star. */
  applyRate(id: AssetId, rating: number | null): void {
    this.#s("UPDATE assets SET rating = ? WHERE id = ?").run(rating, id);
  }

  /** `null` clears the note. */
  applyNoteSet(id: AssetId, note: string | null): void {
    this.#s("UPDATE assets SET note = ? WHERE id = ?").run(note, id);
    this.#refreshFts(id);
  }

  /**
   * Where the file came from (ADR-0030).
   *
   * **No `#refreshFts`**, unlike the note directly above it. The user decided
   * on 2026-09-05 that a URL stays out of the full-text index: it is an address
   * rather than prose about the asset, so a search for `show` matching because
   * a URL contained `/show/` would be a match with nothing on screen to explain
   * it. ADR-0030 §4 records what that costs.
   */
  applySourceSet(id: AssetId, url: string | null): void {
    this.#s("UPDATE assets SET source_url = ? WHERE id = ?").run(url, id);
  }

  /**
   * Which frame a video's thumbnail comes from (ADR-0024 stage 4).
   *
   * `null` is the default frame, not the first one: the video backend takes a
   * frame a tenth of the way in, because a first frame tends to be a slate.
   * Nothing here touches `thumbs` — the picture is derived work, and this is
   * the instruction that produces it.
   */
  applyPosterSet(id: AssetId, posterMs: number | null): void {
    this.#s("UPDATE assets SET poster_ms = ? WHERE id = ?").run(posterMs, id);
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
    asset: AssetId,
    track: AssetId,
    lang: string | undefined,
    label: string | undefined,
  ): void {
    this.#s(
      `INSERT INTO asset_subtitles (asset_id, track_id, ordinal, lang, label)
       VALUES (
         ?, ?,
         (SELECT count(*) FROM asset_subtitles WHERE asset_id = ?),
         ?, ?
       )
       ON CONFLICT (asset_id, track_id) DO UPDATE SET lang = excluded.lang, label = excluded.label`,
    ).run(asset, track, asset, lang ?? null, label ?? null);
  }

  /** Un-says it. Both assets stay; only the sentence goes. */
  applySubtitleDetach(asset: AssetId, track: AssetId): void {
    this.#s("DELETE FROM asset_subtitles WHERE asset_id = ? AND track_id = ?").run(asset, track);
  }

  /** The caption tracks attached to one asset, in the order they were attached. */
  subtitlesFor(asset: AssetId): SubtitleRow[] {
    return this.#s(
      `SELECT s.track_id AS trackId, s.lang, s.label, a.name AS name, a.ext
         FROM asset_subtitles s
         JOIN assets a ON a.id = s.track_id
        WHERE s.asset_id = ?
        ORDER BY s.ordinal`,
    ).all(asset) as SubtitleRow[];
  }

  /**
   * The assets one track captions — the other direction from {@link subtitlesFor}.
   *
   * Usually one, and the plural is the point: a track may caption two cuts of
   * the same video, and moving one of them must not take the track away from
   * the other (ADR-0054 §3.6).
   */
  captionedBy(track: AssetId): AssetId[] {
    const rows = this.#s(
      "SELECT asset_id AS id FROM asset_subtitles WHERE track_id = ? ORDER BY asset_id",
    ).all(track) as { id: AssetId }[];
    return rows.map((row) => row.id);
  }

  /**
   * The folder ids one asset belongs to.
   *
   * Ids rather than names, because this answers "file this one where that one
   * is" and `folder_add` names an id. {@link assetDetail} resolves names
   * instead, for a person to read.
   */
  folderIdsFor(asset: AssetId): number[] {
    const rows = this.#s(
      "SELECT folder_id AS id FROM asset_folders WHERE asset_id = ? ORDER BY folder_id",
    ).all(asset) as { id: number }[];
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
  dropThumbnail(id: AssetId, size: number): void {
    this.#s("DELETE FROM pictures.thumbs WHERE asset_id = ? AND size = ?").run(id, size);
  }

  /**
   * Forgets every picture of one asset.
   *
   * Version 2's own case: the bytes behind an id may change (RL-20), and when
   * they do, every thumbnail of that asset is a picture of a file that no
   * longer exists. Under version 1 this could not happen — a different file was
   * a different asset at a different address. What they were drawn from goes
   * with them, so nothing can reuse them afterwards.
   */
  dropThumbnails(id: AssetId): void {
    this.#dropPictures(id);
  }

  #dropPictures(id: AssetId): void {
    this.#s("DELETE FROM pictures.thumbs WHERE asset_id = ?").run(id);
    this.#s("DELETE FROM pictures.sources WHERE asset_id = ?").run(id);
  }

  /** The moment a thumbnail is pinned to, or `null` for the default frame. */
  posterOf(id: AssetId): number | null {
    const row = this.#s("SELECT poster_ms AS posterMs FROM assets WHERE id = ?").get(id) as
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
    asset: AssetId,
    atMs: number | null,
    body: string,
    createdAt: number,
  ): void {
    this.#s(
      `INSERT INTO asset_comments (id, asset_id, at_ms, body, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         asset_id = excluded.asset_id, at_ms = excluded.at_ms, body = excluded.body,
         created_at = excluded.created_at, updated_at = NULL`,
    ).run(id, asset, atMs, body, createdAt);
    this.noteIdUsed("asset_comments", id);
    this.#refreshFts(asset);
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
  commentsFor(asset: AssetId): CommentRow[] {
    return this.#s(
      `SELECT id, asset_id AS assetId, at_ms AS atMs, body,
              created_at AS createdAt, updated_at AS updatedAt
         FROM asset_comments
        WHERE asset_id = ?
        ORDER BY at_ms IS NULL, at_ms, id`,
    ).all(asset) as CommentRow[];
  }

  /** One comment, or `undefined` — which is how an edit learns the id is stale. */
  comment(id: number): CommentRow | undefined {
    return this.#s(
      `SELECT id, asset_id AS assetId, at_ms AS atMs, body,
              created_at AS createdAt, updated_at AS updatedAt
         FROM asset_comments WHERE id = ?`,
    ).get(id) as CommentRow | undefined;
  }

  applyFavoriteSet(id: AssetId, favorite: boolean): void {
    // `better-sqlite3` refuses to bind a boolean — it accepts numbers, strings,
    // bigints, buffers, and null, and throws on anything else. The column is
    // `INTEGER CHECK (is_favorite IN (0, 1))`, so this is the conversion the
    // schema was always asking for.
    this.#s("UPDATE assets SET is_favorite = ? WHERE id = ?").run(favorite ? 1 : 0, id);
  }

  /**
   * Creates a smart folder at the id the journal recorded, for the same reason
   * `folder_create` does: later records refer to it by that id.
   *
   * `query` is stored exactly as it arrived and is never repaired (RL-47): one
   * this build cannot evaluate is another implementation's to run, and
   * "fixing" it would store a query nobody wrote.
   */
  applySmartFolderCreate(id: number, parent: number | null, name: string, query: string): void {
    this.#s(
      `INSERT INTO smart_folders (id, parent_id, name, query) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
           parent_id = excluded.parent_id,
           name = excluded.name,
           query = excluded.query`,
    ).run(id, parent, name, query);
    this.noteIdUsed("smart_folders", id);
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
    this.noteIdUsed("tag_groups", id);
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

  /**
   * Registers a watched directory at the id the journal recorded.
   *
   * **The path is not a key; the id is.** Two `watch_add` records naming one
   * directory are two roots and replay keeps both, because the journal said it
   * twice and replay is not the layer that decides that was a mistake.
   */
  applyWatchAdd(id: number, path: string, take: Take): void {
    this.#s(
      `INSERT INTO watched_roots (id, path, take) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET path = excluded.path, take = excluded.take`,
    ).run(id, path, take);
    this.noteIdUsed("watched_roots", id);
  }

  applyWatchRemove(id: number): void {
    this.#s("DELETE FROM watched_roots WHERE id = ?").run(id);
  }

  /** Every watched root, oldest first. */
  watchedRoots(): WatchedRootRow[] {
    return this.#s(
      "SELECT id, path, take FROM watched_roots ORDER BY id",
    ).all() as WatchedRootRow[];
  }

  nextWatchedRootId(): number {
    return this.#nextId("watched_roots");
  }

  // --- Internals ------------------------------------------------------------

  #assetsWithTag(tagId: number): AssetId[] {
    const rows = this.#s("SELECT asset_id AS id FROM asset_tags WHERE tag_id = ?").all(tagId) as {
      id: AssetId;
    }[];
    return rows.map((r) => r.id);
  }

  /**
   * Rewrites an asset's full-text row from its current name and tags.
   *
   * Recomputing rather than patching keeps the search index derivable from the
   * same state as everything else, so a rebuild cannot produce different search
   * results from an incremental build.
   *
   * Keyed by **rowid**, deliberately. `assets_fts.asset_id` is an `UNINDEXED`
   * column, so `DELETE ... WHERE asset_id = ?` forces a full scan of the FTS
   * table once per imported asset — quadratic, and measured in the Rust build
   * as a 4x throughput collapse between 20k and 100k assets. Aligning the FTS
   * rowid with `assets.rowid` turns both the delete and the insert into rowid
   * lookups.
   */
  #refreshFts(id: AssetId): void {
    const row = this.#s(
      `SELECT a.rowid AS rowid, a.name AS name, a.note AS note,
              (SELECT group_concat(t.name, ' ')
                 FROM asset_tags at JOIN tags t ON t.id = at.tag_id
                WHERE at.asset_id = a.id) AS tags,
              (SELECT group_concat(c.body, ' ')
                 FROM asset_comments c
                WHERE c.asset_id = a.id) AS comments
         FROM assets a WHERE a.id = ?`,
    ).get(id) as
      | {
          rowid: number;
          name: string;
          note: string | null;
          tags: string | null;
          comments: string | null;
        }
      | undefined;

    if (row === undefined) return;

    this.#s("DELETE FROM assets_fts WHERE rowid = ?").run(row.rowid);
    this.#s(
      `INSERT INTO assets_fts (rowid, asset_id, name, tags, note, comments)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.rowid, id, row.name, row.tags ?? "", row.note ?? "", row.comments ?? "");
  }

  /**
   * The asset a comment belongs to, or `undefined` if the comment is gone.
   *
   * Comment operations name the comment, not the asset, but the full-text row
   * is the asset's — so the id has to be looked up, and for a removal it has to
   * be looked up **before** the delete, when there is still a row to ask.
   */
  #commentOwner(id: number): AssetId | undefined {
    const row = this.#s("SELECT asset_id AS assetId FROM asset_comments WHERE id = ?").get(id) as
      | { assetId: AssetId }
      | undefined;
    return row?.assetId;
  }

  // --- Reads ----------------------------------------------------------------

  /** Where an asset's bytes are, for serving one file. */
  findFile(id: AssetId): FileRecord | undefined {
    return this.#s("SELECT ext, size FROM assets WHERE id = ?").get(id) as FileRecord | undefined;
  }

  findAsset(id: AssetId): AssetSummary | undefined {
    return this.#s("SELECT id, size, ext, name FROM assets WHERE id = ?").get(id) as
      | AssetSummary
      | undefined;
  }

  /**
   * The ids of every asset whose file hashed to this, oldest first.
   *
   * **Not identity** (RL-18), and the plural is the point: two assets may hold
   * the same bytes, and both are real assets with their own ids, names and
   * tags. This answers *"is this file already in here?"* for an import report
   * (ADR-0037) and for Eagle's fill-what-is-empty rule, and decides nothing on
   * its own.
   *
   * A hash is derived, so an asset nothing has read yet is in no answer here.
   */
  assetsWithHash(hash: ContentHash): AssetId[] {
    const rows = this.#s(
      "SELECT id FROM assets WHERE content_hash = ? ORDER BY imported_at, id",
    ).all(hash) as { id: AssetId }[];
    return rows.map((row) => row.id);
  }

  /**
   * What a person has already written on an asset, or `undefined` for no row.
   *
   * Three columns rather than {@link assetDetail}'s twenty and its three
   * further queries: the Eagle importer asks this once per item that carries a
   * rating, a note or a URL, and it must not cost a detail each.
   */
  judgements(id: AssetId): AssetJudgements | undefined {
    return this.#s("SELECT rating, note, source_url AS sourceUrl FROM assets WHERE id = ?").get(
      id,
    ) as AssetJudgements | undefined;
  }

  /** One asset with its tags and folder names resolved. */
  assetDetail(id: AssetId): AssetDetail | undefined {
    const base = this.#s(
      `SELECT id, ext, size, width, height, duration_ms AS durationMs,
              page_count AS pageCount, content_hash AS contentHash,
              derived_at AS derivedAt, name, created_at AS createdAt,
              imported_at AS importedAt, trashed_at AS trashedAt,
              rating, note, source_url AS sourceUrl,
              is_favorite AS isFavorite, poster_ms AS posterMs
         FROM assets WHERE id = ?`,
    ).get(id) as
      | (Omit<AssetDetail, "isFavorite" | "tags" | "folders" | "props"> & {
          isFavorite: number;
        })
      | undefined;

    if (base === undefined) return undefined;

    const tags = this.#s(
      `SELECT t.name AS name FROM asset_tags at JOIN tags t ON t.id = at.tag_id
        WHERE at.asset_id = ? ORDER BY t.name`,
    ).all(id) as { name: string }[];

    const folders = this.#s(
      pathsFrom(
        `SELECT f.id, f.parent_id, f.name, 0, 1
           FROM asset_folders af JOIN folders f ON f.id = af.folder_id
          WHERE af.asset_id = ?`,
      ),
    ).all(id) as FolderRollup[];

    return {
      ...base,
      isFavorite: base.isFavorite !== 0,
      tags: tags.map((t) => t.name),
      folders: folders.map(membership),
      props: this.props(id),
    };
  }

  /**
   * Aggregates a selection.
   *
   * **The ids arrive as one JSON parameter**, not as a list of placeholders.
   * `#s` caches a prepared statement per SQL string, so `IN (?, ?, ?)` would mint
   * and cache a new statement for every selection size anyone ever makes — and
   * it would run into SQLite's parameter ceiling on a large one. `json_each`
   * keeps the SQL a single constant string whatever the selection.
   */
  selectionSummary(ids: readonly AssetId[]): SelectionSummary {
    const list = JSON.stringify(ids);

    const totals = this.#s(
      `SELECT count(*) AS count, coalesce(sum(size), 0) AS totalBytes,
              count(rating) AS rated, min(rating) AS lowest, max(rating) AS highest,
              count(note) AS notes, count(DISTINCT note) AS noteValues, min(note) AS note,
              count(source_url) AS sources, count(DISTINCT source_url) AS sourceValues,
              min(source_url) AS source
         FROM assets WHERE id IN (SELECT value FROM json_each(?))`,
    ).get(list) as {
      count: number;
      totalBytes: number;
      rated: number;
      lowest: number | null;
      highest: number | null;
      notes: number;
      noteValues: number;
      note: string | null;
      sources: number;
      sourceValues: number;
      source: string | null;
    };

    const tagged = this.#s(
      `SELECT t.name AS name, count(*) AS carrying
         FROM asset_tags at JOIN tags t ON t.id = at.tag_id
        WHERE at.asset_id IN (SELECT value FROM json_each(?))
        GROUP BY t.id ORDER BY t.name`,
    ).all(list) as { name: string; carrying: number }[];

    // Grouped before the walk, not after: the count belongs to the folder the
    // assets are actually in, and a parent on the way to the root is not a
    // folder anything was added to (`folder:` matches the subtree; membership
    // does not).
    const inFolders = this.#s(
      pathsFrom(
        `SELECT f.id, f.parent_id, f.name, 0, count(*)
           FROM asset_folders af JOIN folders f ON f.id = af.folder_id
          WHERE af.asset_id IN (SELECT value FROM json_each(?))
          GROUP BY f.id`,
      ),
    ).all(list) as FolderRollup[];

    const kinds = this.#s(
      `SELECT ext FROM assets WHERE id IN (SELECT value FROM json_each(?))
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
      sharedFolders: inFolders.filter((f) => f.carrying === totals.count).map(membership),
      partialFolders: inFolders.filter((f) => f.carrying !== totals.count).map(membership),
      kinds: kinds.map((k) => k.ext),
      note: sharedText(totals.count, totals.notes, totals.noteValues, totals.note),
      source: sharedText(totals.count, totals.sources, totals.sourceValues, totals.source),
    };
  }

  stats(): Stats {
    const totals = this.#s(
      `SELECT count(*) AS assets,
              coalesce(sum(derived_at IS NULL), 0) AS underived,
              coalesce(sum(size), 0) AS totalBytes
         FROM assets`,
    ).get() as Pick<Stats, "assets" | "underived" | "totalBytes">;

    return {
      ...totals,
      tags: this.#count("SELECT count(*) AS n FROM tags"),
      tagGroups: this.#count("SELECT count(*) AS n FROM tag_groups"),
      folders: this.#count("SELECT count(*) AS n FROM folders"),
      smartFolders: this.#count("SELECT count(*) AS n FROM smart_folders"),
      watchedRoots: this.#count("SELECT count(*) AS n FROM watched_roots"),
      rated: this.#count("SELECT count(*) AS n FROM assets WHERE rating IS NOT NULL"),
      favorites: this.#count("SELECT count(*) AS n FROM assets WHERE is_favorite = 1"),
      notes: this.#count("SELECT count(*) AS n FROM assets WHERE note IS NOT NULL"),
      comments: this.#count("SELECT count(*) AS n FROM asset_comments"),
      trashed: this.#count("SELECT count(*) AS n FROM assets WHERE trashed_at IS NOT NULL"),
      thumbnails: this.#count("SELECT count(*) AS n FROM pictures.thumbs"),
    };
  }

  #count(sql: string): number {
    return (this.#s(sql).get() as { n: number }).n;
  }

  /**
   * Stores or replaces one thumbnail BLOB.
   *
   * Thumbnails are derived data and therefore never journalled. They live in
   * the thumbnail database rather than the index (ADR-0051), so a rebuild
   * keeps them, and {@link Repo.pictureSource} decides whether they still
   * describe the file.
   */
  putThumbnail(id: AssetId, size: number, width: number, height: number, data: Buffer): void {
    this.#s(
      `INSERT INTO pictures.thumbs (asset_id, size, width, height, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(asset_id, size) DO UPDATE SET
           width = excluded.width, height = excluded.height, data = excluded.data`,
    ).run(id, size, width, height, data);
  }

  /** One thumbnail's bytes, or `undefined` if it has not been generated. */
  thumbnail(id: AssetId, size: number): Buffer | undefined {
    const row = this.#s("SELECT data FROM pictures.thumbs WHERE asset_id = ? AND size = ?").get(
      id,
      size,
    ) as { data: Buffer } | undefined;
    return row?.data;
  }

  /** Whether one asset has a thumbnail at every one of `sizes`. */
  hasThumbnails(id: AssetId, sizes: readonly number[]): boolean {
    const probe = this.#s("SELECT 1 FROM pictures.thumbs WHERE asset_id = ? AND size = ?");
    return sizes.every((size) => probe.get(id, size) !== undefined);
  }

  /**
   * Records what an asset's pictures were drawn from (ADR-0051 §4).
   *
   * Written with the thumbnails, from the same derive. `size` and `mtime` are
   * required: without them a later pass could not tell whether the file is
   * still the one that was drawn, and a source it cannot check is one it must
   * not reuse.
   */
  putPictureSource(id: AssetId, source: PictureSource): void {
    this.#s(
      `INSERT INTO pictures.sources (asset_id, file_size, file_mtime, poster_ms, content_hash,
                                     width, height, duration_ms, page_count, props)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(asset_id) DO UPDATE SET
           file_size = excluded.file_size, file_mtime = excluded.file_mtime,
           poster_ms = excluded.poster_ms, content_hash = excluded.content_hash,
           width = excluded.width, height = excluded.height,
           duration_ms = excluded.duration_ms, page_count = excluded.page_count,
           props = excluded.props`,
    ).run(
      id,
      source.size,
      source.mtime,
      source.posterMs,
      source.metadata.contentHash ?? null,
      source.metadata.width ?? null,
      source.metadata.height ?? null,
      source.metadata.durationMs ?? null,
      source.metadata.pageCount ?? null,
      source.metadata.props === undefined ? null : JSON.stringify(source.metadata.props),
    );
  }

  /**
   * What an asset's pictures were drawn from, or `undefined` if nothing
   * recorded it.
   *
   * The derive pass compares it with the file and the asset. Where all three
   * of size, modification time and pinned frame agree, the pictures are kept and
   * the metadata here is written back into the index, which is what makes a
   * rebuild cost a `stat` per asset rather than a decode and a hash.
   */
  pictureSource(id: AssetId): PictureSource | undefined {
    const row = this.#s(
      `SELECT file_size AS size, file_mtime AS mtime, poster_ms AS posterMs,
              content_hash AS contentHash, width, height, duration_ms AS durationMs,
              page_count AS pageCount, props
         FROM pictures.sources WHERE asset_id = ?`,
    ).get(id) as PictureSourceRow | undefined;
    if (row === undefined) return undefined;
    const metadata: DerivedMetadata = {
      size: row.size,
      mtime: row.mtime,
      ...(row.contentHash === null ? {} : { contentHash: row.contentHash }),
      ...(row.width === null ? {} : { width: row.width }),
      ...(row.height === null ? {} : { height: row.height }),
      ...(row.durationMs === null ? {} : { durationMs: row.durationMs }),
      ...(row.pageCount === null ? {} : { pageCount: row.pageCount }),
      ...(row.props === null ? {} : { props: parseProps(row.props) }),
    };
    return { size: row.size, mtime: row.mtime, posterMs: row.posterMs, metadata };
  }

  /**
   * Says that the pictures now show a different frame (ADR-0024 stage 4).
   *
   * For a redraw that changed the frame and nothing else: the file is the one
   * that was measured, so the rest of the source stands.
   */
  setPictureSourcePoster(id: AssetId, posterMs: number | null): void {
    this.#s("UPDATE pictures.sources SET poster_ms = ? WHERE asset_id = ?").run(posterMs, id);
  }

  /**
   * Deletes every picture whose asset the index does not hold, and says how
   * many rows went (ADR-0051 §6).
   *
   * `ON DELETE CASCADE` cannot cross into another database file, so this is
   * what does its job. It runs after a rebuild and after a fold, when the
   * journal may no longer have an asset the pictures do, and from `doctor`.
   * `NOT IN` over the primary key is a single anti-join, not a probe per row.
   */
  prunePictures(): number {
    const thumbs = this.#s(
      "DELETE FROM pictures.thumbs WHERE asset_id NOT IN (SELECT id FROM main.assets)",
    ).run().changes;
    const sources = this.#s(
      "DELETE FROM pictures.sources WHERE asset_id NOT IN (SELECT id FROM main.assets)",
    ).run().changes;
    return thumbs + sources;
  }

  /** Where one asset's bytes are, for generating a thumbnail on demand. */
  thumbnailTarget(id: AssetId): ThumbnailTarget | undefined {
    return this.#s("SELECT id, ext, poster_ms AS posterMs FROM assets WHERE id = ?").get(id) as
      | ThumbnailTarget
      | undefined;
  }

  /**
   * Assets missing a thumbnail at **any** of `sizes`.
   *
   * Not keyed on one size: the grid size is generated eagerly and the preview
   * size on first use, so an asset can hold one and lack the other, and a
   * single-size probe would report a backfill as already done.
   *
   * `NOT EXISTS` per size rather than a join or `IN`: `thumbs` is keyed on
   * `(asset_id, size)`, so each probe is a primary-key lookup instead of a set
   * that has to be materialised first.
   */
  assetsMissingThumbnails(sizes: readonly number[], limit: number): ThumbnailTarget[] {
    if (sizes.length === 0) return [];

    // Built from `sizes.length`, never from its contents — the values stay
    // bound. Every caller passes a compile-time constant, not user input.
    const probes = sizes
      .map(
        () => "NOT EXISTS (SELECT 1 FROM pictures.thumbs t WHERE t.asset_id = a.id AND t.size = ?)",
      )
      .join(" OR ");

    return this.#s(
      `SELECT a.id AS id, a.ext AS ext, a.poster_ms AS posterMs
         FROM assets a
        WHERE ${probes}
        ORDER BY a.imported_at DESC
        LIMIT ?`,
    ).all(...sizes, limit) as ThumbnailTarget[];
  }

  // --- Derived data and the job queue ---------------------------------------
  //
  // None of this is journalled: it is computed from bytes, so a rebuild drops
  // it and re-running the derive pass restores it (RL-22, RL-23).

  /**
   * Folds what a derive learned into the asset row and its properties.
   *
   * `coalesce(?, column)` rather than a plain assignment, so a backend that
   * reports one field leaves the others alone: a pass that only knows a page
   * count must not blank dimensions something else found.
   *
   * `derived_at` is written whenever anything is, because it is what
   * {@link Repo.stats} counts and what a sweep compares against. Together with
   * `size` and `mtime` it is how a changed file is noticed without reading it.
   */
  putDerived(id: AssetId, meta: DerivedMetadata, now: number): void {
    this.#s(
      `UPDATE assets
          SET size         = coalesce(?, size),
              mtime        = coalesce(?, mtime),
              content_hash = coalesce(?, content_hash),
              width        = coalesce(?, width),
              height       = coalesce(?, height),
              duration_ms  = coalesce(?, duration_ms),
              page_count   = coalesce(?, page_count),
              derived_at   = ?
        WHERE id = ?`,
    ).run(
      meta.size ?? null,
      meta.mtime ?? null,
      meta.contentHash ?? null,
      meta.width ?? null,
      meta.height ?? null,
      meta.durationMs ?? null,
      meta.pageCount ?? null,
      now,
      id,
    );

    if (meta.props === undefined) return;
    const put = this.#s(
      `INSERT INTO asset_props (asset_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(asset_id, key) DO UPDATE SET value = excluded.value`,
    );
    for (const [key, value] of Object.entries(meta.props)) put.run(id, key, value);
  }

  /**
   * Forgets everything derived about one asset, so the next pass reads the file
   * rather than trusting what is there.
   *
   * Version 2's own method, for the case version 1 could not have: the bytes
   * changed under an id that did not (RL-20). Clearing rather than coalescing
   * is the whole point — a video saved as a still would otherwise keep its
   * duration for ever.
   */
  clearDerived(id: AssetId): void {
    this.#s(
      `UPDATE assets
          SET size = NULL, mtime = NULL, content_hash = NULL, width = NULL,
              height = NULL, duration_ms = NULL, page_count = NULL, derived_at = NULL
        WHERE id = ?`,
    ).run(id);
    this.#s("DELETE FROM asset_props WHERE asset_id = ?").run(id);
  }

  /**
   * Records the extension an asset's file actually has.
   *
   * RL-9b makes the extension a fact about the file rather than about the
   * asset, so this writes the `ext` column **without a journal line** — which
   * looks like a breach of invariant 9 and is not: a rebuild re-reads it from
   * `files/`, which is where it came from. The journalled `ext` in `add` is a
   * hint for finding the file without listing a directory, and
   * `ops/REGISTRY.md` says so.
   */
  noteExt(id: AssetId, ext: string): void {
    this.#s("UPDATE assets SET ext = ? WHERE id = ?").run(ext, id);
  }

  /**
   * What the index last saw of an asset's file, for deciding whether to read it
   * again.
   *
   * `undefined` for no such asset; a row of `null`s for one nothing has read.
   */
  fileState(id: AssetId): { size: number | null; mtime: number | null } | undefined {
    return this.#s("SELECT size, mtime FROM assets WHERE id = ?").get(id) as
      | { size: number | null; mtime: number | null }
      | undefined;
  }

  /** One asset's derived properties. Empty for most assets. */
  props(id: AssetId): Record<string, string> {
    const rows = this.#s("SELECT key, value FROM asset_props WHERE asset_id = ? ORDER BY key").all(
      id,
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
  enqueueJob(kind: JobKind, asset: AssetId, priority: number, now: number): void {
    this.#s(
      `INSERT INTO jobs (kind, asset_id, priority, state, enqueued_at)
       VALUES (?, ?, ?, 'ready', ?)
       ON CONFLICT(kind, asset_id) DO UPDATE SET
           state = 'ready',
           reason = NULL,
           priority = min(jobs.priority, excluded.priority),
           enqueued_at = excluded.enqueued_at`,
    ).run(kind, asset, priority, now);
  }

  /**
   * Queues a derive for every asset missing a thumbnail at any of `sizes`.
   *
   * `DO NOTHING` on conflict, unlike {@link Repo.enqueueJob}: this is the
   * backfill sweep, and it must not disturb a job that is already blocked — a
   * format nothing in this build can draw would otherwise be retried on every
   * sweep, forever, and the sweep would never converge. Un-blocking is a
   * deliberate act ({@link Repo.requeueBlocked}), taken when a backend appears.
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
      .map(
        () => "NOT EXISTS (SELECT 1 FROM pictures.thumbs t WHERE t.asset_id = a.id AND t.size = ?)",
      )
      .join(" OR ");

    // `derived_at IS NULL` as well as a missing picture: since the pictures
    // survive a rebuild (ADR-0051 §5), an asset can hold its thumbnail and have
    // no derived columns at all, and a sweep that asked only about pictures
    // would leave it unmeasured for ever.
    const result = this.#s(
      `INSERT INTO jobs (kind, asset_id, priority, state, enqueued_at)
       SELECT ?, a.id, ?, 'ready', ?
         FROM assets a
        WHERE a.derived_at IS NULL OR ${probes}
        ORDER BY a.imported_at DESC
        LIMIT ?
       ON CONFLICT(kind, asset_id) DO NOTHING`,
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
    // `+kind` keeps SQLite off the `UNIQUE (kind, asset_id)` index. With it,
    // the planner seeks on the kind and then sorts every ready row to find the
    // first: 70 ms a claim at a million queued, against 0.002 ms walking
    // `idx_jobs_ready` in order (`BENCHMARKS.md`). There is one kind, so the
    // filter rejects nothing it reads.
    const claimed = this.#s(
      `UPDATE jobs SET state = 'running', attempts = attempts + 1
        WHERE id IN (
              SELECT id FROM jobs
               WHERE +kind = ? AND state = 'ready'
               ORDER BY priority, id
               LIMIT ?)
       RETURNING id, asset_id AS assetId, attempts, priority`,
    ).all(kind, limit) as ClaimedRow[];

    // `RETURNING` reports rows in the order the UPDATE visited them, which is
    // rowid order — the subquery's `ORDER BY` picks *which* rows, not the order
    // they come back in. The runner works the batch in the order it is handed,
    // so an interactive job queued last would otherwise wait behind the
    // backfill it was supposed to overtake.
    claimed.sort((a, b) => a.priority - b.priority || a.id - b.id);

    const claims: JobClaim[] = [];
    for (const job of claimed) {
      const claim = this.#claimOf(job);
      if (claim !== undefined) claims.push(claim);
    }
    return claims;
  }

  /**
   * Claims the most urgent ready job, or returns `undefined` when there is none.
   *
   * `atMost` bounds the priority: the runner asks for interactive work first,
   * then for what is on screen, then for anything (`jobs.ts`), and only the
   * first of those three is a priority the queue can answer by itself.
   *
   * One job rather than a batch, because a batch is a promise about the next
   * several seconds and the screen can change in less than that. Unlike
   * {@link Repo.claimJobs}, a job whose asset has gone does not end the answer:
   * it is dropped and the next one is claimed, so `undefined` always means the
   * queue is empty.
   */
  claimJob(kind: JobKind, atMost = Number.MAX_SAFE_INTEGER): JobClaim | undefined {
    const statement = this.#s(
      `UPDATE jobs SET state = 'running', attempts = attempts + 1
        WHERE id = (
              SELECT id FROM jobs
               WHERE +kind = ? AND state = 'ready' AND priority <= ?
               ORDER BY priority, id
               LIMIT 1)
       RETURNING id, asset_id AS assetId, attempts, priority`,
    );
    for (;;) {
      const job = statement.get(kind, atMost) as ClaimedRow | undefined;
      if (job === undefined) return undefined;
      const claim = this.#claimOf(job);
      if (claim !== undefined) return claim;
    }
  }

  /**
   * Claims the job for one asset, if it has one waiting.
   *
   * `undefined` when it has none — already derived, parked, failed, or being
   * worked by another runner. A point update on `UNIQUE (kind, asset_id)`.
   */
  claimJobFor(kind: JobKind, asset: AssetId): JobClaim | undefined {
    const job = this.#s(
      `UPDATE jobs SET state = 'running', attempts = attempts + 1
        WHERE kind = ? AND asset_id = ? AND state = 'ready'
       RETURNING id, asset_id AS assetId, attempts, priority`,
    ).get(kind, asset) as ClaimedRow | undefined;
    return job === undefined ? undefined : this.#claimOf(job);
  }

  /** What a runner needs to find the file, or `undefined` if the asset is gone. */
  #claimOf(job: ClaimedRow): JobClaim | undefined {
    const target = this.thumbnailTarget(job.assetId);
    // The asset is gone: the row will cascade away with it, and there is
    // nothing to derive from.
    if (target === undefined) {
      this.completeJob(job.id);
      return undefined;
    }
    return {
      id: job.id,
      attempts: job.attempts,
      assetId: target.id,
      ext: target.ext,
      posterMs: target.posterMs,
    };
  }

  /** Removes a finished job. The derived data it produced is the record of it. */
  completeJob(id: number): void {
    this.#s("DELETE FROM jobs WHERE id = ?").run(id);
  }

  /**
   * Parks a job on something the machine does not have.
   *
   * Distinct from {@link Repo.failJob} because the fix is different: a blocked
   * job waits for a backend to be installed or a format to become drawable, and
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
   * describes one that no longer exists. Repeating a derive is cheap and
   * correct — for bytes that have not changed it lands on the same answer, and
   * for bytes that have it lands on the right one.
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

  /**
   * Releases jobs parked on `reason` whose asset carries one of `exts`.
   *
   * For the one release a reason alone cannot scope: work parked as
   * `unsupported:unknown` by a build that could not name a format this one
   * can. The extension is the only thing the index holds that says which of
   * them are worth reading again, and the job's own `(kind, asset_id)` key is
   * what each candidate is found by.
   */
  requeueBlockedWithExt(kind: JobKind, reason: string, exts: readonly string[]): number {
    if (exts.length === 0) return 0;
    return this.#s(
      `UPDATE jobs SET state = 'ready', reason = NULL
        WHERE kind = ? AND state = 'blocked' AND reason = ?
          AND asset_id IN (SELECT id FROM assets
                            WHERE lower(ext) IN (SELECT value FROM json_each(?)))`,
    ).run(kind, reason, JSON.stringify(exts)).changes;
  }

  /**
   * Up to `limit` assets to draw on each folder's tile, keyed by folder
   * (ADR-0043 §7, built 2026-09-25).
   *
   * **The folder's own contents first, then its subfolders'**, newest imported
   * first within each — the user's choice, so a folder that holds only folders
   * still shows what is in it. Only what can be drawn: live, and with a thumbnail
   * at `size`, because a cover of placeholders says nothing a glyph does not.
   * The bytes still travel over `roost://thumb` (invariant 12); this names them.
   */
  folderCovers(folders: readonly number[], size: number, limit: number): Map<number, CoverAsset[]> {
    const covers = new Map<number, CoverAsset[]>();
    for (const folder of folders) {
      const found = this.#newestIn(folder, size, limit);
      if (found.length < limit) {
        const seen = new Set(found.map((asset) => asset.id));
        for (const below of this.#foldersBelow(folder)) {
          for (const asset of this.#newestIn(below, size, limit - found.length)) {
            if (seen.has(asset.id)) continue;
            seen.add(asset.id);
            found.push(asset);
          }
          if (found.length >= limit) break;
        }
      }
      covers.set(folder, found);
    }
    return covers;
  }

  /**
   * The newest drawable assets filed directly in one folder.
   *
   * **Two plans, chosen by the folder's size**, because neither is right for
   * both ends (measured at 1,000,000 assets, `BENCHMARKS.md`). Sorting a
   * folder's members costs what the folder holds: 0.04 ms for twenty, 4 ms for
   * five thousand, 80 ms for a hundred thousand. Walking the library newest
   * first and stopping at the first matches costs what the library holds
   * *above* them: 3 ms for that dense hundred thousand, 140 ms for five
   * thousand that are all old. So a small folder is sorted, and a large one is
   * found in a bounded walk of the newest {@link COVER_WALK} — falling back to
   * the sort only where a large folder has nothing that recent.
   */
  #newestIn(folder: number, size: number, limit: number): CoverAsset[] {
    const members = (
      this.#s("SELECT count(*) AS n FROM asset_folders WHERE folder_id = ?").get(folder) as {
        n: number;
      }
    ).n;
    if (members > COVER_SORT_MAX) {
      const walked = this.#s(
        `SELECT id, posterMs, derivedAt FROM (
           SELECT a.id AS id, a.poster_ms AS posterMs, a.derived_at AS derivedAt,
                  a.imported_at AS importedAt
             FROM assets a INDEXED BY idx_assets_imported
            WHERE a.trashed_at IS NULL
            ORDER BY a.imported_at DESC, a.id DESC
            LIMIT ?) recent
          WHERE EXISTS (SELECT 1 FROM asset_folders af
                         WHERE af.asset_id = recent.id AND af.folder_id = ?)
            AND EXISTS (SELECT 1 FROM pictures.thumbs t WHERE t.asset_id = recent.id AND t.size = ?)
          ORDER BY importedAt DESC, id DESC
          LIMIT ?`,
      ).all(COVER_WALK, folder, size, limit) as CoverAsset[];
      if (walked.length >= limit) return walked;
    }
    // `CROSS JOIN` pins the order: from the folder's own index into `assets`,
    // never the other way round, which is the plan that read the whole library.
    return this.#s(
      `SELECT a.id AS id, a.poster_ms AS posterMs, a.derived_at AS derivedAt
         FROM asset_folders af CROSS JOIN assets a ON a.id = af.asset_id
        WHERE af.folder_id = ? AND a.trashed_at IS NULL
          AND EXISTS (SELECT 1 FROM pictures.thumbs t WHERE t.asset_id = a.id AND t.size = ?)
        ORDER BY a.imported_at DESC, a.id DESC
        LIMIT ?`,
    ).all(folder, size, limit) as CoverAsset[];
  }

  /** Every folder beneath one, nearest first. The table is small; this is a walk of it. */
  #foldersBelow(folder: number): number[] {
    const rows = this.#s(
      `WITH RECURSIVE sub(id, depth) AS (
         SELECT id, 1 FROM folders WHERE parent_id = ?
         UNION ALL
         SELECT f.id, sub.depth + 1 FROM folders f JOIN sub ON f.parent_id = sub.id
       )
       SELECT id FROM sub ORDER BY depth, id`,
    ).all(folder) as { id: number }[];
    return rows.map((row) => row.id);
  }

  /**
   * Puts one asset's parked or failed job back in the queue, and says whether
   * there was one — the per-file *Try again* (ADR-0050).
   */
  requeueJobFor(kind: JobKind, asset: AssetId): boolean {
    return (
      this.#s(
        `UPDATE jobs SET state = 'ready', reason = NULL
          WHERE kind = ? AND asset_id = ? AND state IN ('blocked', 'failed')`,
      ).run(kind, asset).changes > 0
    );
  }

  /** Retries jobs that failed, up to `maxAttempts` tries each. */
  requeueFailed(kind: JobKind, maxAttempts: number): number {
    return this.#s(
      `UPDATE jobs SET state = 'ready', reason = NULL
        WHERE kind = ? AND state = 'failed' AND attempts < ?`,
    ).run(kind, maxAttempts).changes;
  }

  /**
   * How many jobs sit in each state, in `kind, state` order, omitting zeroes.
   *
   * Not one `GROUP BY` over the table, which is what it was: that reads every
   * row into a sorter, 239 ms at a million queued — and a million queued is
   * exactly the library that asks most often, since a rebuild or a first open
   * is when the status line is counting down (`BENCHMARKS.md`). Instead, the
   * few rows that are not `ready` are grouped through their partial index, and
   * `ready` is what is left of a count the unique index covers: ~20 ms at a
   * million, per kind, and a fraction of that at any ordinary size.
   */
  jobCounts(): JobCount[] {
    const total = this.#s("SELECT count(*) AS count FROM jobs WHERE kind = ?");
    const unfinished = this.#s(
      `SELECT state, count(*) AS count FROM jobs
        WHERE kind = ? AND state <> 'ready'
        GROUP BY state`,
    );

    const counts: JobCount[] = [];
    for (const kind of JOB_KINDS) {
      const rows = unfinished.all(kind) as { state: JobState; count: number }[];
      const all = (total.get(kind) as { count: number }).count;
      const ready = all - rows.reduce((sum, row) => sum + row.count, 0);
      if (ready > 0) rows.push({ state: "ready", count: ready });
      rows.sort((a, b) => a.state.localeCompare(b.state));
      for (const row of rows) counts.push({ kind, state: row.state, count: row.count });
    }
    return counts;
  }

  /** What is holding jobs up, most common first. */
  jobReasons(state: JobState): JobReason[] {
    // `state <> 'ready'` says nothing new about the rows asked for — a ready
    // job holds nothing up — but it is what lets SQLite prove the partial
    // index applies to a state it only sees as a parameter.
    return this.#s(
      `SELECT coalesce(reason, 'unknown') AS reason, count(*) AS count
         FROM jobs WHERE state = ? AND state <> 'ready'
        GROUP BY reason ORDER BY count DESC, reason`,
    ).all(state) as JobReason[];
  }

  /**
   * Jobs stuck in one state, with the file each one is about, oldest first.
   *
   * Both halves of "no picture" are read the same way and shown in the same
   * list: `failed` is something that went wrong and `blocked` is something this
   * machine cannot do yet, and a person looking at an empty cell is owed the
   * same answer either way.
   *
   * Capped by the caller rather than paged: this answers a list somebody reads
   * and groups, and a library where a hundred thousand derives are stuck has
   * one thing wrong with it rather than a hundred thousand. `jobReasons` counts
   * every one of them, and that count is what the caller reports.
   */
  /**
   * Why each of these assets has no picture, for those whose job is parked or
   * failed. An asset with nothing stalled is absent from the map.
   *
   * Asked for a page of the grid at a time, **after** the page is read rather
   * than joined into it: the random order has no index and sorts every match
   * (ADR-0039), and a column computed per row would be computed for all of
   * them. Here it is one lookup per card on `UNIQUE (kind, asset_id)`.
   *
   * The ids travel as one JSON parameter, for {@link Repo.selectionSummary}'s
   * reason.
   */
  stalledReasons(kind: JobKind, ids: readonly AssetId[]): Map<AssetId, string> {
    if (ids.length === 0) return new Map();
    const rows = this.#s(
      `SELECT j.asset_id AS assetId, coalesce(j.reason, '') AS reason
         FROM json_each(?) e
         JOIN jobs j ON j.kind = ? AND j.asset_id = e.value
        WHERE j.state IN ('blocked', 'failed')`,
    ).all(JSON.stringify(ids), kind) as { assetId: AssetId; reason: string }[];
    return new Map(rows.map((row) => [row.assetId, row.reason]));
  }

  /**
   * The stalled jobs in one state, oldest first, with the asset each is about.
   *
   * `except` leaves out reasons nobody needs told about, in the query rather
   * than after it: filtered afterwards, a library with a thousand archives
   * would fill `limit` with them and leave no room for the rest.
   */
  jobsIn(
    kind: JobKind,
    state: JobState,
    limit: number,
    except: readonly string[] = [],
  ): StalledJob[] {
    // The redundant `<> 'ready'` is for the partial index, as in `jobReasons`.
    return this.#s(
      `SELECT j.asset_id AS assetId, a.name AS name, a.ext AS ext,
              j.attempts AS attempts, coalesce(j.reason, '') AS reason
         FROM jobs j JOIN assets a ON a.id = j.asset_id
        WHERE j.kind = ? AND j.state = ? AND j.state <> 'ready'
          AND coalesce(j.reason, '') NOT IN (SELECT value FROM json_each(?))
        ORDER BY j.id
        LIMIT ?`,
    ).all(kind, state, JSON.stringify(except), limit) as StalledJob[];
  }

  /** Every asset id in the index, for comparing a rebuild against the original. */
  allIds(): AssetId[] {
    const rows = this.#s("SELECT id FROM assets ORDER BY id").all() as { id: AssetId }[];
    return rows.map((r) => r.id);
  }

  /**
   * Resolves a unique id prefix to a full id.
   *
   * Twelve characters is far less to type than version 1's sixty-four, and a
   * prefix is still what a person reaches for. Two matches come back as two,
   * not as a silent pick, because the two assets are unrelated files.
   *
   * The comparison is case-sensitive, as ids are: the alphabet is upper case
   * only (RL-14), so a lower-case prefix is a typo rather than a spelling.
   */
  resolveIdPrefix(prefix: string): AssetId[] {
    const rows = this.#s("SELECT id FROM assets WHERE id LIKE ? || '%' LIMIT 2").all(prefix) as {
      id: AssetId;
    }[];
    return rows.map((r) => r.id);
  }

  /**
   * The next free folder id — **the journal's maximum plus one**, not the
   * table's (RL-17, RL-36).
   *
   * The two differ the moment anything is deleted, and that is the whole point.
   * A folder created as 7 and then deleted leaves no row, so `max(id)` over the
   * table answers 6 and the next folder is a **second** folder 7. Within one
   * implementation that replays correctly — the create, the delete and the
   * re-create arrive in order — which is exactly why it survived three
   * milestones here. It stops being true the moment a second implementation is
   * reading the same journal and has not applied the same records: a line one
   * build could not parse, or an entity another build deleted afterwards, and
   * the two now hold different folders under one id with every membership
   * record ambiguous between them.
   *
   * So the maximum is remembered rather than recomputed. {@link Repo.noteIdUsed}
   * raises the mark whenever a create is folded, and nothing ever lowers it.
   * The table is still consulted alongside it, which costs one cheap statement
   * and covers a cache written before the mark existed.
   */
  nextFolderId(): number {
    return this.#nextId("folders");
  }

  nextSmartFolderId(): number {
    return this.#nextId("smart_folders");
  }

  nextTagGroupId(): number {
    return this.#nextId("tag_groups");
  }

  nextCommentId(): number {
    return this.#nextId("asset_comments");
  }

  /**
   * A value from `meta`, or `undefined` if nothing has written that key.
   *
   * `meta` is where the index keeps what it has worked out about the journal —
   * how far it has folded it, and what it had to skip. All of it is derived, so
   * all of it is thrown away and recomputed by a rebuild, which is what keeps
   * invariant 1 true of a table that is not itself journalled.
   */
  meta(key: string): string | undefined {
    const row = this.#s("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.#s(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  /**
   * Whether the library holds this asset.
   *
   * On the primary key and selecting a constant, so it costs an index probe and
   * touches no row: replay asks it once per record that names an asset, which
   * is most of a large journal. It is also RL-15's half of minting an id — the
   * check that a newly minted one is not already in use.
   */
  hasAsset(id: AssetId): boolean {
    return this.#s("SELECT 1 FROM assets WHERE id = ?").get(id) !== undefined;
  }

  /** The same question for the tables whose ids the journal mints. */
  hasRow(table: IdentifiedTable, id: number): boolean {
    return this.#s(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
  }

  /**
   * Records that `id` has been used in `table`, so it is never handed out again
   * (RL-17's *never reused*).
   *
   * Called from the `apply*` methods that fold a create, so replay and live
   * mutation raise the mark by the same hand — there is no second path for one
   * of them to forget.
   */
  noteIdUsed(table: IdentifiedTable, id: number): void {
    this.#s(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE CAST(excluded.value AS INTEGER) > CAST(meta.value AS INTEGER)`,
    ).run(`${ID_WATERMARK_PREFIX}${table}`, String(id));
  }

  #nextId(table: IdentifiedTable): number {
    const mark = this.#count(
      `SELECT coalesce(CAST((SELECT value FROM meta WHERE key = '${ID_WATERMARK_PREFIX}${table}') AS INTEGER), 0) AS n`,
    );
    const highest = this.#count(`SELECT coalesce(max(id), 0) AS n FROM ${table}`);
    return Math.max(mark, highest) + 1;
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
   * rather than paying for a recursive query per folder, and takes away the
   * second count of an asset in two of them with {@link Repo.sharedMemberships}.
   */
  folderCounts(): Map<number, number> {
    // Trashed assets are excluded, because `folder:` excludes them too — a
    // count beside a query has to be the count *of* that query, or the sidebar
    // is telling the user something the grid then contradicts (ADR-0022).
    //
    // Every membership less the trashed ones, rather than one join that
    // filters: that join looks up the asset behind every membership, 3.7 s at a
    // million of them, where the trash is small and has an index of its own
    // (`BENCHMARKS.md`). `CROSS JOIN` fixes the order — left to itself, with no
    // statistics, the planner walks the memberships and took 7.4 s.
    const counts = new Map<number, number>();
    const all = this.#s(
      `SELECT folder_id AS folderId, count(*) AS n FROM asset_folders GROUP BY folder_id`,
    ).all() as { folderId: number; n: number }[];
    for (const row of all) counts.set(row.folderId, row.n);
    const trashed = this.#s(
      `SELECT af.folder_id AS folderId, count(*) AS n
         FROM assets a
        CROSS JOIN asset_folders af ON af.asset_id = a.id
        WHERE a.trashed_at IS NOT NULL
        GROUP BY af.folder_id`,
    ).all() as { folderId: number; n: number }[];
    for (const row of trashed) counts.set(row.folderId, (counts.get(row.folderId) ?? 0) - row.n);
    return counts;
  }

  /**
   * The folders of every live asset that is in more than one.
   *
   * What a subtree count needs so that it counts an asset once: summing
   * {@link Repo.folderCounts} over a subtree counts an asset in `Design` and
   * `Design/Icons` twice, where `folder:Design` finds it once. Only these
   * assets can be counted twice, and in an ordinary library they are few.
   *
   * One scan of the membership key, grouped as it is stored, and the trash
   * taken out afterwards for the reason `folderCounts` gives.
   */
  sharedMemberships(): number[][] {
    const trashed = new Set(
      (
        this.#s("SELECT id FROM assets WHERE trashed_at IS NOT NULL").all() as { id: AssetId }[]
      ).map((row) => row.id),
    );
    const rows = this.#s(
      `SELECT asset_id AS id, group_concat(folder_id) AS folders
         FROM asset_folders
        GROUP BY asset_id
       HAVING count(*) > 1`,
    ).all() as { id: AssetId; folders: string }[];
    const shared: number[][] = [];
    for (const row of rows) {
      if (!trashed.has(row.id)) shared.push(row.folders.split(",").map(Number));
    }
    return shared;
  }

  /**
   * The live assets in any of these folders, each once.
   *
   * For the one gesture that has to act on a folder's contents rather than on
   * the folder: deleting one and taking what it holds to the trash. Distinct,
   * because an asset in a folder *and* its child would otherwise be journalled
   * twice; and live, because trashing what is already trashed says nothing.
   *
   * The ids arrive as one JSON parameter for the reason
   * {@link Repo.selectionSummary} gives — a folder subtree is small, but the
   * statement stays one cached string whatever its size.
   */
  assetsInFolders(folders: readonly number[]): AssetId[] {
    const rows = this.#s(
      `SELECT DISTINCT af.asset_id AS id
         FROM asset_folders af
         JOIN assets a ON a.id = af.asset_id
        WHERE af.folder_id IN (SELECT value FROM json_each(?))
          AND a.trashed_at IS NULL
        ORDER BY af.asset_id`,
    ).all(JSON.stringify(folders)) as { id: AssetId }[];
    return rows.map((row) => row.id);
  }

  /**
   * Every tag, with its live asset count and its group.
   *
   * The count excludes trashed assets, for the reason {@link Repo.folderCounts}
   * gives. The joins stay `LEFT` so that a tag every one of whose assets is in
   * the trash is still listed, at zero — the tag has not been deleted, and a
   * row vanishing from the sidebar is a different statement from a count
   * falling to nothing.
   *
   * That a tag outlives its last asset is **this build's** answer to a question
   * the format lists as open (`SPEC.md` §11.4) and requires nobody else to
   * share.
   */
  tags(): TagRow[] {
    return this.#s(
      `SELECT t.name AS name, count(a.id) AS count, g.name AS "group"
         FROM tags t
         LEFT JOIN asset_tags at ON at.tag_id = t.id
         LEFT JOIN assets a ON a.id = at.asset_id AND a.trashed_at IS NULL
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
   * Ordering is `(imported_at DESC, id DESC)` — the exact order
   * `idx_assets_imported` holds — so both the sort and the resume are index
   * seeks rather than a scan and a sort.
   */
  search(filter: Filter, page: Page): SearchHit[] {
    const sort = page.sort ?? DEFAULT_SORT;
    const named: {
      limit: number;
      rotate: number;
      cursorKey?: CursorKey;
      cursorId?: string;
    } = { limit: page.limit, rotate: rotationFor(sort.seed) };
    if (page.after !== undefined) {
      named.cursorKey = page.after.key;
      named.cursorId = page.after.id;
    }

    // The filter's own `?` are positional, and a resume repeats the whole
    // statement once per seek (see {@link searchSql}) — so its values are
    // repeated with it. Everything the repository adds is bound by name, which
    // is what lets one cursor value be written in two places and still be one
    // parameter to SQLite.
    const sql = searchSql(filter.sql, page.after !== undefined, sort);
    const positional =
      page.after !== undefined && ties(sort)
        ? [...filter.params, ...filter.params]
        : [...filter.params];

    const rows = this.#s(sql).all(...positional, named) as (Omit<SearchHit, "isFavorite"> & {
      isFavorite: number;
    })[];

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
 * How each sort key is spelled in SQL, and whether two rows can share it.
 *
 * The expression is the **definition of the order**: the schema indexes exactly
 * these, character for character, and the resume compares exactly these. A
 * second spelling anywhere is an order that pages wrongly.
 *
 * Three of them coalesce a nullable column, because a NULL in a keyset
 * comparison yields NULL and silently drops rows: a file with no creation date
 * is dated when it arrived, an unrated asset sorts below one star, and — new in
 * version 2 — an asset nothing has read yet has no size (RL-22), so sorting by
 * size has to place it somewhere rather than losing it. `lower()` is SQLite's,
 * which folds ASCII and nothing else — the same folding `@roost/library` does
 * for folder names, chosen there for the same reason.
 *
 * `random` is the one with no column, no index, and no ties: a rotation of the
 * **id** by `@rotate` characters (`rotationFor`). Because the rotation is a
 * bijection of a unique id it cannot tie, which is why it needs only one seek
 * rather than two. Version 1 rotated the content hash; an id is uniformly
 * random too (RL-14) and, unlike a hash, is never absent.
 */
const ORDERS: Readonly<Record<SortKey, { readonly expr: string; readonly ties: boolean }>> = {
  added: { expr: "a.imported_at", ties: true },
  created: { expr: "COALESCE(a.created_at, a.imported_at)", ties: true },
  name: { expr: "lower(a.name)", ties: true },
  size: { expr: "COALESCE(a.size, 0)", ties: true },
  rating: { expr: "COALESCE(a.rating, 0)", ties: true },
  random: { expr: "substr(a.id, @rotate + 1) || substr(a.id, 1, @rotate)", ties: false },
};

/** Whether resuming this order needs the second seek. */
function ties(sort: Sort): boolean {
  return ORDERS[sort.key].ties;
}

/**
 * Assembles the statement {@link Repo.search} runs, around a compiled filter.
 *
 * **The tie-break follows the key.** Every order is `(key, id)` in one
 * direction, never a mixed one, and the schema's indexes are built to match —
 * because a mixed order is one an index can serve in a single direction, and it
 * was the reason the resume could not be written as a comparison of the pair.
 *
 * **A resume is two seeks, not one predicate.** The rows still to come are
 * those *further along the key*, plus those *with the same key and a later id*,
 * and written as one disjunction SQLite seeks on the key alone and then walks
 * the whole run of equal keys. That is invisible until a key repeats: ratings
 * have six values, so page 500 of a rating-sorted library walked 50,000 rows
 * and cost 5.8 ms against 0.06 ms for the same page written as two seeks
 * (measured at 95,001 assets, `docs/BENCHMARKS.md`). Each half is a range on an
 * index that already holds `(key, id)`, so each is a seek; the halves cannot
 * overlap, and the first half sorts entirely before the second, so a plain
 * `UNION ALL` is already in order and needs no outer sort.
 *
 * **The cursor is written twice and named once.** Given two anonymous
 * placeholders SQLite sees two unrelated parameters and cannot prove the
 * comparison collapses to a range; given one named parameter it seeks. The Rust
 * build spelled that `?1`, which does not survive the port — `better-sqlite3`
 * treats `?NNN` as *named* and refuses to bind it positionally — so the filter's
 * anonymous `?` are bound positionally and everything this function adds is
 * bound by name.
 */
export function searchSql(
  filterSql: string,
  hasCursor: boolean,
  sort: Sort = DEFAULT_SORT,
): string {
  const { expr, ties: canTie } = ORDERS[sort.key];
  const way = sort.descending ? "DESC" : "ASC";
  // Descending, "still to come" means smaller. The comparison and the direction
  // are the same fact said twice, and they are derived from it rather than
  // written down twice.
  const beyond = sort.descending ? "<" : ">";

  const page = (where: string, order: string): string =>
    `SELECT a.id AS id, a.name AS name, a.ext AS ext, a.size AS size,
            a.width AS width, a.height AS height, a.imported_at AS importedAt,
            a.rating AS rating, a.is_favorite AS isFavorite,
            a.poster_ms AS posterMs, a.derived_at AS derivedAt, ${expr} AS sortKey
       FROM assets a
      WHERE ${where}
      ORDER BY ${order}
      LIMIT @limit`;

  const whole = `${expr} ${way}, a.id ${way}`;
  if (!hasCursor) return page(`(${filterSql})`, whole);

  const beyondKey = page(`(${filterSql}) AND ${expr} ${beyond} @cursorKey`, whole);
  if (!canTie) return beyondKey;

  const sameKey = page(
    `(${filterSql}) AND ${expr} = @cursorKey AND a.id ${beyond} @cursorId`,
    `a.id ${way}`,
  );
  return `SELECT * FROM (${sameKey})
    UNION ALL
    SELECT * FROM (${beyondKey})
    LIMIT @limit`;
}

/** The cursor that resumes a listing after the last hit on a page. */
export function lastCursor(hits: readonly SearchHit[]): Cursor | undefined {
  const last = hits.at(-1);
  return last === undefined ? undefined : { key: last.sortKey, id: last.id };
}

/**
 * Whether a selection agrees about one free-text field.
 *
 * The same rule as the rating's, for the same reason: `min` skips NULLs, so two
 * assets reading "approved" and one with no note would agree on "approved" if
 * the count of holders were not checked against the count of assets.
 */
function sharedText(
  count: number,
  holding: number,
  distinct: number,
  lowest: string | null,
): SharedText {
  const agreed = holding === 0 || (holding === count && distinct === 1);
  return { value: agreed ? lowest : null, mixed: !agreed, distinct, holding };
}
