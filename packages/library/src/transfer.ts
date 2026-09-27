import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type AssetDetail,
  type AssetId,
  type DerivedMetadata,
  type FolderRow,
  type JournalRecord,
  logger,
  type Op,
  type Placed,
  type Take,
} from "@roost/core";
import { hashFile, probe } from "@roost/media";
import { type Claims, claim } from "./claims.js";
import { mapWithConcurrency } from "./concurrency.js";
import { apply, createFolder, removeAssets } from "./edit.js";
import { SameLibraryError, UnknownAssetError } from "./error.js";
import { commit, type Ingested } from "./import.js";
import { Library, nowUnix } from "./library.js";
import { resolveFile } from "./locate.js";
import { ByteMeter, LARGE_FILE, type MeterShare } from "./meter.js";

/**
 * Moving and copying assets from one library into another (ADR-0054).
 *
 * A translation onto operations both libraries already write, as the Eagle
 * importer is: the target journals an `add` and everything a person wrote about
 * the asset, and a move then journals `remove` in the source. No new op, no
 * migration, no schema change.
 *
 * **The order is the whole design** (ADR-0054 §3.3). Every file is copied into
 * the target and journalled there before the source is touched, and the source
 * gives its assets up only once all of them have arrived. A crash anywhere
 * leaves an asset in both libraries and never in neither, and running the move
 * again finishes it: the target already holds the bytes, so the second run
 * merges, which adds nothing, and then removes.
 */

const log = logger("transfer");

/**
 * Assets placed and committed per target batch.
 *
 * One journal batch and one transaction each, as an import's are, and the
 * same bound on what is resident: a chunk's details and nothing more.
 */
const CHUNK = 200;

/** Files hashed and copied at once — the import pipeline's figure, for its reason. */
const CONCURRENCY = 8;

export interface TransferOptions {
  /**
   * `move` removes what arrived from the source afterwards; `copy` leaves the
   * source as it was.
   *
   * Not the import's `take`, although it is spelled with the same type. The
   * **file** is always copied into the target, whichever this is, because a
   * rename across has no safe order (ADR-0054 §3.3). This says what happens to
   * the source's asset once the copy is committed.
   */
  readonly take: Take;
  /**
   * Stops the transfer (ADR-0054 §3.9). Files not yet started are left alone,
   * and one half copied is abandoned and its partial copy removed. **What has
   * arrived stays arrived**, and for a move it is removed from the source as it
   * would have been: a cancelled move is a smaller move, not an undone one.
   */
  readonly signal?: AbortSignal;
}

/**
 * How far a transfer has got.
 *
 * `bytesDone` counts each file's bytes as they are read to be hashed and again
 * as they are written, and halves the sum, so that it runs from zero to
 * `bytesTotal` and means "this much of the data has been dealt with". A reflink
 * and a file the target already had skip the write, and are counted as though
 * it had happened.
 */
export interface TransferProgress {
  /** Assets finished, whatever became of them. */
  readonly done: number;
  readonly total: number;
  readonly bytesDone: number;
  /** The files' sizes when the transfer began. */
  readonly bytesTotal: number;
}

/** One asset that did not arrive, and stays where it was. */
export interface TransferFailure {
  readonly id: AssetId;
  readonly name: string;
  readonly reason: string;
}

export interface TransferReport {
  /** Assets the target did not have, and has now. */
  added: number;
  /**
   * Assets whose bytes the target already held. What they carried was merged
   * onto that asset (ADR-0054 §3.5).
   */
  merged: number;
  /** A rating, note, source or poster not written because the target's asset had one. */
  preserved: number;
  /** Assets taken out of the source. Always zero for a copy. */
  removed: number;
  /** Folders the target did not have and was given. */
  folders: number;
  /** Subtitle attachments written in the target (ADR-0054 §3.6). */
  subtitles: number;
  /** Bytes of the files added, as far as the hash measured them. */
  bytes: number;
  /** Assets whose file could not be found (RL-25). They stay in the source. */
  missing: number;
  readonly failed: TransferFailure[];
  /** The transfer was stopped before it reached every asset (ADR-0054 §3.9). */
  cancelled: boolean;
}

function emptyReport(): TransferReport {
  return {
    added: 0,
    merged: 0,
    preserved: 0,
    removed: 0,
    folders: 0,
    subtitles: 0,
    bytes: 0,
    missing: 0,
    failed: [],
    cancelled: false,
  };
}

/**
 * Opens the library at `targetRoot`, transfers `ids` into it, and closes it.
 *
 * The target is opened exclusively and shown nowhere (ADR-0054 §3.7), so a
 * library another process has open is refused with `library_busy` before
 * anything is written. The derive jobs the transfer queues are the target's,
 * and wait for its next open.
 */
export async function transferToLibrary(
  source: Library,
  targetRoot: string,
  ids: readonly AssetId[],
  options: TransferOptions,
  onProgress?: (progress: TransferProgress) => void,
): Promise<TransferReport> {
  // Before the open, not after it: opening the open library exclusively would
  // report it busy, which is true and names the wrong mistake.
  await refuseSameLibrary(source.root, targetRoot);
  const target = await Library.open(targetRoot, { exclusive: true });
  try {
    return await transferAssets(source, target, ids, options, onProgress);
  } finally {
    await target.close();
  }
}

/** Transfers `ids` from `source` into `target`, both already open. */
export async function transferAssets(
  source: Library,
  target: Library,
  ids: readonly AssetId[],
  options: TransferOptions,
  onProgress?: (progress: TransferProgress) => void,
): Promise<TransferReport> {
  await refuseSameLibrary(source.root, target.root);

  const started = performance.now();
  const selection = gather(source, ids);
  const located = await locateAll(source, selection.order);
  const run: Run = {
    source,
    target,
    report: emptyReport(),
    folders: new FolderMap(source, target),
    into: new Map(),
    written: new Map(),
    located,
    meter: new Meter(selection.order.length, located, onProgress),
    large: new Gate(),
    signal: options.signal,
  };
  const { report, into } = run;

  for (let start = 0; start < selection.order.length; start += CHUNK) {
    if (options.signal?.aborted === true) break;
    await transferChunk(run, selection.order.slice(start, start + CHUNK));
  }
  report.folders = run.folders.created;
  report.cancelled = options.signal?.aborted === true;

  // After every chunk, because a track and its video may have landed in two of
  // them, and `subtitle_attach` names both.
  report.subtitles = await attachTracks(target, selection.attachments, into);

  // Last of all, and only what arrived (ADR-0054 §3.8). Everything above can be
  // interrupted and run again; this is the step that makes it a move — and it
  // runs after a cancel too, for what did arrive (§3.9).
  if (options.take === "move") {
    // A video whose track did not arrive, or a track whose video did not, stays
    // here as well: removing either would part them, in both libraries.
    const parted = new Set<AssetId>();
    for (const { asset, track } of selection.attachments) {
      if (into.has(asset) && into.has(track)) continue;
      parted.add(asset);
      parted.add(track);
    }
    const leaving = selection.order.filter(
      (id) => into.has(id) && !selection.keep.has(id) && !parted.has(id),
    );
    if (leaving.length > 0) report.removed = (await removeAssets(source, leaving)).assets;
  }

  log.info("transfer complete", {
    target: target.root,
    take: options.take,
    added: report.added,
    merged: report.merged,
    removed: report.removed,
    missing: report.missing,
    failed: report.failed.length,
    cancelled: report.cancelled,
    ms: Math.round(performance.now() - started),
  });
  for (const failure of report.failed) {
    log.warn("asset could not be transferred", { asset: failure.id, reason: failure.reason });
  }
  return report;
}

/** Everything one transfer carries from chunk to chunk. */
interface Run {
  readonly source: Library;
  readonly target: Library;
  readonly report: TransferReport;
  readonly folders: FolderMap;
  /** Source id to target id, for everything that arrived. */
  readonly into: Map<AssetId, AssetId>;
  readonly written: Written;
  readonly located: ReadonlyMap<AssetId, Found>;
  readonly meter: Meter;
  readonly large: Gate;
  readonly signal: AbortSignal | undefined;
}

/** A source file, found and measured before anything is read. */
interface Found {
  readonly path: string;
  readonly ext: string;
  readonly size: number;
}

/**
 * Every file found and measured before the first is read, so that the bar has
 * a total from the start.
 *
 * A `stat` each, which is nothing beside reading the files. The sizes are taken
 * here rather than from the index, because a size is derived (RL-22) and the
 * file may have been saved since it was last measured. A file not found is
 * absent from the answer, and is counted as missing when its turn comes.
 */
async function locateAll(source: Library, ids: readonly AssetId[]): Promise<Map<AssetId, Found>> {
  const found = new Map<AssetId, Found>();
  await mapWithConcurrency(ids, CONCURRENCY, async (id) => {
    const resolved = await resolveFile(source, id);
    if (resolved.kind !== "found") return;
    const info = await stat(resolved.path).catch(() => undefined);
    if (info === undefined) return;
    found.set(id, { path: resolved.path, ext: resolved.ext, size: info.size });
  });
  return found;
}

/**
 * Counts what has been dealt with, and tells the caller.
 *
 * The bytes are a {@link ByteMeter}'s; this adds the assets finished beside
 * them, one per file squared off.
 */
class Meter {
  readonly #total: number;
  readonly #bytes: ByteMeter;
  readonly #onProgress: ((progress: TransferProgress) => void) | undefined;
  #done = 0;

  constructor(
    total: number,
    located: ReadonlyMap<AssetId, Found>,
    onProgress: ((progress: TransferProgress) => void) | undefined,
  ) {
    this.#total = total;
    let bytes = 0;
    for (const file of located.values()) bytes += file.size;
    this.#bytes = new ByteMeter(bytes, () => this.#tell());
    this.#onProgress = onProgress;
  }

  /** One file's share: counts as it goes, and squares off at the end. */
  file(size: number): MeterShare {
    const share = this.#bytes.file(size);
    return {
      count: share.count,
      finish: () => {
        this.#done += 1;
        share.finish();
      },
    };
  }

  #tell(): void {
    this.#onProgress?.({
      done: this.#done,
      total: this.#total,
      bytesDone: this.#bytes.done,
      bytesTotal: this.#bytes.total,
    });
  }
}

/**
 * One at a time, in the order asked.
 *
 * The large files' queue ({@link LARGE_FILE}): each waits for the one before it
 * to finish, failed or not.
 */
class Gate {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    const before = this.#tail;
    let release = (): void => {};
    this.#tail = new Promise((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

async function refuseSameLibrary(sourceRoot: string, targetRoot: string): Promise<void> {
  if ((await canonical(sourceRoot)) === (await canonical(targetRoot))) {
    throw new SameLibraryError(targetRoot);
  }
}

/** Resolved, so that a symlink and its target are one library, as `recent.ts` counts them. */
async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

/** A subtitle attachment in the source, waiting for both ends to arrive. */
interface Attachment {
  readonly asset: AssetId;
  readonly track: AssetId;
  readonly lang: string | null;
  readonly label: string | null;
}

interface Selection {
  /**
   * The selection in the order given, each video followed by the tracks it
   * brought along — beside it rather than at the end, so that a cancel is
   * unlikely to fall between the two.
   */
  readonly order: readonly AssetId[];
  readonly attachments: readonly Attachment[];
  /** Tracks that also caption an asset staying behind: copied, never removed. */
  readonly keep: ReadonlySet<AssetId>;
}

/**
 * The selection, plus the subtitle tracks attached to it (ADR-0054 §3.6).
 *
 * Every id is checked before anything is written. A stale id from a window is
 * a mistake about the whole request, and finding it halfway would leave half a
 * transfer behind.
 */
function gather(source: Library, ids: readonly AssetId[]): Selection {
  const repo = source.db.repo;
  for (const id of ids) {
    if (!repo.hasAsset(id)) throw new UnknownAssetError(id);
  }

  // An attached track has left the grid (ADR-0025), so nobody could have
  // selected it there: it comes because its video does.
  const wanted = new Set<AssetId>();
  const order: AssetId[] = [];
  const attachments: Attachment[] = [];
  for (const id of ids) {
    if (wanted.has(id)) continue;
    wanted.add(id);
    order.push(id);
    for (const track of repo.subtitlesFor(id)) {
      attachments.push({ asset: id, track: track.trackId, lang: track.lang, label: track.label });
      if (wanted.has(track.trackId)) continue;
      wanted.add(track.trackId);
      order.push(track.trackId);
    }
  }

  const keep = new Set<AssetId>();
  for (const id of order) {
    if (repo.captionedBy(id).some((owner) => !wanted.has(owner))) keep.add(id);
  }
  return { order, attachments, keep };
}

/**
 * The source's folders, found or made in the target by path (ADR-0054 §3.4).
 *
 * Each level is reused where the target has a folder of that name under that
 * parent, compared without regard to case — the Eagle importer's rule, for its
 * reason: sibling names are unique only by convention, so creating
 * unconditionally would give a second transfer a second `Icons` beside the
 * first and nothing would complain.
 */
class FolderMap {
  readonly #source: ReadonlyMap<number, FolderRow>;
  readonly #target: Library;
  /** The target's folders by parent and name, including the ones made here. */
  readonly #existing = new Map<string, number>();
  /** Source folder id to target folder id, filled as they are asked for. */
  readonly #mapped = new Map<number, number>();
  created = 0;

  constructor(source: Library, target: Library) {
    this.#source = new Map(source.db.repo.folders().map((folder) => [folder.id, folder]));
    this.#target = target;
    for (const folder of target.db.repo.folders()) {
      this.#existing.set(folderKey(folder.parentId, folder.name), folder.id);
    }
  }

  /** The target's folder for a source folder, made along with its ancestors if need be. */
  async resolve(sourceId: number): Promise<number | undefined> {
    const known = this.#mapped.get(sourceId);
    if (known !== undefined) return known;
    const folder = this.#source.get(sourceId);
    if (folder === undefined) return undefined;

    const parent = folder.parentId === null ? null : await this.resolve(folder.parentId);
    if (parent === undefined) return undefined;

    const key = folderKey(parent, folder.name);
    let id = this.#existing.get(key);
    if (id === undefined) {
      id = await createFolder(this.#target, folder.name, parent);
      this.#existing.set(key, id);
      this.created += 1;
    }
    this.#mapped.set(sourceId, id);
    return id;
  }
}

function folderKey(parent: number | null, name: string): string {
  return `${parent ?? "-"}/${name.toLowerCase()}`;
}

/**
 * What this run has already written on a target asset.
 *
 * The index cannot answer it within a chunk: two source assets with identical
 * bytes become one target asset, and the second reads the row before the
 * first's batch is committed. It must not overwrite the first any more than it
 * overwrites what the target already had.
 */
type Written = Map<AssetId, { rated?: true; noted?: true; sourced?: true; postered?: true }>;

/** One source asset, after its file has been read and, if new, placed. */
type Planned =
  | { readonly kind: "missing" }
  /** Not started, or abandoned half way, because the transfer was stopped. */
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "added";
      readonly from: AssetId;
      readonly id: AssetId;
      readonly path: string;
      readonly ext: string;
      readonly detail: AssetDetail;
      readonly derived: DerivedMetadata;
    }
  | {
      readonly kind: "merged";
      readonly from: AssetId;
      readonly id: AssetId;
      readonly path: string;
      readonly detail: AssetDetail;
    };

async function transferChunk(run: Run, chunk: readonly AssetId[]): Promise<void> {
  const { source, target, folders, into, written, report } = run;
  /** Hashes placed in this chunk and not yet visible to the target's index. */
  const pending: Claims = new Map();
  /** Ids minted in this chunk, for RL-15 — their rows do not exist yet. */
  const minted = new Set<AssetId>();

  const planned = await mapWithConcurrency(chunk, CONCURRENCY, async (id) => {
    const found = run.located.get(id);
    const share = run.meter.file(found?.size ?? 0);
    try {
      if (found === undefined) return { kind: "missing" } as const;
      const work = (): Promise<Planned> => plan(run, id, found, share.count, pending, minted);
      return await (found.size >= LARGE_FILE ? run.large.run(work) : work());
    } catch (error) {
      // Asked for, not a failure: the file stays where it is and says nothing.
      if (run.signal?.aborted === true) return { kind: "cancelled" } as const;
      // One file that cannot be copied must not end a transfer of a thousand.
      report.failed.push({
        id,
        name: source.db.repo.findAsset(id)?.name ?? id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      share.finish();
    }
  });

  const ts = nowUnix();
  // Taken once per chunk and advanced locally, as the Eagle importer does:
  // `nextCommentId` answers the same number until the batch is applied.
  let commentId = target.db.repo.nextCommentId();
  /** Comments each target asset holds or is about to, so none is added twice. */
  const comments = new Map<AssetId, Set<string>>();
  const batch: Ingested[] = [];

  for (const item of planned) {
    if (item === undefined || item.kind === "cancelled") continue;
    if (item.kind === "missing") {
      report.missing += 1;
      continue;
    }

    const { detail, id } = item;
    const records: JournalRecord[] = [];
    if (item.kind === "added") {
      records.push({
        ts,
        op: "add",
        id,
        ext: item.ext,
        name: detail.name,
        ...(detail.createdAt === null ? {} : { created: detail.createdAt }),
      });
    }

    if (detail.tags.length > 0) records.push({ ts, op: "tag_add", asset: id, tags: detail.tags });
    for (const membership of detail.folders) {
      const folder = await folders.resolve(membership.id);
      if (folder !== undefined) records.push({ ts, op: "folder_add", asset: id, folder });
    }
    if (detail.isFavorite) records.push({ ts, op: "favorite_set", asset: id, favorite: true });

    // A new asset takes everything; one the target already had keeps what a
    // person wrote there (ADR-0032 §8, ADR-0054 §3.5).
    const fresh = item.kind === "added";
    const held = fresh ? undefined : target.db.repo.judgements(id);
    const mine = written.get(id) ?? {};
    written.set(id, mine);
    const fills = (has: boolean, done: true | undefined): boolean => fresh || (!has && !done);

    if (detail.rating !== null) {
      if (fills(held?.rating !== null, mine.rated)) {
        records.push({ ts, op: "rate", asset: id, rating: detail.rating });
        mine.rated = true;
      } else report.preserved += 1;
    }
    if (detail.note !== null) {
      if (fills(held?.note !== null, mine.noted)) {
        records.push({ ts, op: "note_set", asset: id, note: detail.note });
        mine.noted = true;
      } else report.preserved += 1;
    }
    if (detail.sourceUrl !== null) {
      if (fills(held?.sourceUrl !== null, mine.sourced)) {
        records.push({ ts, op: "source_set", asset: id, url: detail.sourceUrl });
        mine.sourced = true;
      } else report.preserved += 1;
    }
    if (detail.posterMs !== null) {
      if (fills(!fresh && target.db.repo.posterOf(id) !== null, mine.postered)) {
        records.push({ ts, op: "poster_set", asset: id, at: detail.posterMs });
        mine.postered = true;
      } else report.preserved += 1;
    }

    // Matched on what a person would call the same comment: the same words at
    // the same moment. `comment_add` mints an id, so without this a second run
    // of an interrupted move would leave a second copy of every one.
    let seen = comments.get(id);
    if (seen === undefined) {
      seen = new Set(
        fresh ? [] : target.db.repo.commentsFor(id).map((row) => commentKey(row.atMs, row.body)),
      );
      comments.set(id, seen);
    }
    for (const comment of source.db.repo.commentsFor(item.from)) {
      const key = commentKey(comment.atMs, comment.body);
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({
        ts,
        op: "comment_add",
        id: commentId,
        asset: id,
        at: comment.atMs,
        body: comment.body,
      });
      commentId += 1;
    }

    // Last, so the asset is furnished before it is put away. A duplicate never
    // takes the incoming trash state — trashing somebody's asset is not a
    // union — but a live asset arriving onto a trashed one brings it back, as
    // importing the file again would (ADR-0022).
    if (fresh && detail.trashedAt !== null) records.push({ ts, op: "trash", asset: id });
    if (!fresh && detail.trashedAt === null && typeof target.db.repo.trashedAt(id) === "number") {
      records.push({ ts, op: "restore", asset: id });
    }

    batch.push({
      id,
      path: item.path,
      records,
      derived: item.kind === "added" ? item.derived : {},
    });
    into.set(item.from, id);
    if (fresh) {
      report.added += 1;
      report.bytes += item.derived.size ?? 0;
    } else report.merged += 1;
  }

  await commit(target, batch);
}

function commentKey(atMs: number | null, body: string): string {
  return `${atMs ?? -1}\u0000${body}`;
}

/**
 * Reads one source asset's file and, if the target does not hold its bytes
 * yet, copies it in under a newly minted id.
 */
async function plan(
  run: Run,
  from: AssetId,
  found: Found,
  count: (bytes: number) => void,
  pending: Claims,
  minted: Set<AssetId>,
): Promise<Planned> {
  const { source, target, signal } = run;
  if (signal?.aborted === true) return { kind: "cancelled" };
  const detail = source.db.repo.assetDetail(from);
  if (detail === undefined) throw new UnknownAssetError(from);

  // Hashed now rather than read from the index: the file may have been saved
  // since it was last measured (RL-20), and the hash is what decides whether
  // the target already has it.
  const hashed = await hashFile(found.path, { onBytes: count, ...(signal && { signal }) });
  // An identical file in this chunk is waited for rather than trusted: if its
  // copy fails or is stopped, a merge onto it would name nothing (`claims.ts`).
  const claimed = await claim(
    hashed.hash,
    pending,
    minted,
    (hash) => target.db.repo.assetsWithHash(hash)[0],
    (candidate) => target.db.repo.hasAsset(candidate),
  );
  if ("held" in claimed) {
    return { kind: "merged", from, id: claimed.held, path: found.path, detail };
  }
  const { id } = claimed;

  // Always a copy, whatever the transfer is (ADR-0054 §3.3). The source's file
  // goes only when the source journals its `remove`, after everything else.
  let placed: Placed;
  try {
    placed = await target.storage.put(found.path, id, found.ext, "copy", {
      onBytes: count,
      ...(signal && { signal }),
    });
  } catch (error) {
    // Released, or an identical file later in the chunk would merge onto an
    // asset no batch will ever add, and its records would name nothing.
    claimed.settle(false);
    throw error;
  }
  claimed.settle(true);
  const probed = await probe(placed.path).catch(() => undefined);
  const stored = await stat(placed.path).catch(() => undefined);

  const derived: DerivedMetadata = {
    size: hashed.size,
    contentHash: hashed.hash,
    ...(stored === undefined ? {} : { mtime: Math.floor(stored.mtimeMs / 1000) }),
    ...(probed?.width === undefined ? {} : { width: probed.width }),
    ...(probed?.height === undefined ? {} : { height: probed.height }),
  };
  return { kind: "added", from, id, path: found.path, ext: found.ext, detail, derived };
}

/** Writes the source's attachments between assets that both arrived. */
async function attachTracks(
  target: Library,
  attachments: readonly Attachment[],
  into: ReadonlyMap<AssetId, AssetId>,
): Promise<number> {
  const ops: Op[] = [];
  for (const attachment of attachments) {
    const asset = into.get(attachment.asset);
    const track = into.get(attachment.track);
    // Two source assets with identical bytes can become one target asset, and
    // an asset cannot caption itself.
    if (asset === undefined || track === undefined || asset === track) continue;
    ops.push({
      op: "subtitle_attach",
      asset,
      track,
      ...(attachment.lang === null ? {} : { lang: attachment.lang }),
      ...(attachment.label === null ? {} : { label: attachment.label }),
    });
  }
  await apply(target, ops);
  return ops.length;
}
