import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { IoError } from "@roost/core";
import {
  AlreadyALibraryError,
  LibraryIsFormat1Error,
  LibraryNotFoundError,
  LibraryTooNewError,
  NotALibraryError,
} from "./error.js";

/** `library.json` — what makes a directory a Roost library. */
export const MANIFEST_FILE = "library.json";

/**
 * The library format this build writes and understands.
 *
 * Roost Library Format **2** (ADR-0046). Version 1 is a different format with a
 * different notion of identity, and this build does not read one — RL-6a makes
 * that a refusal by name rather than a guess.
 */
export const LIBRARY_FORMAT_VERSION = 2;

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
    roost_library_version: LIBRARY_FORMAT_VERSION,
    id: crypto.randomUUID(),
    name,
    created_at: createdAt,
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

  // RL-6a, and it is a separate sentence from the one above on purpose: a
  // version *higher* than this build's means install a newer Roost, and
  // version 1 means a library whose identity was the hash of the bytes.
  // Everything this build could do with one is a guess, so it names the format
  // and stops — no reading, no repair, no conversion, nothing written.
  if (version === 1) {
    throw new LibraryIsFormat1Error(root);
  }

  const id = raw["id"];
  if (typeof id !== "string") throw new NotALibraryError(root, "id is missing or not a string");
  const name = raw["name"];
  if (typeof name !== "string") throw new NotALibraryError(root, "name is missing or not a string");
  const createdAt = raw["created_at"];
  if (typeof createdAt !== "number" || !Number.isInteger(createdAt)) {
    throw new NotALibraryError(root, "created_at is missing or not an integer");
  }

  const unrecognised: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(REQUIRED_FIELDS as readonly string[]).includes(key)) unrecognised[key] = value;
  }

  return {
    roost_library_version: version,
    id,
    name,
    created_at: createdAt,
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
  const document = {
    roost_library_version: manifest.roost_library_version,
    id: manifest.id,
    name: manifest.name,
    created_at: manifest.created_at,
    ...manifest.unrecognised,
  };
  try {
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  } catch (cause) {
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
