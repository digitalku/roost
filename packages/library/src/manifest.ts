import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { IoError } from "@roost/core";
import { AlreadyALibraryError, LibraryTooNewError, NotALibraryError } from "./error.js";

/** `library.json` — what makes a directory a Roost library. */
export const MANIFEST_FILE = "library.json";

/** The library format this build writes and understands. */
export const LIBRARY_FORMAT_VERSION = 1;

/**
 * The manifest, in the field order and the snake_case the Rust build writes.
 *
 * The names are not a style choice here: a library written by either
 * implementation opens in the other, so `roost_library_version` and
 * `created_at` are part of the format.
 */
export interface Manifest {
  readonly roost_library_version: number;
  /** Stable identity, so a library stays recognisable after being moved. */
  readonly id: string;
  readonly name: string;
  /** Unix seconds. */
  readonly created_at: number;
}

export function newManifest(name: string, createdAt: number): Manifest {
  return {
    roost_library_version: LIBRARY_FORMAT_VERSION,
    id: crypto.randomUUID(),
    name,
    created_at: createdAt,
  };
}

export async function readManifest(root: string): Promise<Manifest> {
  const path = join(root, MANIFEST_FILE);

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new NotALibraryError(root);
    throw new IoError("read", path, cause);
  }

  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new NotALibraryError(root);
  const raw = parsed as Record<string, unknown>;

  const version = raw["roost_library_version"];
  if (typeof version !== "number" || !Number.isInteger(version)) throw new NotALibraryError(root);

  // Refuse a library from a newer build rather than guessing at a layout this
  // binary has never seen.
  if (version > LIBRARY_FORMAT_VERSION) {
    throw new LibraryTooNewError(version, LIBRARY_FORMAT_VERSION);
  }

  return {
    roost_library_version: version,
    id: typeof raw["id"] === "string" ? raw["id"] : "",
    name: typeof raw["name"] === "string" ? raw["name"] : "",
    created_at: typeof raw["created_at"] === "number" ? raw["created_at"] : 0,
  };
}

/**
 * Writes the manifest.
 *
 * Pretty-printed with a trailing newline, matching what the Rust build emits.
 * Nothing reads it as bytes, but a file a person may open in an editor should
 * not change shape depending on which implementation last touched it.
 */
export async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  const path = join(root, MANIFEST_FILE);
  try {
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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
