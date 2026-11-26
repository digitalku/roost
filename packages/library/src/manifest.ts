import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { IoError, makeDirectoryInside, STAGING_DIR } from "@roost/core";
import {
  AlreadyALibraryError,
  LibraryNotFoundError,
  LibraryTooNewError,
  NotALibraryError,
} from "./error.js";
import { type PasswordRecord, parsePasswordRecord } from "./password.js";

/** `library.json` — what makes a directory a Roost library. */
export const MANIFEST_FILE = "library.json";

/**
 * The highest library format this build reads: Roost Library Format **3**
 * (`FORMAT.md` RL-6).
 *
 * Version 3 is version 2 with a password (RL-5c), and only a library that has
 * one carries it, so this build reads both and writes whichever the library's
 * password calls for. Nothing else about the two differs.
 */
export const LIBRARY_FORMAT_VERSION = 3;

/** A library without a password, and the lowest version this build reads (RL-6a). */
export const PLAIN_FORMAT_VERSION = 2;

/** A library with a password (RL-5c, ADR-0071). */
export const PASSWORD_FORMAT_VERSION = 3;

const PASSWORD_FIELD = "password";

/** The four fields RL-5 requires, in the order it publishes them. */
const REQUIRED_FIELDS = ["roost_library_version", "id", "name", "created_at"] as const;

/**
 * The manifest, in the field order and the snake_case the format publishes.
 *
 * The names are not a style choice: RL-5 names all four, so a library written
 * by any implementation opens in every other one. Every field is required, and
 * a file missing one is not a damaged library — it is **not a library** (RL-5b).
 */
export interface Manifest {
  readonly roost_library_version: number;
  /** Stable identity, so a library stays recognisable after being moved. */
  readonly id: string;
  readonly name: string;
  /** Unix seconds. */
  readonly created_at: number;
  /**
   * The password's hash, or `null` for a library without one (RL-5c).
   *
   * Not in {@link unrecognised}: it decides the version the file is written
   * with, so it is read and written here, never carried past as an unknown.
   */
  readonly password: PasswordRecord | null;
  /**
   * Every other field the file carried, kept verbatim.
   *
   * RL-5a: an implementation ignores what it does not recognise **and
   * preserves it when it rewrites the file**. The two halves are one
   * requirement — reading leniently and writing destructively would mean that
   * opening a library here silently deletes whatever another implementation
   * had put in its manifest, and nothing would say so until that build next
   * looked for it.
   */
  readonly unrecognised: Readonly<Record<string, unknown>>;
}

export function newManifest(name: string, createdAt: number): Manifest {
  return {
    roost_library_version: PLAIN_FORMAT_VERSION,
    id: crypto.randomUUID(),
    name,
    created_at: createdAt,
    password: null,
    unrecognised: {},
  };
}

/**
 * Reads and validates `library.json`.
 *
 * **Strictly**, and that is RL-5b rather than a preference: this file decides
 * whether a directory is a library at all, so a build that guesses at a damaged
 * one is a build that can start writing into somebody's photographs. Through M4
 * a missing `id` became `""` and a missing `created_at` became `0`, which is a
 * repair — and a repaired manifest is one the next `writeManifest` makes
 * permanent.
 */
export async function readManifest(root: string): Promise<Manifest> {
  const path = join(root, MANIFEST_FILE);

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      // Which of the two is missing decides what the reader is told: a
      // directory that is not there is usually a drive that is not mounted,
      // and "no library.json" would send them looking for damage instead.
      throw (await exists(root)) ? new NotALibraryError(root) : new LibraryNotFoundError(root);
    }
    throw new IoError("read", path, cause);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new NotALibraryError(root, `library.json is not JSON: ${(cause as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NotALibraryError(root, "library.json is not a JSON object");
  }
  const raw = parsed as Record<string, unknown>;

  // RL-4: the integer is the format's signature, so it is read before anything
  // else — a file without it is not a library rather than a broken one.
  const version = raw["roost_library_version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new NotALibraryError(root, "roost_library_version is missing or not an integer");
  }

  // RL-6, and it comes before the other three fields deliberately: a later
  // format version may spell them differently, and refusing for the *right*
  // reason is what tells the person to open the library in a newer build
  // instead of sending them looking for damage. Nothing here has written
  // anything, which is the rest of RL-6.
  if (version > LIBRARY_FORMAT_VERSION) {
    throw new LibraryTooNewError(version, LIBRARY_FORMAT_VERSION);
  }

  // RL-6a: a lower version is not a library this build reads (RL-5b), and it
  // is refused before the other three fields for the same reason as above.
  if (version < PLAIN_FORMAT_VERSION) {
    throw new NotALibraryError(
      root,
      `roost_library_version ${version} is not a version this build reads`,
    );
  }

  const id = raw["id"];
  if (typeof id !== "string") throw new NotALibraryError(root, "id is missing or not a string");
  const name = raw["name"];
  if (typeof name !== "string") throw new NotALibraryError(root, "name is missing or not a string");
  const createdAt = raw["created_at"];
  if (typeof createdAt !== "number" || !Number.isInteger(createdAt)) {
    throw new NotALibraryError(root, "created_at is missing or not an integer");
  }

  // RL-5c: the version and the field say the same thing, or something wrote
  // half a change. Either half alone is refused rather than believed, because
  // believing the version would refuse a password nobody can type, and
  // believing the field would open what a version 2 reader opens unasked.
  let password: PasswordRecord | null = null;
  if (version === PASSWORD_FORMAT_VERSION) {
    if (!(PASSWORD_FIELD in raw)) {
      throw new NotALibraryError(root, "version 3 without a password");
    }
    const parsed = parsePasswordRecord(raw[PASSWORD_FIELD]);
    if (typeof parsed === "string") throw new NotALibraryError(root, parsed);
    password = parsed;
  } else if (PASSWORD_FIELD in raw) {
    throw new NotALibraryError(root, "a password in a version 2 library");
  }

  const unrecognised: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === PASSWORD_FIELD) continue;
    if (!(REQUIRED_FIELDS as readonly string[]).includes(key)) unrecognised[key] = value;
  }

  return {
    roost_library_version: version,
    id,
    name,
    created_at: createdAt,
    password,
    unrecognised,
  };
}

/**
 * Writes the manifest.
 *
 * The four required fields first, in RL-5's own order, and everything the file
 * already carried after them (RL-5a). Pretty-printed with a trailing newline:
 * nothing reads it as bytes, but a file a person may open in an editor should
 * not change shape depending on which implementation last touched it.
 */
export async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  const path = join(root, MANIFEST_FILE);
  // The version follows the password, whatever the manifest handed in says:
  // the two are one fact (RL-5c), and a caller that changed one and forgot the
  // other would write a file this build then refuses to open.
  const document = {
    roost_library_version:
      manifest.password === null ? PLAIN_FORMAT_VERSION : PASSWORD_FORMAT_VERSION,
    id: manifest.id,
    name: manifest.name,
    created_at: manifest.created_at,
    ...manifest.unrecognised,
    ...(manifest.password === null ? {} : { [PASSWORD_FIELD]: manifest.password }),
  };

  // Written beside and renamed into place (RL-5d): a rewrite now moves the
  // version, and a file left half-written by a crash is not a library at all.
  // The temporary file goes in `staging/`, which the format reserves for what
  // is transient, because RL-3 forbids anything unlisted in the root, and
  // staging is swept at every open.
  const staging = join(root, STAGING_DIR);
  const temporary = join(staging, `manifest-${crypto.randomUUID()}.json`);
  try {
    await makeDirectoryInside(root, staging);
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new IoError("write", path, cause);
  }
}

/** Throws if `root` already holds a library. */
export async function refuseExistingLibrary(root: string): Promise<void> {
  const path = join(root, MANIFEST_FILE);
  try {
    await stat(path);
  } catch {
    return;
  }
  throw new AlreadyALibraryError(root);
}

/**
 * Walks up from `start` looking for a directory holding `library.json`.
 *
 * Lets the CLI be run from anywhere inside a library, the way `git` is.
 */
export async function discoverLibrary(start: string): Promise<string | undefined> {
  let current = resolve(start);
  for (;;) {
    try {
      const found = await stat(join(current, MANIFEST_FILE));
      if (found.isFile()) return current;
    } catch {
      // Keep walking: a missing manifest here says nothing about the parent.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Whether the directory is there at all. */
async function exists(root: string): Promise<boolean> {
  try {
    return (await stat(root)).isDirectory();
  } catch {
    return false;
  }
}
