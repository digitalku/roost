import { type ContentHash, NotInObjectStoreError, type StorageMode } from "../model/index.js";
import type { Placed, Storage, StoredFile } from "./types.js";

/**
 * A store that never stores anything.
 *
 * Referenced assets are indexed in place. Nothing is written into the user's
 * directories, nothing is moved, and nothing is deleted — not on import, not on
 * removal from the library. Removing a referenced asset from Roost removes the
 * row, never the file.
 */
export class ReferencedStorage implements Storage {
  readonly mode: StorageMode = "referenced";

  /**
   * Records where the bytes already are. Writes nothing.
   *
   * The unused parameters are kept rather than dropped: this implements
   * `Storage`, and a caller holding a `ReferencedStorage` directly must be able
   * to call it the same way as the managed one.
   */
  async put(src: string, _hash: ContentHash, _ext: string): Promise<Placed> {
    // `linkMethod` is null because nothing was linked: nothing was placed.
    return { path: src, linkMethod: null, alreadyPresent: true };
  }

  /**
   * Always throws, by design. A referenced asset's location is
   * `assets.ref_path` — user-chosen and not derivable from a hash. Callers read
   * it from the index instead of asking a store that does not own these bytes.
   */
  locate(hash: ContentHash, _ext?: string): string {
    throw new NotInObjectStoreError(hash);
  }

  /** A no-op. Deleting the user's file is forbidden. */
  async remove(_hash?: ContentHash, _ext?: string): Promise<void> {}

  /**
   * Empty: there is no object store to walk. A rebuild recovers referenced
   * assets from the journal, which carries their paths.
   */
  // biome-ignore lint/correctness/useYield: an empty async generator is the point.
  async *iterAll(): AsyncIterable<StoredFile> {}
}
