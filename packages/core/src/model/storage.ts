/**
 * How a library holds an asset's bytes (`STORAGE_SPEC.md` §Import Modes).
 *
 * `managed` places the file under `originals/`; `referenced` leaves it where
 * the user put it and records an absolute path. Nothing is ever written into a
 * user's directory in referenced mode.
 */
export const STORAGE_MODES = ["managed", "referenced"] as const;

export type StorageMode = (typeof STORAGE_MODES)[number];

export function isStorageMode(value: string): value is StorageMode {
  return (STORAGE_MODES as readonly string[]).includes(value);
}

/**
 * How a managed asset's bytes got where they are, in the order the spec tries
 * them: reflink first, because the copy costs nothing *and* is independent of
 * later edits to the user's file; hardlink second, which is also free but
 * shares an inode; a full copy last.
 *
 * The value is recorded in the journal, so it must describe what actually
 * happened rather than what was attempted (ADR-0010).
 */
export const LINK_METHODS = ["reflink", "hardlink", "copy"] as const;

export type LinkMethod = (typeof LINK_METHODS)[number];

export function isLinkMethod(value: string): value is LinkMethod {
  return (LINK_METHODS as readonly string[]).includes(value);
}
