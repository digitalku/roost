import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { logDir } from "../platform/dirs.js";
import { jsonLine, LOG_LEVELS, type LogLevel, type LogRecord, type Sink } from "./index.js";

/**
 * Sinks that write somewhere, and the one that writes to two places at once.
 *
 * Kept apart from the logger itself so that `log/index.ts` touches no
 * filesystem: it loads in every process, and the one that only emits should not
 * be dragging `node:fs` in behind it.
 */

/** A sink that also has to be closed, because it holds a descriptor. */
export interface ClosableSink extends Sink {
  close(): void;
}

/**
 * Appends one JSON object per line to a dated file under `logDir()`.
 *
 * **Written synchronously, on purpose.** A buffered stream loses its tail when
 * the process dies, and the process dying is the case a log exists for. The
 * writes are a few microseconds each against a local file, and the level that
 * would make them frequent — debug — is opt-in.
 *
 * One file per UTC day. There is no pruning yet; `TODO.md` records it.
 */
export function fileSink(
  directory: string = logDir(),
  now: () => Date = () => new Date(),
): ClosableSink {
  mkdirSync(directory, { recursive: true });

  let day = "";
  let fd = -1;

  const ensure = (): number => {
    const today = now().toISOString().slice(0, 10);
    if (today === day && fd !== -1) return fd;
    if (fd !== -1) closeSync(fd);
    day = today;
    fd = openSync(join(directory, `roost-${today}.log`), "a");
    return fd;
  };

  return {
    write(record: LogRecord): void {
      try {
        writeSync(ensure(), jsonLine(record));
      } catch {
        // A log that cannot be written must not take the application with it.
        // There is nowhere to report this to that is not itself the log.
      }
    },
    close(): void {
      if (fd === -1) return;
      closeSync(fd);
      fd = -1;
      day = "";
    },
  };
}

/**
 * Writes every record to each sink in turn.
 *
 * The desktop app wants both: a file for afterwards, and stderr for the
 * terminal it was started from. One sink at a time is the logger's design, so
 * the fan-out belongs here rather than in a list inside it.
 */
export function teeSink(...sinks: readonly Sink[]): Sink {
  return {
    write(record: LogRecord): void {
      for (const sink of sinks) sink.write(record);
    },
  };
}

/**
 * Passes records at `level` and above to `sink`, dropping the rest.
 *
 * The logger's own threshold decides what is *formatted at all*; this decides
 * what each destination gets. The desktop app wants both at once — everything
 * in the file, because that is read after the fact, and warnings only in the
 * terminal, because that is read while working.
 */
export function filterSink(level: LogLevel, sink: Sink): Sink {
  const floor = LOG_LEVELS.indexOf(level);
  return {
    write(record: LogRecord): void {
      if (LOG_LEVELS.indexOf(record.level) >= floor) sink.write(record);
    },
  };
}
