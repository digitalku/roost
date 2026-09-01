import {
  type CommentRow,
  type ContentHash,
  IndexSink,
  type JournalRecord,
  logger,
  type Op,
} from "@roost/core";
import { parse } from "@roost/search";
import {
  AmbiguousFolderNameError,
  AmbiguousHashError,
  EmptyCommentError,
  EmptyNameError,
  FolderCycleError,
  InvalidMomentError,
  InvalidRatingError,
  UnknownAssetError,
  UnknownCommentError,
  UnknownFolderError,
  UnknownFolderPathError,
  UnknownSmartFolderError,
  UnknownTagGroupError,
} from "./error.js";
import { type Library, nowUnix } from "./library.js";

/**
 * User-authored mutations: tags, folders, ratings, notes, favourites, and saved
 * queries.
 *
 * Every function here follows the import pipeline's order, and for the same
 * reason: **journal first, then index** (invariant 9). A row in `index.db` with
 * no journal line is silent data loss on the next rebuild.
 *
 * Validation lives here rather than in `@roost/core`'s `Repo`, because the
 * repository is also the replay path. Replay has to accept whatever the journal
 * already contains; keeping something invalid out of it in the first place is
 * this layer's job.
 */

const log = logger("edit");

/** The highest rating the schema accepts. No stars is `null`, never `0`. */
export const MAX_RATING = 5;

/**
 * Every mutation here is `async`, including the ones whose validation is
 * entirely synchronous.
 *
 * A function that returns a promise but throws before returning one cannot be
 * caught with `.catch()`, so half its failures would arrive by a different
 * route from the other half. Marking them `async` makes every failure a
 * rejection.
 */

/**
 * Appends `ops` to the journal, then folds them into the index.
 *
 * One journal batch and one transaction, so edits made together are durable
 * together. Exported because a caller occasionally has a mixed batch that no
 * single helper below describes.
 */
export async function apply(library: Library, ops: readonly Op[]): Promise<void> {
  if (ops.length === 0) return;

  const ts = nowUnix();
  const records: JournalRecord[] = ops.map((op) => ({ ts, ...op }));

  await library.journal.appendAll(records);

  library.db.transaction(() => {
    const sink = new IndexSink(library.db);
    for (const record of records) sink.apply(record);
  });

  log.debug("edits journalled and indexed", { ops: kinds(records) });
}

/** The distinct operation names in a batch, for the log line. */
function kinds(records: readonly JournalRecord[]): string {
  return [...new Set(records.map((record) => record.op))].sort().join(",");
}

/**
 * Resolves a full hash or an unambiguous prefix to an asset.
 *
 * A prefix matching nothing and a prefix matching two assets are different
 * mistakes, so they raise different errors. The second must never quietly pick
 * one: the two are unrelated files.
 */
export function resolveAsset(library: Library, needle: string): ContentHash {
  const wanted = needle.trim().toLowerCase();
  if (wanted === "" || !/^[0-9a-f]+$/.test(wanted)) throw new UnknownAssetError(needle);

  const found = library.db.repo.resolveHashPrefix(wanted);
  const [first] = found;
  if (first === undefined) throw new UnknownAssetError(needle);
  if (found.length > 1) throw new AmbiguousHashError(needle);
  return first;
}

function requireAsset(library: Library, hash: ContentHash): void {
  if (library.db.repo.findAsset(hash) === undefined) throw new UnknownAssetError(hash);
}

function cleanName(name: string, what: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new EmptyNameError(what);
  return trimmed;
}

/**
 * A folder name, which may not contain the path separator.
 *
 * See {@link AmbiguousFolderNameError}: a top-level folder called `Design/Icons`
 * and an `Icons` inside `Design` compile to the same `folder:` query, so one of
 * them is unreachable through the sidebar and neither is reliably reachable
 * from the CLI.
 */
function cleanFolderName(name: string): string {
  const clean = cleanName(name, "folder");
  if (clean.includes("/")) throw new AmbiguousFolderNameError(clean);
  return clean;
}

function cleanNames(names: readonly string[], what: string): string[] {
  return names.map((name) => cleanName(name, what));
}

// --- Tags --------------------------------------------------------------------

export async function tagAdd(
  library: Library,
  assets: readonly ContentHash[],
  tags: readonly string[],
): Promise<void> {
  const cleaned = cleanNames(tags, "tag");
  return apply(
    library,
    assets.map((hash) => {
      requireAsset(library, hash);
      return { op: "tag_add", hash, tags: cleaned } as const;
    }),
  );
}

export async function tagRemove(
  library: Library,
  assets: readonly ContentHash[],
  tags: readonly string[],
): Promise<void> {
  const cleaned = cleanNames(tags, "tag");
  return apply(
    library,
    assets.map((hash) => {
      requireAsset(library, hash);
      return { op: "tag_remove", hash, tags: cleaned } as const;
    }),
  );
}

/**
 * Renames a tag across the library, merging into the target if one exists.
 *
 * The merge is stated up front rather than discovered afterwards: `tags.name`
 * is `UNIQUE COLLATE NOCASE`, so a rename onto an existing name has no other
 * outcome that both succeeds and replays to the same state.
 */
export async function tagRename(library: Library, from: string, to: string): Promise<void> {
  return apply(library, [
    { op: "tag_rename", from: cleanName(from, "tag"), to: cleanName(to, "tag") },
  ]);
}

/**
 * Creates a tag group and returns its id.
 *
 * A group arranges tags; it does not contain them. Tag names stay globally
 * unique, so grouping never changes what `tag:` means.
 */
export async function createTagGroup(library: Library, name: string): Promise<number> {
  const id = library.db.repo.nextTagGroupId();
  await apply(library, [{ op: "tag_group_create", id, name: cleanName(name, "tag group") }]);
  return id;
}

export async function renameTagGroup(library: Library, id: number, name: string): Promise<void> {
  return apply(library, [{ op: "tag_group_rename", id, name: cleanName(name, "tag group") }]);
}

/** Deletes a group. The tags in it survive, ungrouped. */
export async function deleteTagGroup(library: Library, id: number): Promise<void> {
  return apply(library, [{ op: "tag_group_delete", id }]);
}

/** Puts tags in a group, or takes them out when `group` is `null`. */
export async function setTagGroup(
  library: Library,
  tags: readonly string[],
  group: number | null,
): Promise<void> {
  return apply(
    library,
    cleanNames(tags, "tag").map((tag) => ({ op: "tag_group_set", tag, group }) as const),
  );
}

export function resolveTagGroup(library: Library, name: string): number {
  const found = library.db.repo.findTagGroupByName(name.trim());
  if (found === undefined) throw new UnknownTagGroupError(name);
  return found.id;
}

// --- Rating, note, favourite -------------------------------------------------

export async function rate(
  library: Library,
  assets: readonly ContentHash[],
  rating: number | null,
): Promise<void> {
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > MAX_RATING)) {
    throw new InvalidRatingError(rating);
  }
  return apply(
    library,
    assets.map((hash) => {
      requireAsset(library, hash);
      return { op: "rate", hash, rating } as const;
    }),
  );
}

/**
 * `null` clears the note, and so does an all-whitespace one: storing that would
 * show an empty note badge on the asset forever.
 */
export async function setNote(
  library: Library,
  hash: ContentHash,
  note: string | null,
): Promise<void> {
  requireAsset(library, hash);
  const trimmed = note === null ? null : note.trim();
  return apply(library, [{ op: "note_set", hash, note: trimmed === "" ? null : trimmed }]);
}

// --- Comments (ADR-0023) -----------------------------------------------------

/**
 * Adds a comment, at a moment or about the asset as a whole.
 *
 * `atMs` is milliseconds into the medium, and `null` means the comment is about
 * the asset — which is what lets a `.zip` carry one. Returns the id, because
 * every later edit names the comment by it.
 *
 * The id is minted `max(id) + 1` from this process's own view of the index, as
 * folders are, so a second *window* has to be refused at open (`Library`'s
 * `exclusive`). Two CLI runs are fine; two minting windows are not.
 */
export async function addComment(
  library: Library,
  hash: ContentHash,
  atMs: number | null,
  body: string,
): Promise<number> {
  requireAsset(library, hash);
  const id = library.db.repo.nextCommentId();
  await apply(library, [
    { op: "comment_add", id, hash, at: requireMoment(atMs), body: requireBody(body) },
  ]);
  return id;
}

/**
 * Edits a comment in place.
 *
 * In place rather than remove-and-re-add, so the comment keeps its identity:
 * re-adding would move it to the end of every list ordered by creation, and a
 * person who fixed a typo did not ask for that.
 */
export async function setComment(
  library: Library,
  id: number,
  atMs: number | null,
  body: string,
): Promise<void> {
  requireComment(library, id);
  return apply(library, [
    { op: "comment_set", id, at: requireMoment(atMs), body: requireBody(body) },
  ]);
}

export async function removeComment(library: Library, id: number): Promise<void> {
  requireComment(library, id);
  return apply(library, [{ op: "comment_remove", id }]);
}

/** The comments on one asset, timed ones first and in timeline order. */
export function comments(library: Library, hash: ContentHash): readonly CommentRow[] {
  requireAsset(library, hash);
  return library.db.repo.commentsFor(hash);
}

function requireComment(library: Library, id: number): CommentRow {
  const found = library.db.repo.comment(id);
  if (found === undefined) throw new UnknownCommentError(id);
  return found;
}

function requireBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed === "") throw new EmptyCommentError();
  return trimmed;
}

/**
 * Validated here rather than in the repository, because replay has to accept
 * whatever the journal already holds and this is the layer that keeps a bad
 * moment out of it in the first place.
 */
function requireMoment(atMs: number | null): number | null {
  if (atMs === null) return atMs;
  if (!Number.isSafeInteger(atMs) || atMs < 0) throw new InvalidMomentError(atMs);
  return atMs;
}

export async function setFavorite(
  library: Library,
  assets: readonly ContentHash[],
  favorite: boolean,
): Promise<void> {
  return apply(
    library,
    assets.map((hash) => {
      requireAsset(library, hash);
      return { op: "favorite_set", hash, favorite } as const;
    }),
  );
}

/**
 * Renames what the library shows. The file on disk keeps its hash filename
 * (invariant 2) — nothing under `originals/` is touched.
 */
export async function renameAsset(
  library: Library,
  hash: ContentHash,
  name: string,
): Promise<void> {
  requireAsset(library, hash);
  return apply(library, [{ op: "asset_rename", hash, name: cleanName(name, "name") }]);
}

/**
 * Moves assets to the trash (ADR-0022).
 *
 * What `Delete` means. The row and everything hanging off it stay — tags,
 * rating, note, folder memberships, thumbnail — and only what sees the asset
 * changes. Nothing on disk moves, in either storage mode.
 *
 * Trashing something already in the trash is not an error: it re-stamps
 * `trashed_at` with the later time, which is what somebody who trashed,
 * restored, and trashed again would expect Trash to show.
 */
export async function trashAssets(library: Library, assets: readonly ContentHash[]): Promise<void> {
  return apply(
    library,
    assets.map((hash) => {
      requireAsset(library, hash);
      return { op: "trash", hash } as const;
    }),
  );
}

/** Brings assets back out of the trash. Restoring a live asset is a no-op. */
export async function restoreAssets(
  library: Library,
  assets: readonly ContentHash[],
): Promise<void> {
  return apply(
    library,
    assets.map((hash) => {
      requireAsset(library, hash);
      return { op: "restore", hash } as const;
    }),
  );
}

/**
 * Removes every trashed asset from the library, and answers with how many.
 *
 * "Empty trash" is {@link removeAssets} over what the trash holds, which is why
 * emptying needs no operation of its own: `remove` already means exactly this,
 * and giving the destructive case a second spelling would be two things to keep
 * in step. **There is no timer** — Eagle empties after thirty days, and an
 * application that deletes a person's files on a schedule, possibly while they
 * are not looking, is not one this project ships (ADR-0022).
 */
export async function emptyTrash(library: Library): Promise<number> {
  const trashed = library.db.repo.trashedHashes();
  await removeAssets(library, trashed);
  return trashed.length;
}

/**
 * Removes assets from the library, permanently as far as the index goes.
 *
 * Not what `Delete` does — see {@link trashAssets}. This is what "Empty trash"
 * and "Delete permanently" send, and what `roost remove` has always done.
 *
 * Index rows only. The bytes under `originals/` stay where they are: reclaiming
 * them is a separate, reviewable step (`roost doctor --reclaim`), because
 * deleting someone's only copy of a file as a side effect of a metadata edit is
 * not a trade this project makes. A referenced original is never touched at all
 * (invariant 6).
 */
export async function removeAssets(
  library: Library,
  assets: readonly ContentHash[],
): Promise<void> {
  return apply(
    library,
    assets.map((hash) => {
      requireAsset(library, hash);
      return { op: "remove", hash } as const;
    }),
  );
}

// --- Folders -----------------------------------------------------------------

/** Creates a folder and returns its id. */
export async function createFolder(
  library: Library,
  name: string,
  parent: number | null,
): Promise<number> {
  const clean = cleanFolderName(name);
  if (parent !== null) requireFolder(library, parent);
  const id = library.db.repo.nextFolderId();
  await apply(library, [{ op: "folder_create", id, parent, name: clean }]);
  return id;
}

export async function renameFolder(library: Library, id: number, name: string): Promise<void> {
  requireFolder(library, id);
  return apply(library, [{ op: "folder_rename", id, name: cleanFolderName(name) }]);
}

/** Moves a folder under `parent`, or to the top level when `parent` is `null`. */
export async function moveFolder(
  library: Library,
  id: number,
  parent: number | null,
): Promise<void> {
  requireFolder(library, id);
  if (parent !== null) {
    requireFolder(library, parent);
    // Moving a folder into its own subtree cuts that subtree off from the root:
    // unreachable in the sidebar, and undeletable through it.
    if (library.db.repo.folderIsWithin(parent, id)) throw new FolderCycleError(id, parent);
  }
  return apply(library, [{ op: "folder_move", id, parent }]);
}

/**
 * Deletes a folder, its descendants, and every membership in them. The assets
 * stay in the library — folders are collections, not locations.
 */
export async function deleteFolder(library: Library, id: number): Promise<void> {
  requireFolder(library, id);
  return apply(library, [{ op: "folder_delete", id }]);
}

export async function addToFolder(
  library: Library,
  assets: readonly ContentHash[],
  folder: number,
): Promise<void> {
  requireFolder(library, folder);
  return apply(
    library,
    assets.map((hash) => {
      requireAsset(library, hash);
      return { op: "folder_add", hash, folder } as const;
    }),
  );
}

export async function removeFromFolder(
  library: Library,
  assets: readonly ContentHash[],
  folder: number,
): Promise<void> {
  requireFolder(library, folder);
  return apply(
    library,
    assets.map((hash) => ({ op: "folder_remove", hash, folder }) as const),
  );
}

/** Resolves `Design/Icons` to a folder id. */
export function resolveFolder(library: Library, path: string): number {
  const segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  if (segments.length === 0) throw new EmptyNameError("folder");

  const found = library.db.repo.findFolderByPath(segments);
  if (found === undefined) throw new UnknownFolderPathError(path);
  return found;
}

function requireFolder(library: Library, id: number): void {
  if (library.db.repo.folder(id) === undefined) throw new UnknownFolderError(id);
}

// --- Smart folders -----------------------------------------------------------

/**
 * Saves an RQL query as a smart folder and returns its id.
 *
 * The query text is stored verbatim and compiled to bound parameters each time
 * it runs; it is never concatenated into SQL, here or anywhere else.
 *
 * It is parsed **before** it is saved. A smart folder that cannot be evaluated
 * is worse than one that does not exist: it fails later, in a sidebar, far from
 * the typo that caused it.
 */
export async function createSmartFolder(
  library: Library,
  name: string,
  query: string,
  parent: number | null,
): Promise<number> {
  const clean = cleanName(name, "smart folder");
  const text = cleanName(query, "query");
  parse(text);

  const id = library.db.repo.nextSmartFolderId();
  await apply(library, [{ op: "smart_folder_create", id, parent, name: clean, query: text }]);
  return id;
}

export async function updateSmartFolder(
  library: Library,
  id: number,
  name: string,
  query: string,
): Promise<void> {
  const clean = cleanName(name, "smart folder");
  const text = cleanName(query, "query");
  parse(text);
  return apply(library, [{ op: "smart_folder_update", id, name: clean, query: text }]);
}

export async function deleteSmartFolder(library: Library, id: number): Promise<void> {
  return apply(library, [{ op: "smart_folder_delete", id }]);
}

/** Resolves a smart folder by name, oldest first where a name repeats. */
export function resolveSmartFolder(library: Library, name: string): number {
  const found = library.db.repo.findSmartFolderByName(name.trim());
  if (found === undefined) throw new UnknownSmartFolderError(name);
  return found.id;
}
