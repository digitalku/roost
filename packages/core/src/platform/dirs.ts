import { isAbsolute, join, win32 } from "node:path";
import { UnsupportedPlatformError } from "../model/index.js";

/**
 * Where Roost keeps things that are not a library.
 *
 * Application state, logs, and caches live **outside** every library, and so
 * does the configuration a library cannot hold. That is not a preference:
 * RL-3 makes the library root a reserved namespace, and nothing may be put
 * there that the format does not name.
 *
 * **Per-library preferences are not among them** (ADR-0019): they live in
 * `settings.json` inside the library, so they travel when the folder is copied.
 * What lands here is what *cannot* — the recent-libraries list, which is how a
 * library is found in the first place; window geometry, which is per machine;
 * and the theme the picker is drawn in, which is read before any library is
 * open.
 *
 * It is also right on the merits. A library may sit on read-only media, on a
 * network share, or be opened from two machines; logs and per-machine state
 * cannot live there without either failing to write or interleaving two
 * machines' output into one file.
 *
 * Linux follows the XDG Base Directory specification, and Windows the known
 * folders: `%APPDATA%` for what may roam between a user's machines, and
 * `%LOCALAPPDATA%` for what must not (ADR-0041). Every other platform raises
 * {@link UnsupportedPlatformError} rather than guessing, so a port is a
 * deliberate act and never a silently wrong directory.
 */

/** The name every user-visible path is built under. */
export const APP_NAME = "roost";

/**
 * `$XDG_CONFIG_HOME/roost`, or `~/.config/roost`; `%APPDATA%\roost\config` on
 * Windows. User-editable settings.
 */
export function configDir(): string {
  return base("XDG_CONFIG_HOME", ".config", "APPDATA", "config");
}

/**
 * `$XDG_DATA_HOME/roost`, or `~/.local/share/roost`; `%APPDATA%\roost\data` on
 * Windows. Data worth backing up.
 */
export function dataDir(): string {
  return base("XDG_DATA_HOME", ".local/share", "APPDATA", "data");
}

/**
 * `$XDG_STATE_HOME/roost`, or `~/.local/state/roost`;
 * `%LOCALAPPDATA%\roost\state` on Windows — Local rather than Roaming, because
 * {@link lockDir} lives under it and a lock file records a pid.
 *
 * State that should persist between runs but is not worth backing up: window
 * geometry, the recent-libraries list, logs.
 */
export function stateDir(): string {
  return base("XDG_STATE_HOME", ".local/state", "LOCALAPPDATA", "state");
}

/**
 * `$XDG_CACHE_HOME/roost`, or `~/.cache/roost`; `%LOCALAPPDATA%\roost\cache` on
 * Windows. Safe to delete at any time.
 */
export function cacheDir(): string {
  return base("XDG_CACHE_HOME", ".cache", "LOCALAPPDATA", "cache");
}

/** Where log files go: `stateDir()/logs`. */
export function logDir(): string {
  return join(stateDir(), "logs");
}

/**
 * Where instance locks go: `stateDir()/locks`.
 *
 * Per-machine for the same reason logs are, and one more: a lock file records a
 * pid, and a pid means nothing on any machine but the one that issued it. A
 * lock kept inside a library shared over a network would name a process the
 * reader cannot check for.
 */
export function lockDir(): string {
  return join(stateDir(), "locks");
}

function base(variable: string, fallback: string, knownFolder: string, leaf: string): string {
  if (process.platform === "win32") {
    return resolveKnownFolder(process.env[knownFolder], knownFolder, leaf);
  }

  if (process.platform !== "linux") {
    // Compiles and runs everywhere so portability rot appears in CI the day it
    // does, but refuses to invent a layout for a platform nobody has designed
    // for yet.
    throw new UnsupportedPlatformError("resolving application directories");
  }
  return resolveXdg(process.env[variable], process.env["HOME"], fallback);
}

/**
 * The rule, separated from the environment so it can be tested without setting
 * process-wide variables.
 *
 * Exported for that test alone.
 */
export function resolveXdg(
  variable: string | undefined,
  home: string | undefined,
  fallback: string,
): string {
  // XDG is explicit that a relative value must be **ignored**, not resolved
  // against the working directory — which would put user data somewhere
  // different on every invocation.
  if (variable !== undefined && variable !== "" && isAbsolute(variable)) {
    return join(variable, APP_NAME);
  }

  if (home === undefined || home === "") {
    throw new UnsupportedPlatformError("resolving an XDG directory without HOME");
  }
  return join(home, fallback, APP_NAME);
}

/**
 * The Windows rule, separated from the environment for the same reason
 * {@link resolveXdg} is.
 *
 * The role is the leaf rather than the root, because Windows has two roots and
 * this module has four directories to place: `%APPDATA%\roost` serving as both
 * config and data would give two of them one directory, and two roles sharing a
 * namespace collide the first time both want a file of the same name
 * (ADR-0041 §2).
 *
 * There is no fallback when the variable is missing. `%APPDATA%` and
 * `%LOCALAPPDATA%` are set on every Windows installation, so an absent one is a
 * broken environment rather than a configuration to accommodate — and inventing
 * a directory is the thing this module exists not to do. A relative value is
 * refused for the reason XDG gives for ignoring one: it would put user data
 * somewhere different depending on where the process happened to start.
 *
 * The `win32` functions are named rather than the platform's own, although this
 * only ever runs on Windows. `isAbsolute("C:\\Users\\u")` answers false on
 * Linux, so a rule written with the ambient `node:path` is a rule that can only
 * be checked on the platform it describes — and that is how it stood until a
 * Linux checkout found the test failing on 2026-09-22. On Windows the two are
 * the same function.
 *
 * Exported for its test alone.
 */
export function resolveKnownFolder(
  root: string | undefined,
  variable: string,
  leaf: string,
): string {
  if (root === undefined || root === "" || !win32.isAbsolute(root)) {
    throw new UnsupportedPlatformError(`resolving a known folder without ${variable}`);
  }
  return win32.join(root, APP_NAME, leaf);
}
