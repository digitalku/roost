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

export class UnknownCommentError extends RoostError {
  readonly code = "unknown_comment";

  constructor(id: number) {
    super(`No comment has id ${id}`, { id });
  }
}

export class EmptyCommentError extends RoostError {
  readonly code = "empty_comment";

  constructor() {
    // Refused rather than silently deleted: emptying the box and removing the
    // comment are different intentions, and only one of them is reversible by
    // typing again.
    super("A comment needs a body — remove it instead of emptying it");
  }
}

/**
 * A thumbnail moment on something with no frames (ADR-0024 stage 4).
 *
 * Audio has no picture to take, and a document already has a page. Refused
 * rather than recorded and ignored: a journal line that means nothing is one a
 * later build has to keep understanding.
 */
export class NotAVideoError extends RoostError {
  readonly code = "not_a_video";

  constructor(needle: string, kind: string) {
    super(`Only a video can have a thumbnail moment — ${needle} is ${kind}`, { needle, kind });
  }
}

export class InvalidMomentError extends RoostError {
  readonly code = "invalid_moment";

  constructor(at: number) {
    super(`${at} is not a moment — expected whole milliseconds, zero or more`, { at });
  }
}

export class AmbiguousHashError extends RoostError {
  readonly code = "ambiguous_hash";

  constructor(needle: string) {
    super(`${needle} matches more than one asset — use a longer prefix`, { needle });
  }
}

/**
 * A name that is empty, or nothing but whitespace.
 *
 * `what` names the kind of thing — a tag, a folder, a query — because the
 * message is read by someone who typed one of several things on one line.
 */
export class EmptyNameError extends RoostError {
  readonly code = "empty_name";

  constructor(what: string) {
    super(`A ${what} needs a name`, { what });
  }
}

/**
 * A folder name that would make its own path unaddressable.
 *
 * `folder:` addresses a folder by its slash-separated path
 * (`DATA_MODEL.md` §3), so a folder *named* `Design/Icons` at the top level and
 * a folder called `Icons` inside `Design` produce the same query string —
 * clicking either in the sidebar selects whichever the compiler resolves first.
 * Found by driving the real window, and rejected at the point a name is
 * authored rather than at the point it is queried.
 *
 * Replay does **not** check this: a library written before the rule, or by
 * another implementation, must still rebuild. The rule binds new names only.
 */
export class AmbiguousFolderNameError extends RoostError {
  readonly code = "ambiguous_folder_name";

  constructor(name: string) {
    super(`A folder name cannot contain "/": "${name}" would be unaddressable by folder:`, {
      name,
    });
  }
}

export class InvalidRatingError extends RoostError {
  readonly code = "invalid_rating";

  constructor(value: number) {
    super(`Rating must be between 1 and 5, or cleared; ${value} is neither`, { value });
  }
}

export class UnknownFolderError extends RoostError {
  readonly code = "unknown_folder";

  constructor(id: number) {
    super(`No folder has id ${id}`, { id });
  }
}

export class UnknownFolderPathError extends RoostError {
  readonly code = "unknown_folder_path";

  constructor(path: string) {
    super(`No folder at ${path}`, { path });
  }
}

/**
 * A folder move that would put a folder inside its own subtree.
 *
 * Refused rather than repaired: the cycle detaches the subtree from the root,
 * where nothing can reach it — including whatever would have to undo it.
 */
export class FolderCycleError extends RoostError {
  readonly code = "folder_cycle";

  constructor(id: number, parent: number) {
    super(`Folder ${id} cannot be moved into ${parent}, which is inside it`, { id, parent });
  }
}

export class UnknownTagGroupError extends RoostError {
  readonly code = "unknown_tag_group";

  constructor(name: string) {
    super(`No tag group called ${name}`, { name });
  }
}

export class UnknownSmartFolderError extends RoostError {
  readonly code = "unknown_smart_folder";

  constructor(name: string) {
    super(`No smart folder called ${name}`, { name });
  }
}

/**
 * A reclaim asked for on a report that found the index and the object store
 * disagreeing.
 *
 * Reclaiming is permanent — an orphan is by definition not in the journal, so
 * a rebuild cannot bring it back — and an orphan is only an orphan *relative to
 * the index*. If the index is the thing that is broken, every object looks
 * unreferenced. The answer is `roost rebuild`, which makes the question
 * answerable again.
 */
export class UnsoundReclaimError extends RoostError {
  readonly code = "unsound_reclaim";

  constructor(reason: string) {
    super(`Refusing to reclaim: ${reason}`, { reason });
  }
}

/**
 * A library name that would mean something to the filesystem.
 *
 * Refused rather than sanitised: a name quietly turned into a different name is
 * a library the user cannot find again.
 */
export class InvalidLibraryNameError extends RoostError {
  readonly code = "invalid_library_name";

  constructor(name: string, reason: string) {
    super(`"${name}" cannot be a library name: ${reason}`, { name, reason });
  }
}
