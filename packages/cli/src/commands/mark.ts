import {
  rate as applyRate,
  emptyTrash,
  removeAssets,
  renameAsset,
  restoreAssets,
  setNote,
  setSource,
  trashAssets,
} from "@roost/library";
import { assets, resolveAll, short } from "../assets.js";
import { EXIT, type Streams, usage } from "../io.js";
import { withLibrary } from "../open.js";

/**
 * The one-asset-at-a-time edits: rating, note, favourite, display name, and
 * removal.
 */

/** Spellings of "no stars". Zero is not one of them — the schema has no zero. */
const CLEARED = new Set(["none", "clear", "-"]);

export async function rate(
  root: string,
  rating: string,
  needles: readonly string[],
  streams: Streams,
): Promise<number> {
  let stars: number | null = null;
  if (!CLEARED.has(rating)) {
    // Digits only: `Number("1e0")` is 1, and a rating typed that way is a typo
    // rather than a request.
    if (!/^\d+$/.test(rating)) {
      return usage(streams, "rate", `${rating} is not a rating — use 1 to 5, or none`);
    }
    stars = Number(rating);
  }

  return withLibrary(root, async (library) => {
    const hashes = resolveAll(library, needles);
    await applyRate(library, hashes, stars);
    streams.out(
      stars === null
        ? `Cleared the rating on ${assets(hashes.length)}`
        : `Rated ${assets(hashes.length)} ${stars}`,
    );
    return EXIT.ok;
  });
}

export async function note(
  root: string,
  needle: string,
  text: string | undefined,
  streams: Streams,
): Promise<number> {
  return withLibrary(root, async (library) => {
    const hashes = resolveAll(library, [needle]);
    const hash = hashes[0];
    if (hash === undefined) throw new Error("resolveAll returned nothing for one argument");
    await setNote(library, hash, text ?? null);
    streams.out(
      text === undefined ? `Cleared the note on ${short(hash)}` : `Set the note on ${short(hash)}`,
    );
    return EXIT.ok;
  });
}

/**
 * Where the file came from (ADR-0030).
 *
 * `undefined` clears it, the way {@link note} reads a missing argument: "no
 * source" and "remove the source" are the same state, so they are the same
 * call.
 */
export async function source(
  root: string,
  needle: string,
  url: string | undefined,
  streams: Streams,
): Promise<number> {
  return withLibrary(root, async (library) => {
    const hashes = resolveAll(library, [needle]);
    const hash = hashes[0];
    if (hash === undefined) throw new Error("resolveAll returned nothing for one argument");
    await setSource(library, hash, url ?? null);
    streams.out(
      url === undefined
        ? `Cleared the source on ${short(hash)}`
        : `Set the source on ${short(hash)}`,
    );
    return EXIT.ok;
  });
}

export async function rename(
  root: string,
  needle: string,
  name: string,
  streams: Streams,
): Promise<number> {
  return withLibrary(root, async (library) => {
    const hashes = resolveAll(library, [needle]);
    const hash = hashes[0];
    if (hash === undefined) throw new Error("resolveAll returned nothing for one argument");
    await renameAsset(library, hash, name);
    streams.out(`Renamed ${short(hash)} to ${name}`);
    streams.out("  The file on disk is still named for its hash, as it always is.");
    return EXIT.ok;
  });
}

/**
 * `roost trash` and its two other modes.
 *
 * Trashing is reversible and removing is not (ADR-0022), so they stay separate
 * verbs even though the destructive one is reachable from here: `--empty` is
 * `remove` over everything the trash holds, and saying that out loud is the
 * point of the line it prints.
 */
export async function trash(
  root: string,
  needles: readonly string[],
  streams: Streams,
): Promise<number> {
  return withLibrary(root, async (library) => {
    const hashes = resolveAll(library, needles);
    await trashAssets(library, hashes);
    streams.out(`Moved ${assets(hashes.length)} to the trash`);
    streams.out("  Nothing was deleted. `roost trash --restore` brings them back.");
    return EXIT.ok;
  });
}

export async function restore(
  root: string,
  needles: readonly string[],
  streams: Streams,
): Promise<number> {
  return withLibrary(root, async (library) => {
    const hashes = resolveAll(library, needles);
    await restoreAssets(library, hashes);
    streams.out(`Restored ${assets(hashes.length)} from the trash`);
    return EXIT.ok;
  });
}

export async function emptyTheTrash(root: string, streams: Streams): Promise<number> {
  return withLibrary(root, async (library) => {
    const removed = await emptyTrash(library);
    streams.out(`Removed ${assets(removed)} from the library`);
    streams.out("  Originals were not deleted. Nothing under originals/ is reclaimed yet.");
    return EXIT.ok;
  });
}

export async function remove(
  root: string,
  needles: readonly string[],
  streams: Streams,
): Promise<number> {
  return withLibrary(root, async (library) => {
    const hashes = resolveAll(library, needles);
    await removeAssets(library, hashes);
    streams.out(`Removed ${assets(hashes.length)} from the library`);
    streams.out("  Originals were not deleted. Nothing under originals/ is reclaimed yet.");
    return EXIT.ok;
  });
}
