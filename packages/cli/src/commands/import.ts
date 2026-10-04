import { resolve } from "node:path";
import type { Take } from "@roost/core";
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
  readonly take: Take;
  readonly tags: readonly string[];
  readonly includeHidden: boolean;
  /** A folder path — `Design/Icons` — for everything newly imported (ADR-0037). */
  readonly folder?: string;
  /** Each directory comes across as a folder, its subdirectories as its subfolders (ADR-0058). */
  readonly structure: boolean;
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
    // Resolved before the walk starts, so a folder that is not there is a
    // usage error rather than a run that dies partway (ADR-0037 §2).
    const folder = args.folder === undefined ? undefined : resolveFolder(library, args.folder);
    let handled = 0;
    const tell = throttled();
    const report = await stoppable(warn, (signal) =>
      importInto(
        library,
        args.paths.map((path) => resolve(path)),
        {
          take: args.take,
          tags: args.tags,
          includeHidden: args.includeHidden,
          structure: args.structure,
          ...(folder === undefined ? {} : { folder }),
          signal,
          // The sources are counted first, so the line has a total from the
          // start (ADR-0055 §3.1).
          onBytes: (running) =>
            tell(false, () =>
              progress(
                running.counting
                  ? `  counting… ${running.files} files · ${bytes(running.bytesTotal)}`
                  : `  ${percent(running.bytesDone, running.bytesTotal)}% · ` +
                      `${bytes(running.bytesDone)} of ${bytes(running.bytesTotal)} · ` +
                      `${handled} of ${running.files}`,
              ),
            ),
        },
        (_path, running) => {
          handled = running.imported + running.duplicates + running.failed.length;
        },
      ),
    );

    printReport(report, out, warn);
  } finally {
    await library.close();
  }
}

/**
 * Runs an import that `Ctrl+C` stops the way the window's × does (ADR-0055
 * §3.4): the batch in hand is committed and the report printed. Killing the
 * process instead could leave a placed file that nothing journalled. A second
 * `Ctrl+C` is Node's own, and exits at once.
 */
async function stoppable<T>(
  warn: (line: string) => void,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const stop = (): void => {
    warn("Stopping — what has arrived stays, and running the import again brings the rest.");
    controller.abort();
  };
  process.once("SIGINT", stop);
  try {
    return await run(controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
  }
}

/**
 * A few lines a second at most: the hash reports every chunk it reads, and a
 * terminal redrawing faster than that is only flicker. `now` forces one.
 */
function throttled(): (now: boolean, send: () => void) => void {
  let told = Number.NEGATIVE_INFINITY;
  return (now, send) => {
    const at = performance.now();
    if (!now && at - told < 250) return;
    told = at;
    send();
  };
}

function percent(done: number, total: number): number {
  return total > 0 ? Math.floor((done / total) * 100) : 0;
}

function printReport(
  report: ImportReport,
  out: (line: string) => void,
  warn: (line: string) => void,
): void {
  out(
    `${report.cancelled ? "Stopped. " : ""}Imported ${report.imported} of ${report.scanned} files scanned`,
  );
  if (report.folders > 0) out(row("", `${plural(report.folders, "folder")} made`, 1, 0));
  if (report.duplicates > 0) out(row("", `${report.duplicates} already in the library`, 1, 0));
  // What happened to the source files, which RL-26 requires be said out loud:
  // a move is not undoable by looking at the library afterwards.
  if (report.moved > 0) out(row("", `${report.moved} moved out of where they were`, 1, 0));
  if (report.copied > 0) out(row("", `${report.copied} copied, leaving the originals`, 1, 0));
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
  readonly take: Take;
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
    const tell = throttled();
    const report = await stoppable(warn, (signal) =>
      importEagle(library, source, { take: args.take, tags: args.tags, signal }, (running) =>
        tell(running.done === running.total, () =>
          progress(
            `  ${percent(running.bytesDone, running.bytesTotal)}% · ` +
              `${bytes(running.bytesDone)} of ${bytes(running.bytesTotal)} · ` +
              `${running.done} of ${running.total} items`,
          ),
        ),
      ),
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
    report.cancelled
      ? `Stopped after ${plural(report.assets, "asset")} of ${plural(report.survey.items, "item")} from an Eagle ${report.survey.version} library; run it again to bring the rest`
      : `Imported ${plural(report.survey.items, "item")} from an Eagle ${report.survey.version} library`,
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
