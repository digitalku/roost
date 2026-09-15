import {
  DanglingReferenceError,
  type JournalRecord,
  MalformedRecordError,
  type ReplaySink,
} from "../journal/index.js";
import type { ContentHash } from "../model/index.js";
import type { Db } from "./database.js";
import type { IdentifiedTable, Repo } from "./repo.js";

/**
 * How many records one rebuild transaction holds.
 *
 * SQLite commits — and, under `synchronous = NORMAL`, syncs the WAL — once per
 * transaction rather than once per statement, so batching is the difference
 * between a rebuild measured in seconds and one measured in minutes. The number
 * is a trade against how much work a crash mid-rebuild discards, and a rebuild
 * is restartable from the journal, so it can afford to be large.
 */
export const REBUILD_BATCH_SIZE = 10_000;

/** Something a record needs to already exist. */
type Referent =
  | { readonly kind: "asset"; readonly hash: ContentHash }
  | { readonly kind: IdentifiedTable; readonly id: number };

/** What each table is called when a person is told about it. */
const REFERENT_NAMES: Readonly<Record<IdentifiedTable, string>> = {
  folders: "folder",
  smart_folders: "smart folder",
  tag_groups: "tag group",
  asset_comments: "comment",
};

/**
 * What a record names that must already be in the library (RL-26a).
 *
 * Exhaustive over `Op`, and written out rather than inferred from the schema's
 * foreign keys on purpose. The schema is a **cache** — the format says so,
 * RL-2 — so which constraints it happens to declare is this build's business
 * and could change without anybody meaning to change what a journal means.
 * Which entities a record depends on is the format's business, and belongs in
 * one list somebody can read against the registry.
 *
 * `add`, `folder_create`, `smart_folder_create`, `tag_group_create` and the two
 * rename-by-name operations answer with nothing. A tag is named rather than
 * numbered (the registry says why), so `tag_rename` from a name nobody uses is
 * an ordinary no-op and not a dangling reference; and a create is what brings
 * its own entity into being.
 */
function referentsOf(record: JournalRecord): readonly Referent[] {
  const asset = (hash: ContentHash): readonly Referent[] => [{ kind: "asset", hash }];

  switch (record.op) {
    case "add":
    case "folder_create":
    case "smart_folder_create":
    case "tag_group_create":
    case "tag_rename":
      return [];
    case "remove":
    case "trash":
    case "restore":
    case "tag_add":
    case "tag_remove":
    case "asset_rename":
    case "rate":
    case "note_set":
    case "source_set":
    case "favorite_set":
    case "poster_set":
    case "supersede":
    case "comment_add":
      return asset(record.hash);
    case "subtitle_attach":
    case "subtitle_detach":
      return [
        { kind: "asset", hash: record.hash },
        { kind: "asset", hash: record.track },
      ];
    case "folder_add":
    case "folder_remove":
      return [
        { kind: "asset", hash: record.hash },
        { kind: "folders", id: record.folder },
      ];
    case "folder_rename":
    case "folder_move":
    case "folder_delete":
      return [{ kind: "folders", id: record.id }];
    case "smart_folder_update":
    case "smart_folder_delete":
      return [{ kind: "smart_folders", id: record.id }];
    case "tag_group_rename":
    case "tag_group_delete":
      return [{ kind: "tag_groups", id: record.id }];
    case "tag_group_set":
      // The tag is named, so only the group can dangle — and `null` is the
      // operation that takes a tag *out* of a group, which names none.
      return record.group === null ? [] : [{ kind: "tag_groups", id: record.group }];
    case "comment_set":
    case "comment_remove":
      return [{ kind: "asset_comments", id: record.id }];
    default: {
      const unhandled: never = record;
      throw new MalformedRecordError("op", `unhandled operation: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Folds journal records into the index.
 *
 * The only translation from journal to index, used by both replay and live
 * mutation. Sharing it is what makes "a rebuild produces the same database" a
 * property of the design rather than a coincidence to be tested for — there is
 * no second, subtly different path for either to drift onto.
 *
 * A caller must already have appended to the journal before reaching here.
 * Journal before index, always (invariant 9).
 *
 * **Transactions.** If the caller already holds one, every record joins it and
 * this sink commits nothing — which is what live mutation wants, one record per
 * transaction alongside its journal append. If not, the sink opens its own and
 * commits every {@link REBUILD_BATCH_SIZE} records, closing the last one in
 * {@link finish}. That is what replay wants, and replay cannot use
 * `Db.transaction` because it awaits.
 */
export class IndexSink implements ReplaySink {
  readonly #db: Db;
  readonly #repo: Repo;
  readonly #batchSize: number;
  #owned = false;
  #pending = 0;

  constructor(db: Db, batchSize: number = REBUILD_BATCH_SIZE) {
    this.#db = db;
    this.#repo = db.repo;
    this.#batchSize = batchSize;
  }

  /**
   * Applies one record.
   *
   * The switch is exhaustive over `Op`, and deliberately has no `default`: a
   * new operation added to the union then fails to compile here, which is the
   * only place that failure is cheap. An operation from a *newer* build never
   * reaches this method — replay recognises the unknown name first and counts
   * it (`journal/replay.ts`).
   *
   * @throws DanglingReferenceError when the record names something that is not
   * in the library. Nothing is written for it, and nothing is invented to make
   * it fit (RL-26a).
   */
  apply(record: JournalRecord): void {
    if (!this.#db.inTransaction) {
      this.#db.beginTransaction();
      this.#owned = true;
    }

    this.#requireReferents(record);
    this.#fold(record);

    this.#pending += 1;
    if (this.#owned && this.#pending >= this.#batchSize) this.#commit();
  }

  /** Commits the batch this sink opened, if it opened one. */
  finish(): void {
    this.#commit();
  }

  #commit(): void {
    if (this.#owned) {
      this.#db.commitTransaction();
      this.#owned = false;
    }
    this.#pending = 0;
  }

  /**
   * Refuses a record whose referents are not there, before anything is written.
   *
   * Before, not after, because half of these would otherwise be a foreign key
   * failure and the other half a silent no-op — a `rate` on an asset nobody
   * added updates no rows and reports success. One rule for both is what makes
   * the count in the replay report mean something.
   */
  #requireReferents(record: JournalRecord): void {
    for (const referent of referentsOf(record)) {
      if (referent.kind === "asset") {
        if (this.#repo.hasAsset(referent.hash)) continue;
        throw new DanglingReferenceError(record.op, "asset", referent.hash);
      }
      if (this.#repo.hasRow(referent.kind, referent.id)) continue;
      throw new DanglingReferenceError(record.op, REFERENT_NAMES[referent.kind], referent.id);
    }
  }

  #fold(record: JournalRecord): void {
    const repo = this.#repo;
    switch (record.op) {
      case "add":
        repo.applyAdd(record.ts, record);
        return;
      case "remove":
        repo.applyRemove(record.hash);
        return;
      case "trash":
        // The line's own `ts` is the trashing time; the op carries no second
        // one (ADR-0022). Replay and a live edit therefore agree by
        // construction rather than by both remembering to use the same clock.
        repo.applyTrash(record.hash, record.ts);
        return;
      case "restore":
        repo.applyRestore(record.hash);
        return;
      case "tag_add":
        repo.applyTagAdd(record.hash, record.tags);
        return;
      case "tag_remove":
        repo.applyTagRemove(record.hash, record.tags);
        return;
      case "folder_create":
        repo.applyFolderCreate(record.id, record.parent, record.name);
        return;
      case "folder_add":
        repo.applyFolderAdd(record.hash, record.folder);
        return;
      case "folder_remove":
        repo.applyFolderRemove(record.hash, record.folder);
        return;
      case "folder_rename":
        repo.applyFolderRename(record.id, record.name);
        return;
      case "folder_move":
        repo.applyFolderMove(record.id, record.parent);
        return;
      case "folder_delete":
        repo.applyFolderDelete(record.id);
        return;
      case "asset_rename":
        repo.applyAssetRename(record.hash, record.name);
        return;
      case "tag_rename":
        repo.applyTagRename(record.from, record.to);
        return;
      case "rate":
        repo.applyRate(record.hash, record.rating);
        return;
      case "note_set":
        repo.applyNoteSet(record.hash, record.note);
        return;
      case "source_set":
        repo.applySourceSet(record.hash, record.url);
        return;
      case "comment_add":
        // The line's own `ts` becomes `created_at`, as `trash` does with
        // `trashed_at`: a live edit and a replay then agree by construction
        // rather than by both remembering to read the same clock.
        repo.applyCommentAdd(record.id, record.hash, record.at, record.body, record.ts);
        return;
      case "comment_set":
        repo.applyCommentSet(record.id, record.at, record.body, record.ts);
        return;
      case "comment_remove":
        repo.applyCommentRemove(record.id);
        return;
      case "poster_set":
        repo.applyPosterSet(record.hash, record.at);
        return;
      case "favorite_set":
        repo.applyFavoriteSet(record.hash, record.favorite);
        return;
      case "subtitle_attach":
        repo.applySubtitleAttach(record.hash, record.track, record.lang, record.label);
        return;
      case "subtitle_detach":
        repo.applySubtitleDetach(record.hash, record.track);
        return;
      case "supersede":
        repo.applySupersede(record.hash, record.to);
        return;
      case "smart_folder_create":
        repo.applySmartFolderCreate(record.id, record.parent, record.name, record.query);
        return;
      case "smart_folder_update":
        repo.applySmartFolderUpdate(record.id, record.name, record.query);
        return;
      case "smart_folder_delete":
        repo.applySmartFolderDelete(record.id);
        return;
      case "tag_group_create":
        repo.applyTagGroupCreate(record.id, record.name);
        return;
      case "tag_group_rename":
        repo.applyTagGroupRename(record.id, record.name);
        return;
      case "tag_group_delete":
        repo.applyTagGroupDelete(record.id);
        return;
      case "tag_group_set":
        repo.applyTagGroupSet(record.tag, record.group);
        return;
      default: {
        // `record` narrows to `never` only if every operation above is
        // handled, so adding one to the union fails to compile here — the one
        // place that failure is cheap. Unreachable at run time: an operation
        // from a newer build is recognised and counted by replay before it
        // gets this far, and a known name with unusable fields is rejected by
        // `toRecord`.
        const unhandled: never = record;
        throw new MalformedRecordError("op", `unhandled operation: ${JSON.stringify(unhandled)}`);
      }
    }
  }
}
