import { resolve } from "node:path";
import type { StorageMode } from "@roost/core";
import {
  type EagleReport,
  type EagleSurvey,
  filesPerSecond,
  type ImportReport,
  importEagle,
  importInto,
  Library,
  rankedStages,
  resolveFolder,
  surveyEagle,
} from "@roost/library";
import { bytes, plural, rate, row, seconds } from "../format.js";

export interface ImportArgs {
  readonly paths: readonly string[];
  readonly mode: StorageMode;
  readonly tags: readonly string[];
  readonly includeHidden: boolean;
  /** A folder path — `Design/Icons` — for everything newly imported (ADR-0037). */
  readonly folder?: string;
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
    // Resolved before the walk starts, so a folder that is not there is a
    // usage error rather than a run that dies partway (ADR-0037 §2).
    const folder = args.folder === undefined ? undefined : resolveFolder(library, args.folder);
    const report = await importInto(
      library,
      args.paths.map((path) => resolve(path)),
      {
        mode: args.mode,
        tags: args.tags,
        includeHidden: args.includeHidden,
        ...(folder === undefined ? {} : { folder }),
      },
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

export interface EagleArgs {
  readonly path: string;
  readonly mode: StorageMode;
  readonly tags: readonly string[];
}

/**
 * `roost import --from-eagle <PATH> --dry-run` (ADR-0032 §6).
 *
 * Writes nothing and **opens no Roost library** — reading what is in an Eagle
 * library is a question that stands on its own, and answering it should not
 * require having somewhere to put the answer yet.
 *
 * This is not a filter. Nothing is selected from the result; it is the answer
 * to "what am I about to do", including the parts that cannot be carried.
 */
export async function surveyEagleLibrary(
  path: string,
  out: (line: string) => void,
  warn: (line: string) => void,
): Promise<void> {
  printSurvey(await surveyEagle(resolve(path)), out, warn);
  out("");
  out("  Nothing was written. Run again without --dry-run to import.");
}

/** `roost import --from-eagle <PATH>` (ADR-0032). Everything comes across. */
export async function runEagleImport(
  root: string,
  args: EagleArgs,
  out: (line: string) => void,
  progress: (line: string) => void,
  warn: (line: string) => void,
): Promise<void> {
  const source = resolve(args.path);
  const library = await Library.open(root);
  try {
    const report = await importEagle(
      library,
      source,
      { mode: args.mode, tags: args.tags },
      (done, total) => progress(`  ${done} of ${total} items`),
    );
    printEagleReport(report, out, warn);
  } finally {
    await library.close();
  }
}

function printSurvey(
  survey: EagleSurvey,
  out: (line: string) => void,
  warn: (line: string) => void,
): void {
  out(`Eagle ${survey.version} · ${plural(survey.items, "item")} · ${bytes(survey.bytes)}`);
  out(
    row(
      "",
      `${plural(survey.folders, "folder")} · ${plural(survey.tags.length, "tag")} · ` +
        `${survey.rated} rated · ${plural(survey.notes, "note")} · ` +
        `${plural(survey.sources, "URL")} · ${plural(survey.comments, "comment")} · ` +
        `${plural(survey.subtitles, "subtitle")} · ${survey.trashed} in Eagle's trash`,
      1,
      0,
    ),
  );

  out("");
  out("  Not carried across:");
  out(row("", "Eagle's own thumbnails — Roost derives its own", 2, 0));
  out(row("", "colour palettes, smart folders, quick access", 2, 0));
  // Said here rather than discovered later: it cannot be recovered once the
  // Eagle library is gone, and it is the one thing the mapping loses (§7).
  out(row("", "Eagle's \"date added\" — every asset will carry this import's date,", 2, 0));
  out(row("", "though the original file's own date is kept", 2, 0));

  if (survey.renamedFolders.length > 0) {
    warn("");
    warn(`${survey.renamedFolders.length} folder name(s) contain "/" and will be rewritten:`);
    for (const rename of survey.renamedFolders.slice(0, 10)) {
      warn(`  ${rename.from} → ${rename.to}`);
    }
  }
  if (survey.missing.length > 0) {
    warn("");
    warn(`${survey.missing.length} item(s) have no file where Eagle says it is:`);
    for (const name of survey.missing.slice(0, 10)) warn(`  ${name}`);
  }
  if (survey.unreadable.length > 0) {
    warn("");
    warn(`${survey.unreadable.length} item(s) have metadata that could not be read:`);
    for (const dir of survey.unreadable.slice(0, 10)) warn(`  ${dir}`);
  }
}

function printEagleReport(
  report: EagleReport,
  out: (line: string) => void,
  warn: (line: string) => void,
): void {
  out(
    `Imported ${plural(report.survey.items, "item")} from an Eagle ${report.survey.version} library`,
  );
  // Files and assets are different numbers here, and both are worth saying: a
  // subtitle is an asset of its own (ADR-0025), so a library of 14 items with
  // one `.srt` beside a film writes 15 files.
  out(
    row(
      "",
      `${plural(report.assets, "asset")} · ${plural(report.imported, "file")} written · ` +
        `${report.duplicates} already in the library`,
      1,
      0,
    ),
  );
  if (report.collapsed > 0) {
    // The one number that reads as data loss if it arrives unexplained.
    out(
      row(
        "",
        `${plural(report.collapsed, "item")} had bytes identical to another and became one asset`,
        1,
        0,
      ),
    );
  }
  out(
    row(
      "",
      `${plural(report.folders, "folder")} · ${report.tagged} tagged · ` +
        `${report.ratings} rated · ${plural(report.notes, "note")} · ` +
        `${plural(report.sources, "URL")} · ${plural(report.comments, "comment")}`,
      1,
      0,
    ),
  );
  if (report.tagGroups > 0) out(row("", plural(report.tagGroups, "tag group"), 1, 0));
  if (report.preserved > 0) {
    // Eagle fills what is empty and never overwrites (ADR-0032 §8), so this is
    // the import declining to say something — which is invisible afterwards
    // unless it is counted here.
    out(
      row(
        "",
        `${plural(report.preserved, "rating, note or URL")} left as it was, ` +
          "because this library already had one",
        1,
        0,
      ),
    );
  }
  if (report.subtitles > 0) {
    out(row("", `${plural(report.subtitles, "subtitle")} attached to the film beside them`, 1, 0));
  }
  if (report.trashed > 0) {
    out(row("", `${report.trashed} moved to Roost's trash, as they were in Eagle's`, 1, 0));
  }
  out(row("", `${bytes(report.bytes)} added · ${seconds(report.elapsed)}`, 1, 0));

  if (report.failed.length > 0) {
    warn("");
    warn(`${report.failed.length} file(s) could not be imported:`);
    for (const failure of report.failed.slice(0, 10)) {
      warn(`  ${failure.path}: ${failure.reason}`);
    }
    if (report.failed.length > 10) warn(`  … and ${report.failed.length - 10} more`);
  }
}
