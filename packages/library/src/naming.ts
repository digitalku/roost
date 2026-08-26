import { basename, join } from "node:path";
import { InvalidLibraryNameError } from "./error.js";

/**
 * What a library directory is called.
 *
 * A Roost library is a directory, and a directory full of hashes is not a thing
 * anyone recognises in a file manager. Eagle solved this by naming its libraries
 * `<Name>.library`; Roost names them `<Name>.roost`, for the same reason and
 * with the same effect — the folder reads as one object, a double-click can be
 * associated with the app, and a file picker can filter for it (ADR-0014).
 *
 * **The suffix is a convention, not a format rule.** `STORAGE_SPEC.md` says
 * nothing about the root's name and its eight invariants do not reach it, so a
 * directory holding a `library.json` is a library whatever it is called. That is
 * what keeps every library made before this rule — and every library made by
 * the Rust build — openable.
 */

export const LIBRARY_SUFFIX = ".roost";

/** Whether `path` already ends in the suffix. Case-sensitive, like the filesystem. */
export function hasLibrarySuffix(path: string): boolean {
  return path.endsWith(LIBRARY_SUFFIX) && path.length > LIBRARY_SUFFIX.length;
}

/**
 * `~/Pictures` becomes `~/Pictures.roost`; `~/Pictures.roost` is left alone.
 *
 * Idempotent on purpose: `roost init ~/Photos.roost` and `roost init ~/Photos`
 * must land in the same place, or the CLI has two spellings for one library.
 */
export function withLibrarySuffix(path: string): string {
  return hasLibrarySuffix(path) ? path : `${path}${LIBRARY_SUFFIX}`;
}

/** The display name a directory suggests: its basename, without the suffix. */
export function libraryNameFromPath(path: string): string {
  const name = basename(path);
  return hasLibrarySuffix(name) ? name.slice(0, -LIBRARY_SUFFIX.length) : name;
}

/**
 * Where a library called `name` goes inside `parent`.
 *
 * The name is validated here rather than at the call site, because this is the
 * one function that turns a name a person typed into a path — and a name that
 * reaches the filesystem unchecked is how `../../..` becomes a feature.
 */
export function libraryDirectory(parent: string, name: string): string {
  return join(parent, withLibrarySuffix(checkLibraryName(name)));
}

/**
 * Refuses a name that would mean something to the filesystem.
 *
 * Separators, a leading dot, and control characters are all refused rather than
 * sanitised: a name silently turned into a different name is a library the user
 * cannot find again.
 */
export function checkLibraryName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new InvalidLibraryNameError(name, "it is empty");
  if (/[/\\]/.test(trimmed)) {
    throw new InvalidLibraryNameError(name, "it contains a path separator");
  }
  // `.` and `..` name directories that already exist, and a leading dot hides
  // the library from every file manager that respects the convention.
  if (trimmed.startsWith(".")) throw new InvalidLibraryNameError(name, "it starts with a dot");

  // Checked by code point rather than by a regex literal, so that no control
  // character has to appear in this file to describe one.
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new InvalidLibraryNameError(name, "it contains a control character");
    }
  }
  return trimmed;
}
