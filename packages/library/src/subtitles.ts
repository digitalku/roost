import { stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { type ContentHash, logger } from "@roost/core";
import { hashFile, SUBTITLE_EXTENSIONS } from "@roost/media";
import { attachSubtitle } from "./edit.js";
import { importInto } from "./import.js";
import type { Library } from "./library.js";

/**
 * Eagle's convention, kept as a heuristic (ADR-0025 §3).
 *
 * Dropping `film.srt` beside `film.mkv` is how everybody expects a subtitle to
 * be found, and it is worth honouring — but **adjacency proposes the
 * attachment and the journal line is what makes it true**. Once imported,
 * moving either file changes nothing, which is the whole point of not reading
 * meaning out of a directory.
 */

const KNOWN = new Set<string>(SUBTITLE_EXTENSIONS);

/**
 * Video and audio containers a track is looked for beside.
 *
 * A list rather than a probe: this runs beside the file that was *just*
 * imported, and sniffing every candidate would be a read per extension for a
 * question a name already answers well enough to propose an attachment.
 */
const MEDIA_EXTENSIONS = ["mkv", "mp4", "m4v", "webm", "mov", "avi", "mp3", "m4a", "flac", "wav"];

const log = logger("subtitles");

/** Whether a path names a subtitle Roost knows how to attach. */
export function isSubtitlePath(path: string): boolean {
  return KNOWN.has(extname(path).replace(/^\./, "").toLowerCase());
}

/**
 * The language a filename declares, or `undefined`.
 *
 * `film.id.srt` says Indonesian; `film.srt` says nothing. Only a two- or
 * three-letter suffix is believed — anything else is part of the name, and a
 * guess stored as a language would be worse than the `NULL` the schema allows.
 */
export function languageFrom(name: string): string | undefined {
  const stem = basename(name, extname(name));
  const suffix = extname(stem).replace(/^\./, "");
  return /^[a-z]{2,3}$/i.test(suffix) ? suffix.toLowerCase() : undefined;
}

/** The name the media file would have, with the language suffix taken off. */
function stemOf(path: string): string {
  const stem = basename(path, extname(path));
  return languageFrom(path) === undefined ? stem : basename(stem, extname(stem));
}

/**
 * Attaches each imported subtitle to the media file beside it, if there is one
 * and the library holds it.
 *
 * **The sibling is found by hashing it, not by remembering it.** Holding a map
 * of every video an import walked past would be memory proportional to the
 * library, which the pipeline is built to avoid — and hashing costs almost
 * nothing here: the file was very likely just read, and anything over 50 MiB
 * takes the partial hash, which is two 64 KB reads and a size.
 *
 * It also makes the heuristic work **across runs**. Drop an `.srt` next to a
 * film imported last month, import just the `.srt`, and it attaches — where a
 * within-one-run pairing would have found nothing.
 */
export async function attachSiblings(
  library: Library,
  tracks: readonly { readonly path: string; readonly hash: ContentHash }[],
): Promise<number> {
  let attached = 0;

  for (const track of tracks) {
    const stem = stemOf(track.path);
    const folder = dirname(track.path);

    for (const ext of MEDIA_EXTENSIONS) {
      const candidate = join(folder, `${stem}.${ext}`);
      if (
        !(await stat(candidate).then(
          () => true,
          () => false,
        ))
      )
        continue;

      const hashed = await hashFile(candidate).catch(() => undefined);
      if (hashed === undefined) break;
      // Only what the library already holds: a film sitting beside a subtitle
      // that nobody imported is not a reason to import the film.
      if (library.db.repo.findAsset(hashed.hash) === undefined) break;

      const lang = languageFrom(track.path);
      await attachSubtitle(library, hashed.hash, track.hash, lang === undefined ? {} : { lang });
      attached += 1;
      log.debug("subtitle attached to the file beside it", {
        media: hashed.hash,
        track: track.hash,
      });
      break;
    }
  }

  return attached;
}

/**
 * Imports files and attaches them as caption tracks, in one step (ADR-0025).
 *
 * What **Add subtitle…** sends. One operation rather than an import followed by
 * an attach, because the two apart have a state between them: a track imported
 * and not attached is a stray text asset in the grid, and the caller would have
 * to learn the hash of something it only handed over a path to.
 *
 * **Always `managed`**, whatever the library's default import mode is. The
 * whole of §1 is that a track survives its source; one merely referenced from a
 * downloads folder disappears the moment that folder is tidied.
 *
 * The language is guessed from the filename by the same rule import uses —
 * `holiday.id.srt` says Indonesian — because two rules would eventually
 * disagree about the same file.
 *
 * Answers how many were attached. A file already in the library attaches
 * anyway: identical bytes are one asset, and saying the same sentence twice is
 * one sentence.
 */
export async function addSubtitles(
  library: Library,
  hash: ContentHash,
  paths: readonly string[],
): Promise<number> {
  const wanted = paths.filter((path) => isSubtitlePath(path));
  if (wanted.length === 0) return 0;

  await importInto(library, wanted, { mode: "managed" });

  let attached = 0;
  for (const path of wanted) {
    // Hashed rather than reported back by the import: the pipeline answers with
    // counts, not with a row per file, and hashing what was just read costs
    // almost nothing (`attachSiblings` above says more).
    const hashed = await hashFile(path).catch(() => undefined);
    if (hashed === undefined) continue;

    const lang = languageFrom(path);
    await attachSubtitle(library, hash, hashed.hash, lang === undefined ? {} : { lang });
    attached += 1;
  }

  return attached;
}
