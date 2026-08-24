import { isClean } from "@roost/core";
import { Library } from "@roost/library";
import { row } from "../format.js";

export async function rebuild(
  root: string,
  out: (line: string) => void,
  warn: (line: string) => void,
): Promise<void> {
  // Exclusive: a rebuild deletes `index.db` out from under anything else
  // holding it open, which is exactly what the single-instance lock is for.
  const library = await Library.open(root, { exclusive: true });
  try {
    const before = library.stats().assets;
    const report = await library.rebuild();
    const after = library.stats().assets;

    out(`Replayed ${report.applied} records from ${report.months.length} month(s)`);
    out(row("assets", `${before} before, ${after} after`));

    if (report.unknownOps.size > 0) {
      // Not a failure. A library written by a newer Roost carries operations
      // this build has never seen, and skipping them is what lets it open at
      // all (`STORAGE_SPEC.md` §Journal Format).
      warn(`Skipped ${report.unknownOps.size} operation type(s) from a newer build:`);
      for (const [op, count] of report.unknownOps) warn(row(op, count, 1, 24));
    }
    for (const line of report.tornTrailing) {
      warn(`Ignored a torn final line in ${line.month}, line ${line.line} — a write that was`);
      warn("interrupted. Nothing before it was affected.");
    }
    for (const line of report.malformed) {
      warn(`UNREADABLE ${line.month} line ${line.line}: ${line.reason}`);
    }
    if (report.malformed.length > 0) {
      warn("Those lines are data loss, not a version gap. The index is now missing whatever");
      warn("they described.");
    }

    if (before !== after && isClean(report)) {
      // The journal is the source of truth, so "after" is the honest number and
      // "before" was the one that had drifted. Worth saying out loud either way.
      warn(
        `The rebuilt index differs from the one it replaced: ${before} assets before, ${after} after.`,
      );
    }

    out("");
    out("Thumbnails are derived and were not journalled. Run `roost thumb` to restore them.");
  } finally {
    await library.close();
  }
}
