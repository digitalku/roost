import { RoostError } from "@roost/core";

/**
 * Errors from the service layer.
 *
 * Each carries a code registered in `@roost/core`'s `ERROR_CODES`, never one
 * invented here: the codes appear in logs, in bug reports, and in the
 * renderer's error states, so they are interface rather than debugging aid.
 */

/**
 * The directory holds no `library.json`, or holds one that fails validation.
 *
 * Both are this error rather than two, because RL-5b requires a manifest that
 * fails validation to be **reported as "not a Roost library"** rather than
 * repaired or replaced. `reason` says which of the two it was: a directory
 * nobody ever made a library in and a `library.json` missing its `id` send a
 * person in opposite directions, and only the second is worth opening.
 */
export class NotALibraryError extends RoostError {
  readonly code = "not_a_library";

  constructor(path: string, reason = "no library.json") {
    super(`${path} is not a Roost library (${reason})`, { path, reason });
  }
}

/**
 * The directory itself is not there.
 *
 * Separate from `NotALibraryError` because the two send a reader in opposite
 * directions, and the picker's recent list is where the difference shows: a
 * library on a removable drive is not damaged when the drive is unplugged, and
 * telling somebody it holds no `library.json` invites them to go looking for
 * the damage. The cost is one `stat` on a path that has already failed.
 */
export class LibraryNotFoundError extends RoostError {
  readonly code = "library_not_found";

  constructor(path: string) {
    const advice = "if it is on a removable drive, check that the drive is connected";
    super(`${path} is not there — ${advice}`, { path });
  }
}

/**
 * The directory does not look like an Eagle library (ADR-0032).
 *
 * Checked before anything is read, because the alternative is a survey that
 * reports zero of everything — which looks like an empty library rather than
 * like the wrong directory.
 */
export class NotAnEagleLibraryError extends RoostError {
  readonly code = "not_an_eagle_library";

  constructor(path: string, missing: string) {
    super(`${path} is not an Eagle library (no ${missing})`, { path, missing });
  }
}

export class AlreadyALibraryError extends RoostError {
  readonly code = "already_a_library";

  constructor(path: string) {
    super(`${path} already contains a Roost library`, { path });
  }
}

/**
 * A library renamed to a name its folder's neighbour already has (ADR-0056 §3.2).
 *
 * Its own code rather than `already_a_library`, because what is in the way may
 * be any directory or file at all, and on Linux a `rename` onto an empty
 * directory would quietly replace it.
 */
export class LibraryNameTakenError extends RoostError {
  readonly code = "library_name_taken";

  constructor(path: string) {
    super(`${path} already exists`, { path });
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

/**
 * A transfer whose target is the library it would leave (ADR-0054 §3.7).
 *
 * Compared by canonical path rather than by the manifest's `id`: a library
 * folder copied to a second place carries the same id, and moving between the
 * two copies is something a person may mean.
 */
export class SameLibraryError extends RoostError {
  readonly code = "same_library";

  constructor(path: string) {
    super(`${path} is the library the assets are already in`, { path });
  }
}

/**
 * A second transfer asked for while one is running (ADR-0054 §3.9).
 *
 * Refused rather than queued. Two at once into one target would open it twice
 * in this process, and the lock cannot see that: it is this process's own.
 */
export class TransferRunningError extends RoostError {
  readonly code = "transfer_running";

  constructor() {
    super("A move or copy into another library is already running");
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
 * A file offered as a thumbnail that nothing in this build can draw
 * (ADR-0060). `reason` is the queue's own word for why, as a parked derive
 * would carry it.
 */
export class NotAPictureError extends RoostError {
  readonly code = "not_a_picture";

  constructor(path: string, reason: string) {
    super(`${path} cannot be used as a thumbnail (${reason})`, { path, reason });
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

/**
 * An edit aimed at an asset that is not in a state to be edited.
 *
 * Version 1 raised this for a `referenced` asset, whose bytes were a file in a
 * user directory that invariant 6 forbade writing to. Version 2 has one storage
 * mode and every asset's bytes are the library's to replace (RL-19, RL-20), so
 * what is left is the trash: restoring an asset is a deliberate act, and a save
 * that quietly resurrected one would be a surprise pointing the wrong way.
 */
export class NotEditableError extends RoostError {
  readonly code = "not_editable";

  constructor(needle: string, reason: string) {
    super(`${needle} cannot be edited: ${reason}`, { needle, reason });
  }
}

/**
 * More bytes than an edit is allowed to carry.
 *
 * The window a text asset is *read* through and the ceiling on what a save may
 * write are deliberately the same number: saving what was only partly read
 * would silently discard everything past the window, which is the one way this
 * feature could destroy a file rather than replace it.
 */
export class EditTooLargeError extends RoostError {
  readonly code = "edit_too_large";

  constructor(size: number, limit: number) {
    super(`An edit may carry at most ${limit} bytes; this one is ${size}`, { size, limit });
  }
}

export class AmbiguousIdError extends RoostError {
  readonly code = "ambiguous_id";

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

/**
 * A folder name a sibling already has.
 *
 * Two folders called `logos` under one parent compile to the same `folder:`
 * query, so one of them is unreachable — `findFolderByPath` walks a path one
 * segment at a time and takes the first row each segment matches. It is the
 * same defect as {@link AmbiguousFolderNameError} arriving by a different
 * route, and it is refused in the same place: where the name is authored.
 * Reported from a real pane on 2026-09-08, where a subfolder was made twice
 * under one folder and the tree drew both.
 *
 * **Names are compared without regard to case**, which is the house rule for
 * every user-authored name here: the Eagle importer reuses a folder by a
 * lowercased key, tags merge case-insensitively, and a subtitle finds
 * `Holiday.MP4` beside `holiday.srt`. `Logos` and `logos` are addressable as
 * separate folders and are still refused, because a pane showing both is a
 * pane nobody can read.
 *
 * Siblings only — the same name under two different parents is what a tree is
 * for, and `folder:Design/Icons` names exactly one of them.
 *
 * Replay does **not** check this: a library written before the rule, or by
 * another implementation, must still rebuild. The rule binds new names only.
 */
export class DuplicateFolderNameError extends RoostError {
  readonly code = "duplicate_folder_name";

  constructor(name: string, parent: string | null) {
    super(
      parent === null
        ? `A folder called "${name}" is already at the top level`
        : `A folder called "${name}" is already in "${parent}"`,
      { name, parent },
    );
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

  /**
   * Named, not numbered.
   *
   * The message reaches a window now (ADR-0033 §5) — a drag onto a folder is
   * the ordinary way to hit this — and *Folder 1 cannot be moved into 2* is a
   * sentence about rowids, which nobody has ever seen. The ids stay in the
   * detail, where a bug report wants them.
   */
  constructor(id: number, parent: number, name: string, into: string) {
    super(`${name} cannot be moved into ${into}, which is inside it`, { id, parent });
  }
}

/**
 * A tag group name another group already has (ADR-0061).
 *
 * Checked before the line is journalled, as a folder's name is. Replay does not
 * check it: since schema v3 the index takes whatever the journal holds, so a
 * library that reached the journal with two of one name still rebuilds.
 */
export class DuplicateTagGroupNameError extends RoostError {
  readonly code = "duplicate_tag_group_name";

  constructor(name: string) {
    super(`A tag group called "${name}" already exists`, { name });
  }
}

/** A new tag whose name the library already has, in any case (ADR-0061). */
export class DuplicateTagError extends RoostError {
  readonly code = "duplicate_tag";

  constructor(name: string) {
    super(`A tag called "${name}" already exists`, { name });
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
