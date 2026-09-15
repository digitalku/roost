import type { JournalNotice } from "@roost/library";
import { Library } from "@roost/library";

/**
 * Where a library's journal notice goes.
 *
 * Installed once by `run`, the way the log sink is, rather than threaded
 * through forty call sites of {@link withLibrary}. RL-28 requires the **person**
 * be told when a journal holds operations this build cannot apply, and every
 * command that opens a library is a place that has to say it — so the saying
 * belongs at the open rather than in each command.
 */
let announce: ((line: string) => void) | undefined;

export function setNoticeSink(warn: (line: string) => void): void {
  announce = warn;
}

/**
 * Opens a library, runs `body`, and closes it however that ends.
 *
 * Closing is not optional: the journal buffers, and a library dropped without
 * closing loses whatever had not been flushed. Every command that touches one
 * goes through here rather than remembering to write the `finally` itself.
 */
export async function withLibrary<T>(
  root: string,
  body: (library: Library) => Promise<T>,
): Promise<T> {
  const library = await Library.open(root);
  try {
    if (announce !== undefined) for (const line of noticeLines(library.notice)) announce(line);
    return await body(library);
  } finally {
    await library.close();
  }
}

/**
 * What to say about what the journal held and this build could not use.
 *
 * Empty when there is nothing to say, which is the ordinary case: a notice
 * printed before every command would be a notice nobody reads.
 *
 * The two halves are deliberately different in weight. An unrecognised
 * operation means **another build holds meaning this one cannot show**, and the
 * person can act on that by opening the library there — RL-28 requires it be
 * said. A dangling reference is the ordinary result of editing one library from
 * two builds, so it is one line and no advice (RL-26a).
 */
export function noticeLines(notice: JournalNotice): string[] {
  const lines: string[] = [];

  for (const skipped of notice.skipped) {
    const whose =
      skipped.platformLabel === null
        ? "a later revision of the library format"
        : skipped.platformLabel;
    lines.push(`Skipped ${skipped.count} × ${skipped.op} — ${whose} wrote it.`);
  }
  if (notice.skipped.length > 0) {
    lines.push("Those records are still in the journal, and are not lost. Open the library in");
    lines.push("the build that wrote them to see what they say.");
  }

  if (notice.dangling > 0) {
    lines.push(
      `${notice.dangling} record(s) named something that is not in the library, and were skipped.`,
    );
  }

  return lines;
}
