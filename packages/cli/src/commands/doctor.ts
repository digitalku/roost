import { availableParallelism } from "node:os";
import { DEFAULT_THREAD_POOL, threadPoolSize } from "@roost/core";
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
    // The command, on its own line and only when it would do something: this is
    // a terminal, and the one thing a terminal is better at than the window is
    // being able to run what it just printed (ADR-0040 §5).
    if (capability.install !== null) out(`      ${capability.install}`);
  }
}

function print(report: DoctorReport, examples: number, out: (line: string) => void): void {
  out(
    `Checked ${report.assets} asset(s) and ${report.files} file(s) in ${seconds(report.elapsedMs)}`,
  );
  // Which decoder is loaded, always: "thumbnails are slow" and "thumbnails
  // crash the engine" have the same cause and no other symptom.
  const versions = decoderVersions();
  out(`  sharp ${versions.sharp} (${versions.build} build), libvips ${versions.libvips}`);
  // The pool `sharp` decodes on. It cannot be raised from inside a process
  // (`threadpool.ts`), so a CLI that wanted it wider would have to be started
  // that way — which is worth saying once, here, rather than in every command
  // that turned out to be slow.
  const pool = threadPoolSize();
  out(
    pool === DEFAULT_THREAD_POOL
      ? `  threadpool ${pool} — UV_THREADPOOL_SIZE=${availableParallelism()} makes deriving ~1.5x faster`
      : `  threadpool ${pool}`,
  );
  if (!report.deep) out("  shallow run — pass --deep to re-hash every file");

  if (isClean(report)) {
    out("");
    out("Nothing wrong.");
    return;
  }

  section(out, "Files nothing references", report.orphans.length, examples, () =>
    report.orphans.map((orphan) => `${orphan.id}  ${bytes(orphan.bytes)}`),
  );
  if (report.orphans.length > 0) {
    out(`  ${bytes(reclaimableBytes(report))} reclaimable — pass --reclaim to delete them`);
  }

  section(out, "Assets whose file is gone", report.missingFiles.length, examples, () =>
    report.missingFiles.map(describeMissing),
  );
  section(
    out,
    "Files whose name is not an id — left alone, never deleted",
    report.unrecognised.length,
    examples,
    () => report.unrecognised.map((entry) => `${entry.path}  ${bytes(entry.bytes)}`),
  );
  section(out, "Ids with more than one file", report.ambiguous.length, examples, () =>
    report.ambiguous.map((entry) => `${entry.id}  ${entry.paths.join("  ")}`),
  );
  // Changed, never "corrupt": an edit and bit rot are indistinguishable in
  // version 2 (`SPEC.md` §5), and calling a person's own save damage would be
  // crying wolf at the product's main feature.
  section(
    out,
    "Files whose bytes changed since they were read",
    report.changed.length,
    examples,
    () =>
      report.changed.map(
        (entry) => `${entry.id} is now ${entry.actualHash.slice(0, 12)} — it will be read again`,
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
  return `${missing.id}  ${missing.name} — expected at ${missing.expected}`;
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
