import { isAbsolute, join } from "node:path";
import { UnsupportedPlatformError } from "../model/index.js";

/**
 * Where Roost keeps things that are not a library.
 *
 * Configuration, application state, logs, and caches all live **outside** every
 * library. That is not a preference: `STORAGE_SPEC.md` publishes the library
 * layout and it is binding, so a library holds `originals/`, `index.db`,
 * `journal/`, and `library.json` — nothing else.
 *
 * It is also right on the merits. A library may sit on read-only media, on a
 * network share, or be opened from two machines; logs and per-machine state
 * cannot live there without either failing to write or interleaving two
 * machines' output into one file.
 *
 * Linux follows the XDG Base Directory specification. Other platforms raise
 * {@link UnsupportedPlatformError} rather than guessing, so a port is a
 * deliberate act and never a silently wrong directory.
 */

/** The name every user-visible path is built under. */
export const APP_NAME = "roost";

/** `$XDG_CONFIG_HOME/roost`, or `~/.config/roost`. User-editable settings. */
export function configDir(): string {
  return base("XDG_CONFIG_HOME", ".config");
}

/** `$XDG_DATA_HOME/roost`, or `~/.local/share/roost`. Data worth backing up. */
export function dataDir(): string {
  return base("XDG_DATA_HOME", ".local/share");
}

/**
 * `$XDG_STATE_HOME/roost`, or `~/.local/state/roost`.
 *
 * State that should persist between runs but is not worth backing up: window
 * geometry, the recent-libraries list, logs.
 */
export function stateDir(): string {
  return base("XDG_STATE_HOME", ".local/state");
}

/** `$XDG_CACHE_HOME/roost`, or `~/.cache/roost`. Safe to delete at any time. */
export function cacheDir(): string {
  return base("XDG_CACHE_HOME", ".cache");
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

function base(variable: string, fallback: string): string {
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
