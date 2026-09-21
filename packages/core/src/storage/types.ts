import type { AssetId, Placement, Take } from "../model/index.js";

/** Directory name for the file store inside a library (RL-8). */
export const FILES_DIR = "files";

/** The result of placing a file into the store. */
export interface Placed {
  readonly path: string;
  /** What happened to the source file. RL-26 requires the person to be told. */
  readonly take: Take;
  /** How it got there — for the log, never journalled. */
  readonly placement: Placement;
}

/**
 * One file discovered in the store, as yielded by `Storage.iterAll`.
 *
 * Deliberately no `size`: a rebuild walks an entire library through this, and a
 * field nobody asked for would cost a `stat` per file.
 */
export interface StoredFile {
  readonly id: AssetId;
  readonly ext: string;
  readonly path: string;
}

/**
 * The store for asset bytes: `files/<shard>/<id>.<ext>` and nothing else.
 *
 * Version 2 has one storage mode (RL-19), so there is one implementation and no
 * interface for a second one to satisfy. What the type still buys is the
 * boundary invariant 2 names: an id becomes a path here and nowhere else.
 *
 * **Nothing in this store is immutable.** The bytes may change at any time, by
 * any application, without the library being told (RL-20) — so no method here
 * may assume the file it placed is the file it will read back, and none may
 * hold a handle open in a way that stops another application writing, renaming
 * or deleting it (RL-21).
 */
export interface Storage {
  /**
   * The path an asset's bytes occupy. **The only way an id becomes a path** —
   * `ARCHITECTURE.md` invariant 2 reserves that to a `Storage` implementation,
   * and this is the door.
   */
  locate(id: AssetId, ext: string): string;

  /**
   * Places a file the person is importing, moving or copying it as `take` says
   * (RL-26). The result is an **independent** file: a reflink is permitted
   * because it is one, a hardlink is not.
   */
  put(src: string, id: AssetId, ext: string, take: Take): Promise<Placed>;

  /**
   * Writes bytes over an asset's file, or creates it.
   *
   * This is an ordinary edit (RL-20): the asset is the same asset afterwards,
   * and nothing is journalled about it (RL-23).
   */
  writeBytes(bytes: Uint8Array, id: AssetId, ext: string): Promise<string>;

  remove(id: AssetId, ext: string): Promise<void>;

  /**
   * Every file an id has in the store, in shard order.
   *
   * Usually one. Two is what RL-12 forbids and requires an implementation to
   * report rather than choose between; none is an asset whose file is missing,
   * which RL-25 requires be reported and never dropped.
   */
  findFiles(id: AssetId): Promise<readonly StoredFile[]>;

  /**
   * Walks the store lazily. A rebuild runs this over a whole library, so it
   * must not require the database to be present or correct, and must not
   * collect the tree into memory.
   */
  iterAll(): AsyncIterable<StoredFile>;

  /**
   * Paths in the store whose names are not ids.
   *
   * Word leaves `~$laporan.docx` beside the document it opened, and an editor
   * that crashed leaves a temporary file behind. RL-11 forbids adopting either
   * as an asset and forbids deleting them automatically; this is the
   * "reportable by a maintenance command" half.
   */
  iterUnrecognised(): AsyncIterable<string>;
}

/**
 * The on-disk extension is lowercased (RL-9), so `photo.JPG` and `photo.jpg`
 * are not two files for one asset.
 *
 * Every leading dot is stripped, not just one, so `.jpg` and `jpg` are the same
 * extension however the caller spells it.
 */
export function normalizeExt(ext: string): string {
  return ext.replace(/^\.+/, "").toLowerCase();
}
