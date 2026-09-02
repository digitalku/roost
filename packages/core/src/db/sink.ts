import { type JournalRecord, MalformedRecordError, type ReplaySink } from "../journal/index.js";
import type { Db } from "./database.js";
import type { Repo } from "./repo.js";

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
   */
  apply(record: JournalRecord): void {
    if (!this.#db.inTransaction) {
      this.#db.beginTransaction();
      this.#owned = true;
    }

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
