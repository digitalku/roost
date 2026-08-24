import { createReadStream } from "node:fs";
import { open as fsOpen } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { IoError } from "../model/index.js";
import { isOpName, type JournalRecord, toRecord } from "./op.js";
import { monthsIn } from "./writer.js";

/**
 * Receives records in journal order.
 *
 * Deliberately synchronous. The index is `better-sqlite3`, which is
 * synchronous, and a million `await` points in a rebuild would cost more than
 * the writes. Keeping it an interface is what stops the journal from needing to
 * know the database exists.
 */
export interface ReplaySink {
  apply(record: JournalRecord): void;

  /**
   * Called once, after the last record of the last month.
   *
   * A sink that batches its writes commits the open batch here — the same
   * contract `Journal.close()` carries on the writing side, and for the same
   * reason: JavaScript has no destructor to flush in.
   *
   * It is **not** called when replay throws, deliberately. A rebuild that fails
   * halfway must not leave a half-built index behind, and an uncommitted batch
   * is discarded when the connection closes.
   */
  finish?(): void;
}

/** A line replay could not use. */
export interface SkippedLine {
  readonly month: string;
  /** 1-based, to match what a text editor shows. */
  readonly line: number;
  readonly reason: string;
}

/**
 * What a replay did, and what it could not do.
 *
 * A non-empty `malformed` or `tornTrailing` is worth surfacing to the user: it
 * means the journal lost something, and only they can judge whether it
 * mattered.
 */
export interface ReplayReport {
  readonly months: string[];
  applied: number;
  /** Operations from a newer build, counted by name. Expected, not a fault. */
  readonly unknownOps: Map<string, number>;
  readonly malformed: SkippedLine[];
  /** Trailing lines cut short by a crash mid-write. */
  readonly tornTrailing: SkippedLine[];
}

/** True when every line was applied or was a recognisable record from a newer build. */
export function isClean(report: ReplayReport): boolean {
  return report.malformed.length === 0 && report.tornTrailing.length === 0;
}

/** Collects records instead of applying them. For inspection and tests. */
export class CollectingSink implements ReplaySink {
  readonly records: JournalRecord[] = [];

  apply(record: JournalRecord): void {
    this.records.push(record);
  }
}

/**
 * Whether the file's last byte is a newline — that is, whether the final record
 * was written completely.
 */
async function endsWithNewline(path: string): Promise<boolean> {
  const handle = await fsOpen(path, "r");
  try {
    const { size } = await handle.stat();
    if (size === 0) return true;
    const byte = Buffer.allocUnsafe(1);
    await handle.read(byte, 0, 1, size - 1);
    return byte[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

/**
 * Replays every month file in `journalDir`, oldest first.
 *
 * Deliberately forgiving. A journal is the only copy of the user's work, so a
 * single bad line must never abort the recovery of everything around it — the
 * failure mode of a strict parser here is losing a library to one truncated
 * write. Every problem is counted and reported instead, and the caller decides
 * what to say about it.
 */
export async function replay(journalDir: string, sink: ReplaySink): Promise<ReplayReport> {
  const report: ReplayReport = {
    months: await monthsIn(journalDir),
    applied: 0,
    unknownOps: new Map(),
    malformed: [],
    tornTrailing: [],
  };

  for (const month of report.months) {
    await replayFile(join(journalDir, `${month}.jsonl`), month, sink, report);
  }

  sink.finish?.();
  return report;
}

async function replayFile(
  path: string,
  month: string,
  sink: ReplaySink,
  report: ReplayReport,
): Promise<void> {
  let complete: boolean;
  try {
    complete = await endsWithNewline(path);
  } catch (cause) {
    throw new IoError("read", path, cause);
  }

  const reader = createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  // One line of lookahead, so a parse failure can tell "the last line of a file
  // that was still being written" from "corruption in the middle".
  let pending: { text: string; number: number } | null = null;
  let lineNumber = 0;

  try {
    for await (const text of reader) {
      lineNumber++;
      if (pending) applyLine(pending, false);
      pending = { text, number: lineNumber };
    }
  } catch (cause) {
    throw new IoError("read", path, cause);
  }
  if (pending) applyLine(pending, true);

  function applyLine(entry: { text: string; number: number }, isLast: boolean): void {
    const text = entry.text.trim();
    if (text === "") return;

    const skipped = (reason: string): SkippedLine => ({ month, line: entry.number, reason });

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // A file that does not end in a newline was still being written when the
      // process died, so its final line is expected to be half-formed.
      // Anywhere else, it is corruption.
      if (isLast && !complete) report.tornTrailing.push(skipped("truncated write"));
      else report.malformed.push(skipped((error as Error).message));
      return;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      report.malformed.push(skipped("not a JSON object"));
      return;
    }

    const op = (parsed as Record<string, unknown>)["op"];
    if (typeof op !== "string") {
      report.malformed.push(skipped("op: missing"));
      return;
    }

    if (!isOpName(op)) {
      // Written by a newer build. Skipping with a count — never an error — is
      // what lets a library opened by an older Roost survive intact
      // (`STORAGE_SPEC.md` §Journal Format).
      report.unknownOps.set(op, (report.unknownOps.get(op) ?? 0) + 1);
      return;
    }

    try {
      sink.apply(toRecord(parsed as Record<string, unknown>));
      report.applied++;
    } catch (error) {
      // A *known* op whose fields do not parse is corruption, not a version
      // gap: this build defines those fields.
      report.malformed.push(skipped((error as Error).message));
    }
  }
}
