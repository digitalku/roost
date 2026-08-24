import { RoostError } from "@roost/core";

/**
 * Errors from the service layer.
 *
 * Each carries a code registered in `@roost/core`'s `ERROR_CODES`, never one
 * invented here: the codes appear in logs, in bug reports, and in the
 * renderer's error states, so they are interface rather than debugging aid.
 */

/** The directory holds no `library.json`. */
export class NotALibraryError extends RoostError {
  readonly code = "not_a_library";

  constructor(path: string) {
    super(`${path} is not a Roost library (no library.json)`, { path });
  }
}

export class AlreadyALibraryError extends RoostError {
  readonly code = "already_a_library";

  constructor(path: string) {
    super(`${path} already contains a Roost library`, { path });
  }
}

/**
 * Only an exclusive open can produce this; a shared open never consults the
 * lock.
 */
export class LibraryBusyError extends RoostError {
  readonly code = "library_busy";

  constructor(path: string, pid: number) {
    super(`${path} is already open in another Roost process (${pid})`, { path, pid });
  }
}

export class LibraryTooNewError extends RoostError {
  readonly code = "library_too_new";

  constructor(found: number, supported: number) {
    super(`Library uses format version ${found}; this build supports up to ${supported}`, {
      found,
      supported,
    });
  }
}

/**
 * The one blind spot in partial hashing, caught rather than merged.
 *
 * Two distinct files sharing a size, a first 64 KiB, and a last 64 KiB is the
 * single case the partial scheme cannot see. Merging them would lose one of the
 * two permanently, so the import declines the file instead — the spec's rule,
 * and the safe direction to be wrong in.
 */
export class PartialHashCollisionError extends RoostError {
  readonly code = "partial_hash_collision";

  constructor(path: string, existing: string) {
    super(
      `${path} shares a partial hash with ${existing} but differs in its bytes; refusing to merge`,
      { path, existing },
    );
  }
}

export class UnknownAssetError extends RoostError {
  readonly code = "unknown_asset";

  constructor(needle: string) {
    super(`No asset matches ${needle}`, { needle });
  }
}

export class AmbiguousHashError extends RoostError {
  readonly code = "ambiguous_hash";

  constructor(needle: string) {
    super(`${needle} matches more than one asset — use a longer prefix`, { needle });
  }
}
