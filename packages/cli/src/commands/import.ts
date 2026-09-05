import { resolve } from "node:path";
import type { StorageMode } from "@roost/core";
import {
  filesPerSecond,
  type ImportReport,
  importInto,
  Library,
  rankedStages,
} from "@roost/library";
import { bytes, rate, row, seconds } from "../format.js";

export interface ImportArgs {
  readonly paths: readonly string[];
  readonly mode: StorageMode;
  readonly tags: readonly string[];
  readonly includeHidden: boolean;
}

export async function runImport(
  root: string,
  args: ImportArgs,
  out: (line: string) => void,
  progress: (line: string) => void,
  warn: (line: string) => void,
): Promise<void> {
  const library = await Library.open(root);
  try {
    let lastShown = 0;
    const report = await importInto(
      library,
      args.paths.map((path) => resolve(path)),
      { mode: args.mode, tags: args.tags, includeHidden: args.includeHidden },
      (_path, running) => {
        // Every hundred, not every file: a progress line per file costs more
        // than the import at these rates, and a terminal cannot read it anyway.
        if (running.scanned - lastShown < 100) return;
        lastShown = running.scanned;
        progress(`  scanned ${running.scanned} · imported ${running.imported}`);
      },
    );

    printReport(report, out, warn);
  } finally {
    await library.close();
  }
}

function printReport(
  report: ImportReport,
  out: (line: string) => void,
  warn: (line: string) => void,
): void {
  out(`Imported ${report.imported} of ${report.scanned} files scanned`);
  if (report.duplicates > 0) out(row("", `${report.duplicates} already in the library`, 1, 0));
  if (report.partialDuplicates > 0) {
    // Probable, not certain: their bytes could not be reached to confirm. Said
    // out loud rather than folded into the duplicate count.
    out(
      row(
        "",
        `${report.partialDuplicates} matched on a partial hash that could not be verified`,
        1,
        0,
      ),
    );
  }
  if (report.subtitles > 0) {
    // Said out loud because it is a journal write the run made on the user's
    // behalf, from a filename rather than from an instruction (ADR-0025 §3).
    out(row("", `${report.subtitles} attached to the file beside it`, 1, 0));
  }
  if (report.subtitlesUnattached > 0) {
    out(row("", `${report.subtitlesUnattached} subtitle(s) found no film beside them`, 1, 0));
  }
  out(row("", `${bytes(report.bytes)} added`, 1, 0));
  out(
    row(
      "",
      `${seconds(report.elapsed)} · ${rate(report.scanned, report.elapsed)} files/sec · ` +
        `${bytes((report.bytes / report.elapsed) * 1000)}/sec`,
      1,
      0,
    ),
  );

  out("");
  // Deliberately no percentages: files are imported several at a time, so the
  // stages overlap and their total exceeds the wall clock. A percentage of the
  // run would be a number that does not mean what it looks like.
  out("  time by stage:");
  for (const [stage, ms] of rankedStages(report.timings)) {
    out(row(stage, seconds(ms), 2, 16));
  }

  if (report.partialCollisions > 0) {
    warn("");
    warn(
      `${report.partialCollisions} file(s) shared a partial hash with an existing asset but not its`,
    );
    warn("bytes, and were refused rather than merged — merging would have lost one of the two.");
  }
  if (report.failed.length > 0) {
    warn("");
    warn(`${report.failed.length} file(s) could not be imported:`);
    for (const failure of report.failed.slice(0, 10)) {
      warn(`  ${failure.path}: ${failure.reason}`);
    }
    if (report.failed.length > 10) warn(`  … and ${report.failed.length - 10} more`);
  }
}
