import type { ContentHash, LinkMethod, StorageMode } from "../model/index.js";

/** Directory name for the object store inside a library. */
export const ORIGINALS_DIR = "originals";

/** The result of placing bytes into a store. */
export interface Placed {
  readonly path: string;
  /** `null` in referenced mode, and when the bytes were already present. */
  readonly linkMethod: LinkMethod | null;
  readonly alreadyPresent: boolean;
}

/**
 * One file discovered in the object store, as yielded by `Storage.iterAll`.
 *
 * Deliberately no `size`: rebuild walks an entire library through this, and a
 * field nobody asked for would cost a `stat` per object.
 */
export interface StoredFile {
  readonly hash: ContentHash;
  readonly ext: string;
  readonly path: string;
}

/**
 * An object store for asset bytes.
 *
 * The two implementations are deliberately asymmetric, because the modes are:
 * `ManagedStorage` owns the bytes it is given, while `ReferencedStorage` owns
 * nothing and must never write into a user's directories. Rather than give the
 * referenced case stub methods that quietly do the wrong thing, its unsupported
 * operations throw.
 */
export interface Storage {
  readonly mode: StorageMode;

  /**
   * Places bytes and reports which link method succeeded. Never moves,
   * modifies, or deletes the caller's file. Idempotent.
   */
  put(src: string, hash: ContentHash, ext: string): Promise<Placed>;

  /**
   * Places bytes already in memory. Idempotent, like {@link put}.
   *
   * For content the application itself produced rather than found — an edited
   * text asset on its way to becoming a new version (ADR-0026). There is no
   * source file to link from, so `linkMethod` is always `copy`: the bytes are
   * written once and renamed into place.
   *
   * Referenced mode refuses it, as it refuses everything that would write.
   */
  putBytes(bytes: Uint8Array, hash: ContentHash, ext: string): Promise<Placed>;

  /**
   * The path bytes for this hash would occupy. **The only way a hash becomes a
   * path** — `ARCHITECTURE.md` invariant 2 reserves that to a `Storage`
   * implementation, and this is the door.
   */
  locate(hash: ContentHash, ext: string): string;

  remove(hash: ContentHash, ext: string): Promise<void>;

  /**
   * Walks the store lazily. Rebuild verification runs this over a whole
   * library, so it must not require the database to be present or correct, and
   * must not collect the tree into memory.
   */
  iterAll(): AsyncIterable<StoredFile>;
}

/**
 * The on-disk filename is the hash plus the *lowercased* extension
 * (RL-8). Skipping this would put `photo.JPG` and
 * `photo.jpg` at two different addresses despite identical content.
 *
 * Every leading dot is stripped, not just one, so `.jpg` and `jpg` are the same
 * extension however the caller spells it.
 */
export function normalizeExt(ext: string): string {
  return ext.replace(/^\.+/, "").toLowerCase();
}
