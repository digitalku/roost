import { extname } from "node:path";
import {
  type AssetId,
  type CommentRow,
  IndexSink,
  JOB_PRIORITY,
  type JournalRecord,
  logger,
  mintAssetId,
  type Op,
  type SubtitleRow,
  toNfc,
} from "@roost/core";
import { formatFromExtension, kindOf, PREVIEW_SIZE } from "@roost/media/serving";
import { parse } from "@roost/search";
import {
  AmbiguousFolderNameError,
  AmbiguousIdError,
  DuplicateFolderNameError,
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
import { childrenById, descendants } from "./folder-tree.js";
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
  await library.noteJournalAppended();

  log.debug("edits journalled and indexed", { ops: kinds(records) });
}

/** The distinct operation names in a batch, for the log line. */
function kinds(records: readonly JournalRecord[]): string {
  return [...new Set(records.map((record) => record.op))].sort().join(",");
}

/**
 * Resolves a full id or an unambiguous prefix to an asset.
 *
 * A prefix matching nothing and a prefix matching two assets are different
 * mistakes, so they raise different errors. The second must never quietly pick
 * one: the two are unrelated files.
 *
 * **Upper-cased, not lower-cased.** An id is Crockford base32 in upper case
 * (RL-14), so somebody typing one in lower case has typed the right id in the
 * wrong case rather than a different one — and the alphabet has no letter whose
 * case could make it ambiguous.
 */
export function resolveAsset(library: Library, needle: string): AssetId {
  const wanted = needle.trim().toUpperCase();
  if (wanted === "" || !/^[0-9A-HJKMNP-TV-Z]+$/.test(wanted)) throw new UnknownAssetError(needle);

  const found = library.db.repo.resolveIdPrefix(wanted);
  const [first] = found;
  if (first === undefined) throw new UnknownAssetError(needle);
  if (found.length > 1) throw new AmbiguousIdError(needle);
  return first;
}

function requireAsset(library: Library, id: AssetId): void {
  if (library.db.repo.findAsset(id) === undefined) throw new UnknownAssetError(id);
}

/**
 * A name on its way into the journal.
 *
 * Normalised to NFC here rather than at each caller, because this is the one
 * door every name a person typed comes through — a rename, a new file, a tag,
 * a folder. RL-36 binds filenames; the rest are normalised by the same hand
 * because a tag spelled two ways is two tags, and nothing downstream can tell
 * them apart either.
 */
function cleanName(name: string, what: string): string {
  const trimmed = toNfc(name.trim());
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

/**
 * Refuses a name a sibling already has.
 *
 * See {@link DuplicateFolderNameError}: two folders of one name under one
 * parent compile to the same `folder:` query, and `findFolderByPath` takes the
 * first row each segment matches — so one of them is unreachable. `except` is
 * the folder being renamed or moved, which is not its own sibling.
 *
 * Compared in memory rather than in SQL. `COLLATE NOCASE` folds ASCII only,
 * where the rule this follows is the Eagle importer's lowercased key; and the
 * repository returns the whole tree in one statement precisely so a caller can
 * walk it, the tree being small enough that a folder command can afford to.
 */
function requireUnusedName(
  library: Library,
  parent: number | null,
  name: string,
  except: number | null,
): void {
  const wanted = name.toLowerCase();
  for (const folder of library.db.repo.folders()) {
    if (folder.parentId !== parent || folder.id === except) continue;
    if (folder.name.toLowerCase() !== wanted) continue;
    throw new DuplicateFolderNameError(
      name,
      parent === null ? null : (library.db.repo.folder(parent)?.name ?? String(parent)),
    );
  }
}

function cleanNames(names: readonly string[], what: string): string[] {
  return names.map((name) => cleanName(name, what));
}

// --- Tags --------------------------------------------------------------------

export async function tagAdd(
  library: Library,
  assets: readonly AssetId[],
  tags: readonly string[],
): Promise<void> {
  const cleaned = cleanNames(tags, "tag");
  return apply(
    library,
    assets.map((hash) => {
      requireAsset(library, hash);
      return { op: "tag_add", asset: hash, tags: cleaned } as const;
    }),
  );
}

export async function tagRemove(
  library: Library,
  assets: readonly AssetId[],
  tags: readonly string[],
): Promise<void> {
  const cleaned = cleanNames(tags, "tag");
  return apply(
    library,
    assets.map((hash) => {
      requireAsset(library, hash);
      return { op: "tag_remove", asset: hash, tags: cleaned } as const;
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
  assets: readonly AssetId[],
  rating: number | null,
): Promise<void> {
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > MAX_RATING)) {
    throw new InvalidRatingError(rating);
  }
  return apply(
    library,
    assets.map((hash) => {
      requireAsset(library, hash);
      return { op: "rate", asset: hash, rating } as const;
    }),
  );
}

/**
 * `null` clears the note, and so does an all-whitespace one: storing that would
 * show an empty note badge on the asset forever.
 *
 * Several assets take one line each, in one batch (ADR-0048). Whether writing
 * over notes that differ is wanted is asked in the window, not here.
 */
export async function setNote(
  library: Library,
  assets: readonly AssetId[],
  note: string | null,
): Promise<void> {
  const trimmed = note === null ? null : note.trim();
  const value = trimmed === "" ? null : trimmed;
  return apply(
    library,
    assets.map((hash) => {
      requireAsset(library, hash);
      return { op: "note_set", asset: hash, note: value } as const;
    }),
  );
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
  assets: readonly AssetId[],
  url: string | null,
): Promise<void> {
  const trimmed = url === null ? null : url.trim();
  const value = trimmed === "" ? null : trimmed;
  return apply(
    library,
    assets.map((hash) => {
      requireAsset(library, hash);
      return { op: "source_set", asset: hash, url: value } as const;
    }),
  );
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
  hash: AssetId,
  atMs: number | null,
  body: string,
): Promise<number> {
  requireAsset(library, hash);
  const id = library.db.repo.nextCommentId();
  await apply(library, [
    { op: "comment_add", id, asset: hash, at: requireMoment(atMs), body: requireBody(body) },
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
 * frame, so the thumbnail comes back from `files/` plus the journal like
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
  hash: AssetId,
  atMs: number | null,
): Promise<boolean> {
  requireVideo(library, hash);
  const at = atMs === null ? null : requireMoment(atMs);
  if (library.db.repo.posterOf(hash) === at) return false;

  await apply(library, [{ op: "poster_set", asset: hash, at }]);
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
export function poster(library: Library, hash: AssetId): number | null {
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
function requireVideo(library: Library, hash: AssetId): void {
  const asset = library.db.repo.findAsset(hash);
  if (asset === undefined) throw new UnknownAssetError(hash);
  const kind = kindOf(formatFromExtension(asset.ext));
  if (kind !== "video") throw new NotAVideoError(hash, kind);
}

/** The comments on one asset, timed ones first and in timeline order. */
export function comments(library: Library, hash: AssetId): readonly CommentRow[] {
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
 * Renames what the library shows.
 *
 * The file on disk is named by the id (RL-9), so nothing under `files/` is
 * touched — a rename cannot fail on a locked file, an invalid character or a
 * path that grew too long, and it costs the same for one asset as for five
 * hundred. The name carries no extension (RL-33).
 */
export async function renameAsset(library: Library, hash: AssetId, name: string): Promise<void> {
  requireAsset(library, hash);
  return apply(library, [{ op: "asset_rename", asset: hash, name: cleanName(name, "name") }]);
}

/**
 * Moves assets to the trash (ADR-0022).
 *
 * What `Delete` means. The row and everything hanging off it stay — tags,
 * rating, note, folder memberships, thumbnail — and only what sees the asset
 * changes. Nothing on disk moves.
 *
 * Trashing something already in the trash is not an error: it re-stamps
 * `trashed_at` with the later time, which is what somebody who trashed,
 * restored, and trashed again would expect Trash to show.
 */
export async function trashAssets(library: Library, assets: readonly AssetId[]): Promise<void> {
  return apply(
    library,
    assets.map((hash) => {
      requireAsset(library, hash);
      return { op: "trash", asset: hash } as const;
    }),
  );
}

/** Brings assets back out of the trash. Restoring a live asset is a no-op. */
export async function restoreAssets(library: Library, assets: readonly AssetId[]): Promise<void> {
  return apply(
    library,
    assets.map((hash) => {
      requireAsset(library, hash);
      return { op: "restore", asset: hash } as const;
    }),
  );
}

/** What a removal took out of the library, and out of `files/`. */
export interface Removal {
  readonly assets: number;
  /**
   * Bytes deleted from `files/`.
   *
   * As far as anything knows: a size is derived (RL-22), so an asset nothing
   * has read yet counts nothing here even though its file is deleted. The
   * number is what was freed to the best of the index's knowledge, not a
   * measurement taken at the moment of deletion.
   */
  readonly bytes: number;
}

/**
 * Removes every trashed asset from the library, and answers with what went.
 *
 * "Empty trash" is {@link removeAssets} over what the trash holds, which is why
 * emptying needs no operation of its own: `remove` already means exactly this,
 * and giving the destructive case a second spelling would be two things to keep
 * in step. **There is no timer** — Eagle empties after thirty days, and an
 * application that deletes a person's files on a schedule, possibly while they
 * are not looking, is not one this project ships (ADR-0022).
 */
export async function emptyTrash(library: Library): Promise<Removal> {
  return removeAssets(library, library.db.repo.trashedIds());
}

/**
 * Removes assets from the library, and deletes the bytes they own.
 *
 * Not what `Delete` does — see {@link trashAssets}. This is what "Empty trash"
 * and "Delete permanently" send, and what `roost remove` has always done.
 *
 * **The file goes with the row** (ADR-0031, amending ADR-0022 §"What
 * already exists"). It did not until 2026-09-06: the bytes stayed until someone
 * ran `roost doctor --reclaim`, on the reasoning that deleting a person's only
 * copy should not be a side effect of a metadata edit. That reasoning survives
 * for every *other* removal and is why the reclaim step still exists — but this
 * one is not a side effect. It is a gesture called "Delete permanently", after
 * a confirmation, on an asset already in the trash; a user who does that and
 * finds their disk no smaller has been told something untrue.
 *
 * **There is one storage mode** (RL-19), so there is nothing to spare and no
 * user directory to stay out of: every asset's bytes are inside the library,
 * and the row and the file go together.
 *
 * Order matters: journal, then index, then bytes. A crash between the last two
 * leaves an object nothing references, which `roost doctor` reports and
 * `--reclaim` collects. The reverse order would delete bytes for a removal no
 * replay knows about.
 */
export async function removeAssets(library: Library, assets: readonly AssetId[]): Promise<Removal> {
  // Read where the bytes are before deleting the rows that say so.
  const files = assets.map((id) => {
    const record = library.db.repo.findFile(id);
    if (record === undefined) throw new UnknownAssetError(id);
    return { id, ext: record.ext, size: record.size };
  });

  await apply(
    library,
    files.map(({ id }) => ({ op: "remove", asset: id }) as const),
  );

  const storage = library.storage;
  let bytes = 0;
  for (const file of files) {
    await storage.remove(file.id, file.ext);
    bytes += file.size ?? 0;
  }
  return { assets: files.length, bytes };
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
  requireUnusedName(library, parent, clean, null);
  const id = library.db.repo.nextFolderId();
  await apply(library, [{ op: "folder_create", id, parent, name: clean }]);
  return id;
}

export async function renameFolder(library: Library, id: number, name: string): Promise<void> {
  requireFolder(library, id);
  const clean = cleanFolderName(name);
  // Against its own siblings, and it is not one of them: renaming a folder to
  // the case it already has has to stay a thing that works.
  requireUnusedName(library, library.db.repo.folder(id)?.parentId ?? null, clean, id);
  return apply(library, [{ op: "folder_rename", id, name: clean }]);
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
    if (library.db.repo.folderIsWithin(parent, id)) {
      throw new FolderCycleError(
        id,
        parent,
        library.db.repo.folder(id)?.name ?? String(id),
        library.db.repo.folder(parent)?.name ?? String(parent),
      );
    }
  }
  // A move carries the name into a place that may already hold it. Refused
  // here rather than silently renamed: the destination is the user's choice
  // and so is the name, and a move that quietly changes one is not a move.
  requireUnusedName(library, parent, library.db.repo.folder(id)?.name ?? "", id);
  return apply(library, [{ op: "folder_move", id, parent }]);
}

/** What deleting a folder did (ADR-0033). */
export interface FolderDeletion {
  /** How many assets went to the trash with it. Zero unless it was asked for. */
  readonly trashed: number;
}

/**
 * Deletes a folder, its descendants, and every membership in them.
 *
 * **The assets stay in the library by default** — folders are collections, not
 * locations, so deleting one is a change to the shelf and not to what was on
 * it. `trashContents` is the second, deliberate gesture (ADR-0033): every live
 * asset in the subtree goes to the trash first, in the **same journal batch**,
 * so a replay cannot land on a state where the folder is gone and its contents
 * were spared, or the reverse.
 *
 * Trashed and not removed, because the trash is what reversible means here
 * (ADR-0022) — the folder does not come back, but everything that was in it
 * does. An asset in another folder as well is trashed like any other: what was
 * asked for is the contents of this one, and the trash keeps every membership
 * it had.
 */
export async function deleteFolder(
  library: Library,
  id: number,
  { trashContents = false }: { readonly trashContents?: boolean } = {},
): Promise<FolderDeletion> {
  requireFolder(library, id);

  const subtree = trashContents ? descendants(childrenById(library.db.repo.folders()), [id]) : [];
  const held = subtree.length === 0 ? [] : library.db.repo.assetsInFolders(subtree);

  // Trash before delete, and in one batch: after the folder is gone there is
  // nothing left saying what was in it, so a second call could not find them.
  await apply(library, [
    ...held.map((hash) => ({ op: "trash", asset: hash }) as const),
    { op: "folder_delete", id },
  ]);
  return { trashed: held.length };
}

export async function addToFolder(
  library: Library,
  assets: readonly AssetId[],
  folder: number,
): Promise<void> {
  requireFolder(library, folder);
  return apply(
    library,
    assets.map((hash) => {
      requireAsset(library, hash);
      return { op: "folder_add", asset: hash, folder } as const;
    }),
  );
}

export async function removeFromFolder(
  library: Library,
  assets: readonly AssetId[],
  folder: number,
): Promise<void> {
  requireFolder(library, folder);
  return apply(
    library,
    assets.map((hash) => ({ op: "folder_remove", asset: hash, folder }) as const),
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
 * Saves edited bytes over the asset's own file (ADR-0046, superseding
 * ADR-0026).
 *
 * **A save is a write now.** Identity is an id (RL-13), and the bytes under it
 * are allowed to change at any time (RL-20) — so editing a file produces the
 * same asset, keeps its tags, its folders, its rating, its note, its comments
 * and its place in every list, and **journals nothing at all** (RL-23). What
 * version 1 needed for this — a second `add`, a carry-over of everything a
 * person had written, and a `supersede` chain — is gone with the decision that
 * made it necessary.
 *
 * What it does instead is forget what was derived from the old bytes: the size,
 * the hash, the dimensions and every thumbnail describe a file that no longer
 * exists, and a cell drawn from one of them would be a picture of the past. The
 * derive is queued at interactive priority, because somebody is looking at it.
 *
 * Two refusals, each for a reason that is not a policy choice: a **trashed**
 * asset, because editing something in the trash is a gesture with no meaning
 * until it is restored; and anything over {@link MAX_EDIT_BYTES}, because a
 * partial read must never be saved over a whole file.
 */
export async function saveEdit(library: Library, id: AssetId, bytes: Uint8Array): Promise<void> {
  const before = library.db.repo.assetDetail(id);
  if (before === undefined) throw new UnknownAssetError(id);
  if (before.trashedAt !== null) {
    throw new NotEditableError(id, "it is in the trash — restore it first");
  }
  if (bytes.length > MAX_EDIT_BYTES) {
    throw new EditTooLargeError(bytes.length, MAX_EDIT_BYTES);
  }

  await library.storage.writeBytes(bytes, id, before.ext);

  // Nothing is appended to the journal, so nothing here can be "journal first":
  // the index is a cache of what the bytes are, and this is the cache being
  // told it is stale. A crash before the derive runs leaves an asset with no
  // size and no thumbnail, which the next sweep fixes — the shape every derived
  // column is allowed to fail in.
  library.db.transaction(() => {
    library.db.repo.clearDerived(id);
    library.db.repo.dropThumbnails(id);
  });
  enqueueDerives(library, [id], JOB_PRIORITY.interactive);

  log.info("asset edited in place", { asset: id, bytes: bytes.length });
}

/**
 * Creates an asset from bytes the application produced, under a name the user
 * chose.
 *
 * The window's **New File**: a draft is a name and a buffer until it is saved,
 * and this is the save. It is not an import — there is no source file, and the
 * name is not a filename anything found on disk — but the record it writes is
 * the ordinary `add`, so nothing downstream has to know where the bytes came
 * from.
 *
 * **Every call makes an asset**, including two empty files in a row. Version 1
 * could not: every empty file had one hash and the hash was the primary key, so
 * the second answered with the first, under the first one's name. An id is
 * minted rather than derived (RL-13), so two files a person made deliberately
 * are two assets — which is what they asked for both times.
 */
export async function createAsset(
  library: Library,
  name: string,
  bytes: Uint8Array,
): Promise<AssetId> {
  const clean = cleanName(name, "file");
  if (bytes.length > MAX_EDIT_BYTES) throw new EditTooLargeError(bytes.length, MAX_EDIT_BYTES);

  // The importer's rule, spelled the same way: the **last** extension
  // component, lowercased, without the dot, so `notes.tar.gz` is `<id>.gz` and
  // a name with no extension is a bare id with no trailing dot (RL-9, RL-9a).
  const ext = extname(clean).replace(/^\./, "").toLowerCase();
  const display = ext === "" ? clean : clean.slice(0, clean.length - ext.length - 1);

  const id = mintAssetId((candidate) => library.db.repo.hasAsset(candidate));
  await library.storage.writeBytes(bytes, id, ext);

  // Field by field rather than by spreading: an object carrying `undefined`
  // serialises differently from one missing the key (`op.ts`). Nothing about
  // the bytes is here — the size and the hash are derived (RL-22), and the
  // derive queued below is what learns them.
  const add: Record<string, unknown> = { op: "add", id, ext, name: display };

  await apply(library, [add as unknown as Op]);
  enqueueDerives(library, [id], JOB_PRIORITY.interactive);

  log.info("asset created from bytes", { asset: id, size: bytes.length });
  return id;
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
  hash: AssetId,
  track: AssetId,
  options: { readonly lang?: string; readonly label?: string } = {},
): Promise<void> {
  requireAsset(library, hash);
  requireAsset(library, track);
  if (hash === track) throw new NotEditableError(hash, "an asset cannot caption itself");

  const op: Record<string, unknown> = { op: "subtitle_attach", asset: hash, track };
  const lang = options.lang?.trim();
  if (lang !== undefined && lang !== "") op["lang"] = lang;
  const label = options.label?.trim();
  if (label !== undefined && label !== "") op["label"] = label;

  return apply(library, [op as unknown as Op]);
}

/** Un-says it. Both assets stay; only the sentence goes. */
export async function detachSubtitle(
  library: Library,
  hash: AssetId,
  track: AssetId,
): Promise<void> {
  requireAsset(library, hash);
  return apply(library, [{ op: "subtitle_detach", asset: hash, track }]);
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
  hash: AssetId,
  track: AssetId,
): Promise<void> {
  requireAsset(library, hash);
  requireAsset(library, track);
  return apply(library, [
    { op: "subtitle_detach", asset: hash, track },
    { op: "trash", asset: track },
  ]);
}

/** The caption tracks attached to an asset, in the order they were attached. */
export function subtitles(library: Library, hash: AssetId): SubtitleRow[] {
  requireAsset(library, hash);
  return library.db.repo.subtitlesFor(hash);
}
