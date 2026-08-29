import {
  check,
  type DoctorReport,
  hasDamage,
  isClean,
  type Missing,
  reclaim,
  reclaimableBytes,
  unsoundForReclaim,
} from "@roost/library";
import { capabilities, decoderVersions } from "@roost/media";
import { bytes, seconds } from "../format.js";
import { EXIT, type Streams } from "../io.js";
import { withLibrary } from "../open.js";

export interface DoctorOptions {
  readonly deep: boolean;
  readonly reclaim: boolean;
  /** Reclaim even when the index and the object store disagree. */
  readonly force: boolean;
  readonly examples: number;
}

/**
 * `roost doctor` — checks a library against itself, and optionally reclaims.
 *
 * Exits 1 when it finds damage, so a scheduled run is a check rather than a
 * report nobody reads. Orphans alone are not damage: they cost space and
 * nothing else.
 */
export async function doctor(
  root: string,
  options: DoctorOptions,
  streams: Streams,
): Promise<number> {
  return withLibrary(root, async (library) => {
    const report = await check(library, {
      deep: options.deep,
      onProgress: (stage, count) => streams.progress(`  ${stage} checked: ${count}`),
    });

    print(report, options.examples, streams.out);
    await printCapabilities(streams.out);

    if (options.reclaim) {
      const freed = await reclaim(
        library,
        report,
        options.force ? "even-if-damaged" : "only-if-sound",
      );
      streams.out("");
      streams.out(`Reclaimed ${bytes(freed)} from ${report.orphans.length} object(s)`);
    }

    return hasDamage(report) ? EXIT.failed : EXIT.ok;
  });
}

/**
 * What this machine can draw.
 *
 * Printed by `doctor` rather than by a command of its own, for the reason
 * ADR-0013 gave about the decoder build: "video thumbnails are missing" and
 * "video thumbnails are broken" have one cause and no other symptom, and the
 * place someone looks when something is wrong is here.
 */
async function printCapabilities(out: (line: string) => void): Promise<void> {
  out("");
  out("Backends");
  for (const capability of await capabilities()) {
    const mark = capability.available ? " " : "!";
    const version = capability.version === null ? "" : ` ${capability.version}`;
    out(`  ${mark} ${capability.name}${version} — ${capability.detail}`);
  }
}

function print(report: DoctorReport, examples: number, out: (line: string) => void): void {
  out(
    `Checked ${report.assets} asset(s) and ${report.objects} object(s) in ${seconds(report.elapsedMs)}`,
  );
  // Which decoder is loaded, always: "thumbnails are slow" and "thumbnails
  // crash the engine" have the same cause and no other symptom.
  const versions = decoderVersions();
  out(`  sharp ${versions.sharp} (${versions.build} build), libvips ${versions.libvips}`);
  if (!report.deep) out("  shallow run — pass --deep to re-hash every object");

  if (isClean(report)) {
    out("");
    out("Nothing wrong.");
    return;
  }

  section(out, "Objects nothing references", report.orphans.length, examples, () =>
    report.orphans.map((orphan) => `${orphan.hash.slice(0, 12)}  ${bytes(orphan.bytes)}`),
  );
  if (report.orphans.length > 0) {
    out(`  ${bytes(reclaimableBytes(report))} reclaimable — pass --reclaim to delete them`);
  }

  section(out, "Assets whose bytes are gone", report.missingObjects.length, examples, () =>
    report.missingObjects.map(describeMissing),
  );
  section(
    out,
    "Referenced originals that moved or were deleted",
    report.missingReferences.length,
    examples,
    () => report.missingReferences.map(describeMissing),
  );
  section(out, "Objects that no longer match their hash", report.corrupt.length, examples, () =>
    report.corrupt.map(
      (entry) => `${entry.expectedHash.slice(0, 12)} is now ${entry.actualHash.slice(0, 12)}`,
    ),
  );
  section(out, "Search rows for assets that are gone", report.orphanSearchRows, examples, () => []);
  section(
    out,
    "Files in journal/ that replay will not read",
    report.strayJournalFiles.length,
    examples,
    // A month replay cannot see is a month the index does not hold, and the
    // only sign of it before a rebuild is this line.
    () => report.strayJournalFiles,
  );

  const unsound = unsoundForReclaim(report);
  if (unsound !== undefined) {
    out("");
    out(`Reclaiming is refused while this stands: ${unsound}`);
    out("  Run `roost rebuild` if the index is what is wrong — it is derived, and");
    out("  that is what rebuild is for. Pass --force if the bytes are really gone.");
  }
}

function describeMissing(missing: Missing): string {
  return `${missing.hash.slice(0, 12)}  ${missing.origName} — expected at ${missing.expected}`;
}

function section(
  out: (line: string) => void,
  title: string,
  count: number,
  examples: number,
  lines: () => string[],
): void {
  if (count === 0) return;
  out("");
  out(`${title}: ${count}`);
  const shown = lines().slice(0, examples);
  for (const line of shown) out(`  ${line}`);
  // Never a silent truncation: a list that stopped without saying so reads as
  // the whole answer.
  if (count > shown.length && shown.length > 0) {
    out(`  … and ${count - shown.length} more`);
  }
}
