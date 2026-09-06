import { extname } from "node:path";
import {
  type AssetDetail,
  type CommentRow,
  type ContentHash,
  IndexSink,
  JOB_PRIORITY,
  type JournalRecord,
  logger,
  type Op,
  type SubtitleRow,
} from "@roost/core";
import { hashBytes } from "@roost/media";
import { formatFromExtension, kindOf, PREVIEW_SIZE } from "@roost/media/serving";
import { parse } from "@roost/search";
import {
  AmbiguousFolderNameError,
  AmbiguousHashError,
  EditTooLargeError,
  EmptyCommentError,
  EmptyNameError,
  FolderCycleError,
  InvalidMomentError,
  InvalidRatingError,
  NotAVideoError,
  NotEditableError,
  UnknownAssetError,
  UnknownCommentError,
  UnknownFolderError,
  UnknownFolderPathError,
  UnknownSmartFolderError,
  UnknownTagGroupError,
} from "./error.js";
import { enqueueDerives } from "./jobs.js";
import { type Library, nowUnix } from "./library.js";
import { redrawPoster } from "./thumbnails.js";

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

/**
 * Where the file came from (ADR-0030).
 *
 * `null` clears it, and so does an all-whitespace value — the rule
 * {@link setNote} follows, for the same reason: a stored blank would show an
 * empty link on the asset forever.
 *
 * **Nothing is validated beyond that.** Roost does not parse the value, does
 * not normalise it, and does not require a scheme: `file:///archive/2019/` and
 * a bare `instagram.com/p/xyz` are both answers to the question that was asked,
 * and refusing them would be an application arguing with the user about what
 * provenance is. Whether a value is offered as a *link* is decided where it is
 * shown, from its scheme (ADR-0030 §5).
 */
export async function setSource(
  library: Library,
  hash: ContentHash,
  url: string | null,
): Promise<void> {
  requireAsset(library, hash);
  const trimmed = url === null ? null : url.trim();
  return apply(library, [{ op: "source_set", hash, url: trimmed === "" ? null : trimmed }]);
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

/**
 * Pins a video's thumbnail to a moment, or lets it go back to the default
 * (ADR-0024 stage 4).
 *
 * **The journal records where to look, never the pixels.** A rebuild replays
 * `poster_set` into `assets.poster_ms` and the derive pass re-extracts the
 * frame, so the thumbnail comes back from `originals/` plus the journal like
 * every other derived artefact (invariant 1). Storing the image would be base64
 * in a text file, which the forbidden-patterns list refuses twice over.
 *
 * The picture is not made here. This queues the derive at interactive priority
 * and drops the preview-size thumbnail, which is generated on first use and
 * would otherwise outlive the frame it was drawn from; whoever works the queue
 * — the engine in the background, `roost thumb` from a terminal — replaces the
 * grid size. That is the same path a rebuild takes, which is why there is only
 * one of it.
 *
 * Answers whether anything was written: pinning the moment it is already pinned
 * to, or clearing one nobody set, journals nothing. An append-only file is read
 * by people, and a line that changes nothing is a line they have to rule out.
 */
export async function setPoster(
  library: Library,
  hash: ContentHash,
  atMs: number | null,
): Promise<boolean> {
  requireVideo(library, hash);
  const at = atMs === null ? null : requireMoment(atMs);
  if (library.db.repo.posterOf(hash) === at) return false;

  await apply(library, [{ op: "poster_set", hash, at }]);
  // Dropped before anything else: the preview size is made on first use and
  // never revisited, so one left behind would outlive the frame it was drawn
  // from if the redraw below cannot run.
  library.db.repo.dropThumbnail(hash, PREVIEW_SIZE);
  if (!(await redrawPoster(library, hash))) {
    // No ffmpeg, or an original that moved. The queue reads the same column, so
    // the picture arrives whenever it can rather than not at all.
    enqueueDerives(library, [hash], JOB_PRIORITY.interactive);
  }
  return true;
}

/** The moment a thumbnail is pinned to, or `null` for the default frame. */
export function poster(library: Library, hash: ContentHash): number | null {
  requireAsset(library, hash);
  return library.db.repo.posterOf(hash);
}

/**
 * An asset with frames to choose between.
 *
 * The kind comes from the format table rather than from a column, exactly as
 * the window's does: `@roost/media` owns that table, and a second answer here
 * would disagree with the inspector the first time a format is added.
 */
function requireVideo(library: Library, hash: ContentHash): void {
  const asset = library.db.repo.findAsset(hash);
  if (asset === undefined) throw new UnknownAssetError(hash);
  const kind = kindOf(formatFromExtension(asset.ext));
  if (kind !== "video") throw new NotAVideoError(hash, kind);
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

/**
 * The most an edit may carry, and the window a text asset is read through.
 *
 * **One number on purpose** (`error.ts`, {@link EditTooLargeError}): saving
 * what was only partly read would discard everything past the window, which is
 * the one way editing could destroy a file rather than replace it. The renderer
 * reads the same constant over the contract so the two cannot drift.
 */
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;

/**
 * Saves edited bytes as a **new asset**, and marks the old one superseded
 * (ADR-0026).
 *
 * A save cannot be a write here: identity is the content hash, so changed bytes
 * are a different asset at a different address. What travels is everything a
 * person authored — tags, folders, rating, note, favourite, the pinned poster
 * moment, and the comments — each through the operation that owns it, so a
 * rebuild reconstructs the carry-over from the journal rather than from this
 * function.
 *
 * Answers the new hash, which is the old one when the bytes did not change.
 *
 * Three things it refuses, each for a reason that is not a policy choice:
 * a **referenced** asset, because its bytes are in a user directory and
 * invariant 6 forbids writing there; a **trashed** asset, because superseding
 * it would produce a live replacement and make editing a way of undeleting; and
 * anything over {@link MAX_EDIT_BYTES}, because a partial read must never be
 * saved over a whole file.
 */
export async function saveEdit(
  library: Library,
  hash: ContentHash,
  bytes: Uint8Array,
): Promise<ContentHash> {
  const before = library.db.repo.assetDetail(hash);
  if (before === undefined) throw new UnknownAssetError(hash);
  if (before.storageMode === "referenced") {
    throw new NotEditableError(hash, "it lives in your own directory and Roost never writes there");
  }
  if (before.trashedAt !== null) {
    throw new NotEditableError(hash, "it is in the trash — restore it first");
  }
  if (bytes.length > MAX_EDIT_BYTES) {
    throw new EditTooLargeError(bytes.length, MAX_EDIT_BYTES);
  }

  const hashed = hashBytes(bytes);
  // Saving without changing anything writes nothing. An append-only journal is
  // read by people, and `supersede` pointing an asset at itself is both a lie
  // and a cycle.
  if (hashed.hash === hash) return hash;

  const placed = await library.storageFor("managed").putBytes(bytes, hashed.hash, before.ext);
  const ops: Op[] = [];

  // The replacement may already exist — editing a file into exactly the
  // contents of another one is dedupe, not a collision, and the `add` would be
  // a second line for a row that is already there.
  if (library.db.repo.findAsset(hashed.hash) === undefined) {
    const add: Record<string, unknown> = {
      op: "add",
      hash: hashed.hash,
      ext: before.ext,
      size: hashed.size,
      name: before.origName,
      mode: "managed",
    };
    if (placed.linkMethod !== null) add["link"] = placed.linkMethod;
    if (hashed.isPartial) add["partial"] = true;
    ops.push(add as unknown as Op);
  }

  ops.push(...carryOver(library, before, hashed.hash));
  ops.push({ op: "supersede", hash, to: hashed.hash });

  await apply(library, ops);
  enqueueDerives(library, [hashed.hash], JOB_PRIORITY.interactive);

  log.info("asset superseded by an edit", { from: hash, to: hashed.hash, ops: ops.length });
  return hashed.hash;
}

/**
 * Everything user-authored on `before`, spelled as operations against `to`.
 *
 * Each goes through the op that owns it rather than through a copy in SQL,
 * because the journal is the record and the index is derived from it: a
 * carry-over the journal does not describe would vanish on the next rebuild
 * (invariant 1).
 *
 * **A comment is copied, not moved.** The old version keeps its own — it is
 * still a row somebody can open — so the copies are new rows with new ids, and
 * their `created_at` is the time of the save rather than of the original
 * remark. That is the cost of a comment being about *an asset* rather than
 * about a lineage, and it is cheaper than the alternative, which is a comment
 * that belongs to two assets and can be edited from either.
 */
function carryOver(library: Library, before: AssetDetail, to: ContentHash): Op[] {
  const repo = library.db.repo;
  const ops: Op[] = [];

  if (before.tags.length > 0) ops.push({ op: "tag_add", hash: to, tags: before.tags });
  for (const folder of repo.folderIdsFor(before.hash)) {
    ops.push({ op: "folder_add", hash: to, folder });
  }
  if (before.rating !== null) ops.push({ op: "rate", hash: to, rating: before.rating });
  if (before.note !== null) ops.push({ op: "note_set", hash: to, note: before.note });
  // Superseding does not change where the bytes originally came from.
  if (before.sourceUrl !== null) {
    ops.push({ op: "source_set", hash: to, url: before.sourceUrl });
  }
  // Carried even though nothing can set one any more (ADR-0029): an asset that
  // *has* a favourite from before it was retired keeps it across an edit, or
  // `is:favorite` would quietly stop finding a file somebody edited.
  if (before.isFavorite) ops.push({ op: "favorite_set", hash: to, favorite: true });
  if (before.posterMs !== null) ops.push({ op: "poster_set", hash: to, at: before.posterMs });

  let id = repo.nextCommentId();
  for (const comment of repo.commentsFor(before.hash)) {
    ops.push({ op: "comment_add", id, hash: to, at: comment.atMs, body: comment.body });
    id += 1;
  }

  return ops;
}

/**
 * Points one asset at the version that replaced it, or clears the mark.
 *
 * The operation behind {@link saveEdit}, exposed on its own so the CLI can
 * record a supersession the window would have made — and so undoing one is the
 * same op with `to` absent, rather than a second operation meaning the reverse.
 */
export async function supersedeAsset(
  library: Library,
  hash: ContentHash,
  to: ContentHash | null,
): Promise<void> {
  requireAsset(library, hash);
  if (to !== null) {
    requireAsset(library, to);
    if (to === hash) throw new NotEditableError(hash, "an asset cannot supersede itself");
  }
  return apply(library, [{ op: "supersede", hash, to }]);
}

/**
 * Creates an asset from bytes the application produced, under a name the user
 * chose (ADR-0026 §4).
 *
 * The window's **New File**: a draft is a name and a buffer until it is saved,
 * and this is the save. It is not an import — there is no source file, and the
 * name is not a filename anything found on disk — but the record it writes is
 * the ordinary `add`, so nothing downstream has to know where the bytes came
 * from.
 *
 * Answers the hash and whether it is new.
 *
 * **An empty file is allowed, and there can only ever be one.** Every empty
 * file has the same BLAKE3 hash and `assets.hash` is the primary key, so the
 * second one made answers with the first — under the first one's name, because
 * that is the one somebody has been using. Refusing instead was tried on
 * 2026-09-03 and withdrawn on 2026-09-05: the caller asks for a file with a
 * name, and it is the caller's business what it holds.
 *
 * Identical bytes are one asset by invariant 1, so writing a file that already
 * exists answers with it and `created: false` rather than a second row. The
 * name of the one already there wins, because it is the one somebody has been
 * using.
 */
export async function createAsset(
  library: Library,
  name: string,
  bytes: Uint8Array,
): Promise<{ readonly hash: ContentHash; readonly created: boolean }> {
  const clean = cleanName(name, "file");
  if (bytes.length > MAX_EDIT_BYTES) throw new EditTooLargeError(bytes.length, MAX_EDIT_BYTES);

  // The importer's rule, spelled the same way: the **last** extension
  // component, lowercased, without the dot, so `notes.tar.gz` is `<hash>.gz`
  // and a name with no extension is a bare hash with no trailing dot. One
  // asset must not reach two addresses depending on which door it came in by.
  const ext = extname(clean).replace(/^\./, "").toLowerCase();
  const hashed = hashBytes(bytes);

  const existing = library.db.repo.findAsset(hashed.hash);
  if (existing !== undefined) return { hash: hashed.hash, created: false };

  const placed = await library.storageFor("managed").putBytes(bytes, hashed.hash, ext);
  const add: Record<string, unknown> = {
    op: "add",
    hash: hashed.hash,
    ext,
    size: hashed.size,
    name: clean,
    mode: "managed",
  };
  if (placed.linkMethod !== null) add["link"] = placed.linkMethod;
  if (hashed.isPartial) add["partial"] = true;

  await apply(library, [add as unknown as Op]);
  enqueueDerives(library, [hashed.hash], JOB_PRIORITY.interactive);

  log.info("asset created from bytes", { hash: hashed.hash, size: hashed.size });
  return { hash: hashed.hash, created: true };
}

/**
 * Says that one asset captions another (ADR-0025).
 *
 * The attachment is user-authored — nothing in either file's bytes implies it —
 * so it is a journal line before it is a row (invariant 9). Attaching the same
 * pair again updates the language and label rather than adding a second row:
 * the primary key is the pair, and saying it twice is one sentence said twice.
 *
 * **The track leaves the grid**, because an attached subtitle is part of a
 * video rather than a thing to browse. `is:subtitle` finds it again, and
 * detaching makes it an ordinary text asset once more.
 */
export async function attachSubtitle(
  library: Library,
  hash: ContentHash,
  track: ContentHash,
  options: { readonly lang?: string; readonly label?: string } = {},
): Promise<void> {
  requireAsset(library, hash);
  requireAsset(library, track);
  if (hash === track) throw new NotEditableError(hash, "an asset cannot caption itself");

  const op: Record<string, unknown> = { op: "subtitle_attach", hash, track };
  const lang = options.lang?.trim();
  if (lang !== undefined && lang !== "") op["lang"] = lang;
  const label = options.label?.trim();
  if (label !== undefined && label !== "") op["label"] = label;

  return apply(library, [op as unknown as Op]);
}

/** Un-says it. Both assets stay; only the sentence goes. */
export async function detachSubtitle(
  library: Library,
  hash: ContentHash,
  track: ContentHash,
): Promise<void> {
  requireAsset(library, hash);
  return apply(library, [{ op: "subtitle_detach", hash, track }]);
}

/**
 * Detaches a caption track **and** moves it to the trash, in one batch
 * (ADR-0025, ADR-0022).
 *
 * What the inspector's **Delete** sends. Two operations rather than one,
 * because they say different things — the attachment stops being true, and the
 * file stops being in the library — but one journal batch, so they can never be
 * half done: a trashed asset still attached would be a caption track nobody can
 * see and nothing can find.
 *
 * **Trash, not `remove`.** `Delete` means the same thing everywhere in Roost:
 * the row is kept, everything hanging off it is kept, and nothing is ever
 * emptied on a schedule. Restoring it from the Trash brings the file back — the
 * attachment does not come with it, because that was a second sentence and it
 * was un-said.
 */
export async function deleteSubtitle(
  library: Library,
  hash: ContentHash,
  track: ContentHash,
): Promise<void> {
  requireAsset(library, hash);
  requireAsset(library, track);
  return apply(library, [
    { op: "subtitle_detach", hash, track },
    { op: "trash", hash: track },
  ]);
}

/** The caption tracks attached to an asset, in the order they were attached. */
export function subtitles(library: Library, hash: ContentHash): SubtitleRow[] {
  requireAsset(library, hash);
  return library.db.repo.subtitlesFor(hash);
}
