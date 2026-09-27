import { resolve } from "node:path";
import type { Take } from "@roost/core";
import { type TransferReport, transferToLibrary } from "@roost/library";
import { assets, resolveAll } from "../assets.js";
import { bytes } from "../format.js";
import { EXIT, type Streams } from "../io.js";
import { withLibrary } from "../open.js";

/**
 * `roost move` and `roost copy`: assets into another library (ADR-0054).
 *
 * One function for both, because they are one transfer that differs only in
 * its last step. The target is opened exclusively for the length of the run,
 * so a library a window has open is refused rather than written under it.
 */
export async function transfer(
  root: string,
  target: string,
  needles: readonly string[],
  take: Take,
  streams: Streams,
): Promise<number> {
  return withLibrary(root, async (library) => {
    const ids = resolveAll(library, needles);
    // Ctrl+C stops the transfer the way the window's × does (ADR-0054 §3.9):
    // what has arrived stays arrived, and a move still removes it from here.
    // Killing the process instead would leave those in both libraries, which
    // is safe but needs the command run again to finish.
    const controller = new AbortController();
    const stop = (): void => {
      streams.warn("Stopping — what has arrived stays there, and the rest stays here.");
      controller.abort();
    };
    process.once("SIGINT", stop);
    // A few times a second at most: a counted copy reports every four
    // megabytes, and a terminal redrawing faster than that is only flicker.
    let told = 0;
    const report = await transferToLibrary(
      library,
      resolve(target),
      ids,
      { take, signal: controller.signal },
      (running) => {
        const now = performance.now();
        if (running.done < running.total && now - told < 250) return;
        told = now;
        const percent =
          running.bytesTotal > 0 ? Math.floor((running.bytesDone / running.bytesTotal) * 100) : 0;
        streams.progress(
          `  ${percent}% · ${bytes(running.bytesDone)} of ${bytes(running.bytesTotal)} · ${running.done} of ${running.total}`,
        );
      },
    ).finally(() => process.removeListener("SIGINT", stop));
    for (const line of reportLines(report, take)) streams.out(line);
    return report.failed.length > 0 ? EXIT.failed : EXIT.ok;
  });
}

function reportLines(report: TransferReport, take: Take): string[] {
  const arrived = report.added + report.merged;
  const lines = [
    `${report.cancelled ? "Stopped. " : ""}${take === "move" ? "Moved" : "Copied"} ${assets(arrived)} (${bytes(report.bytes)} new)`,
  ];
  if (report.merged > 0) {
    lines.push(
      `  ${assets(report.merged)} already there by their bytes; what they carried was merged`,
    );
  }
  if (report.preserved > 0) {
    lines.push(
      `  ${report.preserved} ratings, notes, sources or posters kept as the target had them`,
    );
  }
  if (report.folders > 0) lines.push(`  ${report.folders} folders created in the target`);
  if (report.subtitles > 0) lines.push(`  ${report.subtitles} subtitle tracks attached again`);
  if (take === "move") lines.push(`  ${assets(report.removed)} removed from this library`);
  if (report.missing > 0) {
    lines.push(`  ${assets(report.missing)} left here: the file is not on this machine`);
  }
  for (const failure of report.failed) {
    lines.push(`  ${failure.id} ${failure.name}: left here — ${failure.reason}`);
  }
  return lines;
}
