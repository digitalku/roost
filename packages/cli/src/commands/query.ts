import { matches, pages } from "@roost/library";
import { bytes } from "../format.js";
import { withLibrary } from "../open.js";

/** How many rows one statement fetches, however many the caller asked to see. */
const MAX_PAGE = 500;

export interface QueryOptions {
  readonly query: string;
  readonly limit: number;
  /** Print the number of matches instead of the matches. */
  readonly countOnly: boolean;
  /** One hash per line, for piping into another command. */
  readonly hashesOnly: boolean;
}

export async function query(
  root: string,
  options: QueryOptions,
  out: (line: string) => void,
): Promise<void> {
  await withLibrary(root, async (library) => {
    if (options.countOnly) {
      out(String(matches(library, options.query)));
      return;
    }

    let shown = 0;
    // Paged rather than fetched whole: `--limit 1000000` on a million-asset
    // library must not be a million rows in memory before the first line prints.
    for (const hits of pages(library, options.query, Math.min(options.limit, MAX_PAGE))) {
      for (const hit of hits) {
        if (shown >= options.limit) return;
        shown += 1;

        if (options.hashesOnly) {
          out(hit.hash);
          continue;
        }

        const stars = "*".repeat(Math.max(0, Math.min(hit.rating ?? 0, 5)));
        const mark = hit.isFavorite ? "♥" : " ";
        out(
          `${hit.hash.slice(0, 12)}  ${mark} ${stars.padEnd(5)} ${bytes(hit.size).padStart(9)}  ${hit.origName}`,
        );
      }
    }
  });
}
