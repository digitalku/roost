import { stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { type ContentHash, logger } from "@roost/core";
import { hashFile } from "@roost/media";
import { attachSubtitle } from "./edit.js";
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

const SUBTITLE_EXTENSIONS = new Set(["srt", "vtt", "ass", "ssa"]);

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
  return SUBTITLE_EXTENSIONS.has(extname(path).replace(/^\./, "").toLowerCase());
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
