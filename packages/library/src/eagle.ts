import { opendir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { type ContentHash, logger, type Op, type StorageMode } from "@roost/core";
import {
  apply,
  comments as commentsOn,
  createFolder,
  createTagGroup,
  setTagGroup,
} from "./edit.js";
import { NotAnEagleLibraryError } from "./error.js";
import { type ImportFailure, importInto } from "./import.js";
import type { Library } from "./library.js";
import { isSubtitlePath } from "./subtitles.js";

/**
 * Reading an Eagle library and translating it into this one (ADR-0032).
 *
 * Eagle's model and Roost's agree almost everywhere: folders are collections in
 * both, tags are flat in both, and every field an item carries lands on an
 * operation this build already writes. So there is no new journal op here, no
 * migration, and no schema change — this module is a translation, and the
 * result is an ordinary library that rebuilds from its journal like any other.
 *
 * **The Eagle library is opened read-only.** Nothing is written into it and
 * nothing is moved out of it; it is intact and openable in Eagle afterwards.
 */

const log = logger("eagle");

/** Eagle stores each item in `images/<id>.info/`. */
const ITEM_SUFFIX = ".info";

/**
 * Items whose bytes are imported before their metadata is applied.
 *
 * The two phases cannot merge: a `tag_add` for an asset the index does not hold
 * yet is a foreign-key violation, and the import pipeline commits in batches of
 * its own. Chunking keeps memory flat over a library of any size — only the
 * chunk's items and their path-to-hash mapping are ever resident.
 */
const CHUNK = 200;

/** A comment in Eagle, already converted to Roost's units. */
export interface EagleComment {
  /**
   * Milliseconds into the medium.
   *
   * Eagle's field for this is called `duration` and holds **float seconds** —
   * it is a position, not a length, whatever the name says.
   */
  readonly atMs: number;
  readonly body: string;
}

/** One item, as far as this importer reads it. */
export interface EagleItem {
  readonly id: string;
  readonly name: string;
  /** Lowercased, no dot. Empty for a file with no extension. */
  readonly ext: string;
  /** Eagle's own byte count, used for the survey's total. */
  readonly size: number;
  readonly tags: readonly string[];
  /** Eagle folder ids, resolved against the tree in the root `metadata.json`. */
  readonly folders: readonly string[];
  readonly trashed: boolean;
  /** The page it came from, or `undefined`. Eagle writes `""` for absent. */
  readonly url: string | undefined;
  /** Eagle calls the note `annotation`. A comment's body has the same key. */
  readonly note: string | undefined;
  /** 1–5, or `undefined`. **Eagle omits the field entirely when unrated.** */
  readonly star: number | undefined;
  readonly comments: readonly EagleComment[];
}

/** A folder in Eagle's tree. Nesting is `children`, not a path. */
export interface EagleFolder {
  readonly id: string;
  readonly name: string;
  readonly children: readonly EagleFolder[];
}

/** A tag group. Eagle groups tags without changing what a tag means, as Roost does. */
export interface EagleTagGroup {
  readonly name: string;
  readonly tags: readonly string[];
}

/** What the root `metadata.json` holds. */
export interface EagleRoot {
  /** Eagle's `applicationVersion`, reported so a surprise is attributable. */
  readonly version: string;
  readonly folders: readonly EagleFolder[];
  readonly tagGroups: readonly EagleTagGroup[];
}

/** A folder whose name could not be carried across verbatim. */
export interface FolderRename {
  readonly from: string;
  readonly to: string;
}

/**
 * What an Eagle library contains, without importing any of it.
 *
 * Costs one small read per item and no hashing, so it stays fast on a library
 * far too large to import while somebody watches.
 */
export interface EagleSurvey {
  readonly version: string;
  readonly items: number;
  /** Eagle's own total, which is what the survey can know without hashing. */
  readonly bytes: number;
  readonly folders: number;
  readonly tagGroups: number;
  /** Every tag any item carries, sorted. Eagle's `tags.json` is not this list. */
  readonly tags: readonly string[];
  readonly rated: number;
  readonly notes: number;
  readonly sources: number;
  readonly comments: number;
  readonly subtitles: number;
  readonly trashed: number;
  readonly renamedFolders: readonly FolderRename[];
  /** Items whose original file is not where the metadata says it is. */
  readonly missing: readonly string[];
  /** Item directories whose `metadata.json` could not be read or understood. */
  readonly unreadable: readonly string[];
}

/** What an import did. Every number is what was actually written. */
export interface EagleReport {
  readonly survey: EagleSurvey;
  /** Assets the items resolved to — lower than `survey.items` when bytes repeat. */
  readonly assets: number;
  readonly imported: number;
  readonly duplicates: number;
  /**
   * Items that landed on an asset another item in this run had already claimed.
   *
   * Eagle identifies an item by id and Roost by content hash, so identical
   * bytes are one asset here. Counted and reported, because otherwise a lower
   * asset count than item count reads as data loss.
   */
  readonly collapsed: number;
  readonly folders: number;
  readonly tagGroups: number;
  readonly tagged: number;
  readonly ratings: number;
  readonly notes: number;
  readonly sources: number;
  readonly comments: number;
  readonly trashed: number;
  readonly subtitles: number;
  readonly bytes: number;
  readonly elapsed: number;
  readonly failed: readonly ImportFailure[];
}

export interface EagleImportOptions {
  /**
   * Defaults to `managed`, and that default is the point (ADR-0032 §5):
   * referenced would leave every asset pointing into the Eagle library, so
   * deleting it afterwards would empty Roost.
   */
  readonly mode?: StorageMode;
  /**
   * Applied to every asset this run resolves, alongside the item's own tags.
   *
   * Applied here rather than through the import pipeline's `tags`, which only
   * reaches files it newly imported: an item whose bytes the library already
   * held is still part of the migration, and marking half of it would be worse
   * than marking none.
   */
  readonly tags?: readonly string[];
}

// --- Reading -----------------------------------------------------------------

/**
 * Reads the root `metadata.json`: the folder tree and the tag groups.
 *
 * Raises {@link NotAnEagleLibraryError} rather than reporting an empty library,
 * because a survey full of zeroes and a wrong directory look identical.
 */
export async function readEagleRoot(root: string): Promise<EagleRoot> {
  const raw = await readFile(join(root, "metadata.json"), "utf8").catch(() => undefined);
  if (raw === undefined) throw new NotAnEagleLibraryError(root, "metadata.json");

  const parsed = asRecord(parseJson(raw));
  if (parsed === undefined) throw new NotAnEagleLibraryError(root, "readable metadata.json");

  const images = await stat(join(root, "images")).catch(() => undefined);
  if (images?.isDirectory() !== true) throw new NotAnEagleLibraryError(root, "images/");

  return {
    version: asString(parsed["applicationVersion"]) ?? "unknown",
    folders: parseFolders(parsed["folders"]),
    tagGroups: parseTagGroups(parsed["tagsGroups"]),
  };
}

/** One item on disk: its metadata, its original, and any subtitle beside it. */
interface EagleEntry {
  readonly item: EagleItem;
  readonly dir: string;
  /** `undefined` when the file the metadata names is not there. */
  readonly file: string | undefined;
  readonly subtitles: readonly string[];
}

/**
 * Streams every item in `images/`, in directory order.
 *
 * An async generator rather than a list: an Eagle library can hold as many
 * items as Roost can hold assets, and neither the survey nor the import needs
 * more than one chunk of them resident (`CLAUDE.md` §8).
 */
async function* eagleEntries(root: string): AsyncGenerator<EagleEntry | { readonly bad: string }> {
  const dir = await opendir(join(root, "images")).catch(() => undefined);
  if (dir === undefined) return;

  for await (const child of dir) {
    if (!child.isDirectory() || !child.name.endsWith(ITEM_SUFFIX)) continue;
    const itemDir = join(root, "images", child.name);

    const raw = await readFile(join(itemDir, "metadata.json"), "utf8").catch(() => undefined);
    const item = raw === undefined ? undefined : parseItem(parseJson(raw));
    if (item === undefined) {
      yield { bad: itemDir };
      continue;
    }

    yield { ...(await filesIn(itemDir, item)), item, dir: itemDir };
  }
}

/**
 * Picks the original out of an item directory, and any subtitle beside it.
 *
 * One `opendir` rather than a `stat` per guess, because the directory has to be
 * read anyway to find a `.srt` that no Eagle metadata mentions — which is
 * exactly the convention ADR-0025 kept as a heuristic.
 *
 * Eagle's own thumbnail is `<name>_thumbnail.png`, and it is matched against
 * *this item's* name rather than by the suffix alone: a user's file genuinely
 * called `chart_thumbnail.png` is an original, not a derived preview.
 */
async function filesIn(
  itemDir: string,
  item: EagleItem,
): Promise<{ file: string | undefined; subtitles: string[] }> {
  const dir = await opendir(itemDir).catch(() => undefined);
  if (dir === undefined) return { file: undefined, subtitles: [] };

  const wanted = item.ext === "" ? item.name : `${item.name}.${item.ext}`;
  const thumbnail = `${item.name}_thumbnail`;
  const subtitles: string[] = [];
  const candidates: string[] = [];

  for await (const child of dir) {
    if (!child.isFile()) continue;
    if (child.name === "metadata.json") continue;
    if (basename(child.name, extname(child.name)) === thumbnail) continue;

    const path = join(itemDir, child.name);
    if (isSubtitlePath(path)) subtitles.push(path);
    else if (child.name === wanted) candidates.unshift(path);
    else candidates.push(path);
  }

  return { file: candidates[0], subtitles };
}

// --- Parsing -----------------------------------------------------------------

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Trimmed, empty dropped, duplicates dropped, order kept. */
function asNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of value) {
    const name = asString(entry)?.trim();
    if (name === undefined || name === "") continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/** A string that is meaningful, treating Eagle's `""` as absent. */
function asText(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  return text === undefined || text === "" ? undefined : text;
}

function parseFolders(value: unknown): EagleFolder[] {
  if (!Array.isArray(value)) return [];
  const folders: EagleFolder[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const id = asString(record["id"]);
    const name = asText(record["name"]);
    if (id === undefined || name === undefined) continue;
    folders.push({ id, name, children: parseFolders(record["children"]) });
  }
  return folders;
}

/**
 * Tag groups, read defensively.
 *
 * The library this was written against had none, so the shape is honoured
 * rather than trusted: a group with no name or no tags is skipped instead of
 * producing an empty group in the sidebar.
 */
function parseTagGroups(value: unknown): EagleTagGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: EagleTagGroup[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const name = asText(record["name"]);
    const tags = asNames(record["tags"]);
    if (name === undefined || tags.length === 0) continue;
    groups.push({ name, tags });
  }
  return groups;
}

/**
 * One item's `metadata.json`.
 *
 * Four of Eagle's conventions are load-bearing here and none of them are
 * guessable:
 *
 * - `star` is **omitted** when the item is unrated, so absent is `NULL` and not
 *   zero — writing a `rate` for every item would invent thirteen ratings in a
 *   library that has one.
 * - `annotation` is the *note* on an item and the *body* inside a comment.
 * - a comment's `duration` is a position in float seconds, not a length.
 * - `palettes` is not read at all: it has nowhere to go, and it arrives with
 *   AngularJS internals (`$$hashKey`) that leaked to disk.
 */
function parseItem(value: unknown): EagleItem | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;

  const id = asString(record["id"]);
  const name = asText(record["name"]);
  if (id === undefined || name === undefined) return undefined;

  const star = asNumber(record["star"]);
  return {
    id,
    name,
    ext: (asString(record["ext"]) ?? "").replace(/^\./, "").toLowerCase(),
    size: asNumber(record["size"]) ?? 0,
    tags: asNames(record["tags"]),
    folders: asNames(record["folders"]),
    trashed: record["isDeleted"] === true,
    url: asText(record["url"]),
    note: asText(record["annotation"]),
    // Clamped rather than refused: Roost's scale is 1–5 and a value outside it
    // is Eagle's problem, not a reason to lose the rest of the item.
    star: star === undefined || star < 1 ? undefined : Math.min(5, Math.round(star)),
    comments: parseComments(record["comments"]),
  };
}

function parseComments(value: unknown): EagleComment[] {
  if (!Array.isArray(value)) return [];
  const comments: EagleComment[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const body = asText(record["annotation"]);
    if (body === undefined) continue;
    const seconds = asNumber(record["duration"]) ?? 0;
    comments.push({ atMs: Math.max(0, Math.round(seconds * 1000)), body });
  }
  return comments;
}

// --- Surveying ---------------------------------------------------------------

/**
 * Reads an Eagle library and reports what importing it would do.
 *
 * Writes nothing, anywhere. This is not a filter — nothing is selected from the
 * result (ADR-0032 §6) — it is the answer to "what am I about to do", including
 * the parts that cannot be carried across.
 */
export async function surveyEagle(root: string): Promise<EagleSurvey> {
  const { version, folders, tagGroups } = await readEagleRoot(root);

  const tags = new Set<string>();
  const renamedFolders: FolderRename[] = [];
  const missing: string[] = [];
  const unreadable: string[] = [];
  let items = 0;
  let bytes = 0;
  let rated = 0;
  let notes = 0;
  let sources = 0;
  let comments = 0;
  let subtitles = 0;
  let trashed = 0;

  const folderCount = countFolders(folders, renamedFolders);

  for await (const entry of eagleEntries(root)) {
    if ("bad" in entry) {
      unreadable.push(entry.bad);
      continue;
    }
    const { item } = entry;
    items += 1;
    bytes += item.size;
    if (entry.file === undefined) missing.push(item.name);
    for (const tag of item.tags) tags.add(tag);
    if (item.star !== undefined) rated += 1;
    if (item.note !== undefined) notes += 1;
    if (item.url !== undefined) sources += 1;
    if (item.trashed) trashed += 1;
    comments += item.comments.length;
    subtitles += entry.subtitles.length;
  }

  return {
    version,
    items,
    bytes,
    folders: folderCount,
    tagGroups: tagGroups.length,
    tags: [...tags].sort((a, b) => a.localeCompare(b)),
    rated,
    notes,
    sources,
    comments,
    subtitles,
    trashed,
    renamedFolders,
    missing,
    unreadable,
  };
}

/** Counts the tree, collecting the names that cannot be carried verbatim. */
function countFolders(folders: readonly EagleFolder[], renames: FolderRename[]): number {
  let count = 0;
  for (const folder of folders) {
    count += 1;
    const name = folderName(folder.name);
    if (name !== folder.name) renames.push({ from: folder.name, to: name });
    count += countFolders(folder.children, renames);
  }
  return count;
}

/**
 * A folder name Roost will accept.
 *
 * Eagle allows `/` in one and Roost refuses it, for a reason worth keeping: a
 * top-level `Design/Icons` and an `Icons` inside `Design` compile to the same
 * `folder:` query, so one of them becomes unreachable. Substituted and
 * reported — one renamed folder must not fail an import of twenty thousand
 * items.
 */
function folderName(name: string): string {
  return name.replace(/\//g, "-").trim();
}

// --- Importing ---------------------------------------------------------------

/**
 * Imports an Eagle library into `library`.
 *
 * Everything comes: every item, every kind of metadata, no filters (ADR-0032
 * §6). Two phases per chunk, and their order is not negotiable — the bytes go
 * through the ordinary import pipeline first, then the metadata is applied to
 * the assets they became, because an operation naming an asset the index does
 * not hold yet is a foreign-key violation rather than a no-op.
 *
 * **Idempotent.** Re-running imports no bytes twice, and every metadata
 * operation is either set membership or last-write-wins, so an interrupted
 * import is resumed by running it again.
 */
export async function importEagle(
  library: Library,
  root: string,
  options: EagleImportOptions = {},
  onProgress?: (done: number, total: number) => void,
): Promise<EagleReport> {
  const started = performance.now();
  const survey = await surveyEagle(root);
  const { folders, tagGroups } = await readEagleRoot(root);
  const mode: StorageMode = options.mode ?? "managed";
  const extraTags = options.tags ?? [];

  log.info("importing an Eagle library", {
    root,
    version: survey.version,
    items: survey.items,
    mode,
  });

  // Folders first: an item's `folder_add` names a folder that has to exist.
  const folderIds = new Map<string, number>();
  const created = await createFolders(library, folders, null, folderIds, existingFolders(library));

  const seen = new Set<string>();
  const failed: ImportFailure[] = [];
  const counts = {
    imported: 0,
    duplicates: 0,
    collapsed: 0,
    tagged: 0,
    ratings: 0,
    notes: 0,
    sources: 0,
    comments: 0,
    trashed: 0,
    subtitles: 0,
    bytes: 0,
  };

  let chunk: EagleEntry[] = [];
  const flush = async (): Promise<void> => {
    if (chunk.length === 0) return;
    await importChunk(library, chunk, mode, extraTags, folderIds, seen, counts, failed);
    chunk = [];
    onProgress?.(seen.size, survey.items);
  };

  for await (const entry of eagleEntries(root)) {
    if ("bad" in entry || entry.file === undefined) continue;
    chunk.push(entry);
    if (chunk.length >= CHUNK) await flush();
  }
  await flush();

  // Groups last: `tag_group_set` names a tag, and the tags exist once the items
  // that carry them have been imported.
  const groups = await applyTagGroups(library, tagGroups);

  const report: EagleReport = {
    survey,
    assets: seen.size,
    imported: counts.imported,
    duplicates: counts.duplicates,
    collapsed: counts.collapsed,
    folders: created,
    tagGroups: groups,
    tagged: counts.tagged,
    ratings: counts.ratings,
    notes: counts.notes,
    sources: counts.sources,
    comments: counts.comments,
    trashed: counts.trashed,
    subtitles: counts.subtitles,
    bytes: counts.bytes,
    elapsed: performance.now() - started,
    failed,
  };
  log.info("Eagle import complete", {
    assets: report.assets,
    imported: report.imported,
    collapsed: report.collapsed,
    ms: Math.round(report.elapsed),
  });
  return report;
}

/**
 * Every folder already in the library, keyed by parent and name.
 *
 * This is what makes a re-run idempotent. Creating unconditionally would give a
 * second import a second `majorette` beside the first, and Roost allows that —
 * sibling names are unique only by convention — so nothing downstream would
 * complain.
 */
function existingFolders(library: Library): Map<string, number> {
  const byKey = new Map<string, number>();
  for (const folder of library.db.repo.folders()) {
    byKey.set(folderKey(folder.parentId, folder.name), folder.id);
  }
  return byKey;
}

function folderKey(parent: number | null, name: string): string {
  return `${parent ?? "-"}/${name.toLowerCase()}`;
}

/**
 * Creates the folder tree, depth first, mapping Eagle's ids onto Roost's.
 *
 * A folder that is already there is reused rather than duplicated, and is not
 * counted as created — the report says what this run actually wrote.
 */
async function createFolders(
  library: Library,
  folders: readonly EagleFolder[],
  parent: number | null,
  into: Map<string, number>,
  existing: Map<string, number>,
): Promise<number> {
  let count = 0;
  for (const folder of folders) {
    const name = folderName(folder.name);
    const key = folderKey(parent, name);
    let id = existing.get(key);
    if (id === undefined) {
      id = await createFolder(library, name, parent);
      existing.set(key, id);
      count += 1;
    }
    into.set(folder.id, id);
    count += await createFolders(library, folder.children, id, into, existing);
  }
  return count;
}

/** The item's tags plus the run's own, without repeating one Eagle already had. */
function mergeTags(own: readonly string[], extra: readonly string[]): string[] {
  if (extra.length === 0) return [...own];
  const seen = new Set(own.map((tag) => tag.toLowerCase()));
  return [...own, ...extra.filter((tag) => !seen.has(tag.toLowerCase()))];
}

/** What one chunk of items adds up to, accumulated across the run. */
interface Counts {
  imported: number;
  duplicates: number;
  collapsed: number;
  tagged: number;
  ratings: number;
  notes: number;
  sources: number;
  comments: number;
  trashed: number;
  subtitles: number;
  bytes: number;
}

async function importChunk(
  library: Library,
  chunk: readonly EagleEntry[],
  mode: StorageMode,
  extraTags: readonly string[],
  /** Eagle's folder ids, mapped onto this library's by {@link createFolders}. */
  folderIds: ReadonlyMap<string, number>,
  seen: Set<string>,
  counts: Counts,
  failed: ImportFailure[],
): Promise<void> {
  const hashes = new Map<string, ContentHash>();
  const sources: string[] = [];
  for (const entry of chunk) {
    if (entry.file !== undefined) sources.push(entry.file);
    sources.push(...entry.subtitles);
  }

  const report = await importInto(library, sources, {
    mode,
    onAsset: (path, hash) => hashes.set(path, hash),
  });
  counts.imported += report.imported;
  counts.duplicates += report.duplicates;
  counts.subtitles += report.subtitles;
  counts.bytes += report.bytes;
  failed.push(...report.failed);

  // The ids are minted from the index this process can see, so they are taken
  // once per batch and advanced locally: `nextCommentId` would answer the same
  // number for every comment in a batch that has not been applied yet.
  let commentId = library.db.repo.nextCommentId();
  const ops: Op[] = [];
  /** Comments this asset already carries, plus the ones this batch has added. */
  const already = new Set<string>();

  for (const entry of chunk) {
    const hash = entry.file === undefined ? undefined : hashes.get(entry.file);
    if (hash === undefined) continue;
    if (seen.has(hash)) counts.collapsed += 1;
    seen.add(hash);

    const { item } = entry;
    if (item.comments.length > 0) {
      for (const existing of commentsOn(library, hash)) {
        already.add(`${hash}\u0000${existing.atMs ?? -1}\u0000${existing.body}`);
      }
    }
    const tags = mergeTags(item.tags, extraTags);
    if (tags.length > 0) {
      ops.push({ op: "tag_add", hash, tags });
      counts.tagged += 1;
    }
    for (const folder of item.folders) {
      // An id naming no folder is skipped rather than fatal: Eagle leaves the
      // membership behind when a folder is deleted, and the sample library had
      // exactly that.
      const id = folderIds.get(folder);
      if (id !== undefined) ops.push({ op: "folder_add", hash, folder: id });
    }
    if (item.star !== undefined) {
      ops.push({ op: "rate", hash, rating: item.star });
      counts.ratings += 1;
    }
    if (item.note !== undefined) {
      ops.push({ op: "note_set", hash, note: item.note });
      counts.notes += 1;
    }
    if (item.url !== undefined) {
      ops.push({ op: "source_set", hash, url: item.url });
      counts.sources += 1;
    }
    // A comment is the one thing here that is neither set membership nor
    // last-write-wins: `comment_add` mints an id, so re-running would leave a
    // second copy of every comment. Matched on what the user would call the
    // same comment — the same words at the same moment on the same asset.
    for (const comment of item.comments) {
      const key = `${hash}\u0000${comment.atMs}\u0000${comment.body}`;
      if (already.has(key)) continue;
      already.add(key);
      ops.push({ op: "comment_add", id: commentId, hash, at: comment.atMs, body: comment.body });
      commentId += 1;
      counts.comments += 1;
    }
    // Last, so that everything hanging off the asset is already on it — trash
    // marks the row and keeps the rest (ADR-0022), but a reader watching the
    // journal should see the asset furnished before it is put away.
    if (item.trashed) {
      ops.push({ op: "trash", hash });
      counts.trashed += 1;
    }
  }

  await apply(library, ops);
}

async function applyTagGroups(library: Library, groups: readonly EagleTagGroup[]): Promise<number> {
  let created = 0;
  for (const group of groups) {
    // Reused rather than recreated, for the reason {@link existingFolders}
    // gives: a second run must not leave a second group of the same name.
    const found = library.db.repo.findTagGroupByName(group.name);
    const id = found?.id ?? (await createTagGroup(library, group.name));
    if (found === undefined) created += 1;
    await setTagGroup(library, group.tags, id);
  }
  return created;
}
