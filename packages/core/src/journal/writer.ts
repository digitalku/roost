import type { FileHandle } from "node:fs/promises";
import { open as fsOpen, readdir } from "node:fs/promises";
import { join } from "node:path";
import { InvalidTimestampError, IoError } from "../model/index.js";
import { makeDirectoryInside } from "../storage/inside.js";
import { type JournalRecord, toLine } from "./op.js";

/** Directory name for the journal inside a library. */
export const JOURNAL_DIR = "journal";

/**
 * Lines accumulate here before reaching the file. One `write` per record would
 * make a 100k-file import a syscall per asset; the flush points are a full
 * buffer, a month rotation, and any explicit `sync`.
 */
const BUFFER_LIMIT_BYTES = 64 * 1024;

/**
 * Formats a unix timestamp as the `YYYY-MM` file key, in UTC (RL-28a).
 *
 * UTC rather than local time, and that is a requirement rather than a
 * convenience: a record written at 02:00 on 1 February in Jakarta would land in
 * `2026-01.jsonl`, and the same library carried one time zone east would start
 * writing the same instant into a different file.
 */
export function monthKey(ts: number): string {
  if (!Number.isSafeInteger(ts)) throw new InvalidTimestampError(ts);
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) throw new InvalidTimestampError(ts);
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isMonthKey(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

/**
 * Lists `YYYY-MM.jsonl` files in `dir`, oldest first.
 *
 * `YYYY-MM` sorts chronologically as a string, which is why replay can rely on
 * a plain lexicographic sort rather than parsing dates.
 */
export async function monthsIn(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new IoError("readdir", dir, cause);
  }

  return entries
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length))
    .filter(isMonthKey)
    .sort();
}

/**
 * Files in `dir` that replay will never read.
 *
 * A journal file not named `YYYY-MM.jsonl` is invisible to replay. That is
 * correct — the name is how replay orders months — but it is *silent*, so a
 * backup tool, an editor's `.bak`, or someone renaming a month by hand loses
 * that month with no complaint at all. `roost doctor` reports what it finds
 * here, which is the only place the loss is visible before a rebuild.
 *
 * Defined next to {@link monthsIn} on purpose: two definitions of "a journal
 * file" would drift, and the one that drifted would be the one nobody ran.
 */
export async function strayFilesIn(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new IoError("readdir", dir, cause);
  }

  return entries
    .filter((name) => !(name.endsWith(".jsonl") && isMonthKey(name.slice(0, -".jsonl".length))))
    .sort();
}

/**
 * Appends records to `journal/YYYY-MM.jsonl`.
 *
 * The journal is the source of truth, so ordering is not negotiable: append
 * here *before* touching the index. A row that reaches `index.db` without a
 * journal line is silent data loss on the next rebuild.
 *
 * Files are opened in append mode and never rewritten in place (RL-27, RL-31).
 * Which month a record lands in follows the
 * record's own `ts`, not the wall clock, so writing and replaying agree even
 * when a batch straddles midnight on the first of a month.
 *
 * **`close()` is not optional.** The Rust implementation flushes on `Drop`;
 * JavaScript has no equivalent, so a `Journal` that is dropped without closing
 * loses whatever was still buffered.
 */
export class Journal {
  readonly dir: string;

  #handle: FileHandle | null = null;
  #openMonth: string | null = null;
  #buffer: string[] = [];
  #buffered = 0;

  private constructor(dir: string) {
    this.dir = dir;
  }

  /** Opens the journal for a library, creating the directory if needed. */
  static async open(libraryRoot: string): Promise<Journal> {
    const dir = join(libraryRoot, JOURNAL_DIR);
    await makeDirectoryInside(libraryRoot, dir);
    return new Journal(dir);
  }

  pathFor(month: string): string {
    return join(this.dir, `${month}.jsonl`);
  }

  /** Every month file present, oldest first. */
  months(): Promise<string[]> {
    return monthsIn(this.dir);
  }

  /** Appends one record. Buffered — call `sync()` to make it durable. */
  async append(record: JournalRecord): Promise<void> {
    const month = monthKey(record.ts);
    if (this.#openMonth !== month) await this.#rotateTo(month);

    const line = toLine(record);
    this.#buffer.push(line);
    this.#buffered += Buffer.byteLength(line);
    if (this.#buffered >= BUFFER_LIMIT_BYTES) await this.#flush();
  }

  /**
   * Appends a batch, then makes the whole batch durable at once.
   *
   * One `fdatasync` per batch rather than per record: an import of 100k files
   * would otherwise spend most of its time waiting on the disk.
   */
  async appendAll(records: readonly JournalRecord[]): Promise<void> {
    for (const record of records) await this.append(record);
    await this.sync();
  }

  /** Flushes buffers and asks the OS to persist them. */
  async sync(): Promise<void> {
    await this.#flush();
    if (!this.#handle) return;
    try {
      await this.#handle.datasync();
    } catch (cause) {
      throw new IoError("datasync", this.pathFor(this.#openMonth ?? "?"), cause);
    }
  }

  /** Flushes, persists, and releases the file handle. */
  async close(): Promise<void> {
    await this.sync();
    const handle = this.#handle;
    this.#handle = null;
    this.#openMonth = null;
    if (handle) await handle.close();
  }

  async #flush(): Promise<void> {
    if (this.#buffer.length === 0 || !this.#handle) return;
    const payload = this.#buffer.join("");
    this.#buffer = [];
    this.#buffered = 0;
    try {
      await this.#handle.write(payload);
    } catch (cause) {
      throw new IoError("write", this.pathFor(this.#openMonth ?? "?"), cause);
    }
  }

  async #rotateTo(month: string): Promise<void> {
    // Flush and close the outgoing month before leaving it, so a crash cannot
    // lose records that were only ever buffered.
    await this.sync();
    if (this.#handle) {
      await this.#handle.close();
      this.#handle = null;
    }

    const path = this.pathFor(month);
    try {
      this.#handle = await fsOpen(path, "a");
    } catch (cause) {
      throw new IoError("open", path, cause);
    }
    this.#openMonth = month;
  }
}
