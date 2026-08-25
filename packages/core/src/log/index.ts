/**
 * A structured logger with pluggable sinks.
 *
 * **Packages emit; binaries install the sinks.** `@roost/core`,
 * `@roost/library`, and the rest call {@link logger} and nothing else — they do
 * not know whether anything is listening. The CLI installs a stderr sink, and
 * the Electron main process installs a file sink under `logDir()`. Until a sink
 * is installed, records are dropped, which is the right default for a library
 * and for a test run.
 *
 * Logs never leave the machine. There is no remote sink, no batching queue, and
 * no place to add one (invariant 10).
 *
 * The sinks that touch a filesystem live in `./file.js`, so that this module —
 * which loads in every process — pulls in no `node:fs` behind it.
 */
export { type ClosableSink, fileSink, filterSink, teeSink } from "./file.js";

/** Ordered from most to least verbose. */
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

const SEVERITY: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

/**
 * Structured context attached to a record.
 *
 * Flat and JSON-safe on purpose: a sink writes one line per record, and a
 * nested object turns log greppability into log parsing.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface LogRecord {
  /** Unix milliseconds. Everything else in Roost is seconds; a log is not. */
  readonly ts: number;
  readonly level: LogLevel;
  /** The subsystem, so a line can be traced without a stack. */
  readonly scope: string;
  readonly message: string;
  readonly fields: LogFields;
}

export interface Sink {
  write(record: LogRecord): void;
}

let sink: Sink | undefined;
let threshold: LogLevel = "info";

/** Installs the sink. Called by a binary, once, at start. */
export function setSink(next: Sink | undefined): void {
  sink = next;
}

/** Records below this level are dropped before they are formatted. */
export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export function logLevel(): LogLevel {
  return threshold;
}

/**
 * Whether a record at `level` would be written.
 *
 * For hot paths only. Import runs per file, and building a fields object for a
 * record nobody will keep is a real allocation — but reaching for this
 * everywhere would be noise, so it is here for the loop that needs it and not
 * for the code that does not.
 */
export function isEnabled(level: LogLevel): boolean {
  return sink !== undefined && SEVERITY[level] >= SEVERITY[threshold];
}

export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger with the same scope and `fields` merged into every record. */
  child(fields: LogFields): Logger;
}

/**
 * A logger for one subsystem — `"import"`, `"journal"`, `"db"`.
 *
 * The scope is what makes a log readable at import speed, where several
 * subsystems interleave thousands of lines.
 */
export function logger(scope: string, bound: LogFields = {}): Logger {
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    // Level first, so a dropped record costs one comparison and no object.
    if (!isEnabled(level)) return;
    sink?.write({
      ts: Date.now(),
      level,
      scope,
      message,
      fields: fields === undefined ? bound : { ...bound, ...fields },
    });
  };

  return {
    trace: (message, fields) => emit("trace", message, fields),
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => logger(scope, { ...bound, ...fields }),
  };
}

/**
 * One JSON object per line, for a file a machine will read back.
 *
 * Deliberately not the journal's format and deliberately not in a library: a
 * log is per-machine state (`platform/dirs.ts`), and the binding layout has no
 * room for one.
 */
export function jsonLine(record: LogRecord): string {
  const { ts, level, scope, message, fields } = record;
  return `${JSON.stringify({ ts, level, scope, message, ...fields })}\n`;
}

/**
 * A line for a person watching a terminal.
 *
 * Written through `process.stderr` rather than `console`: `console.error`
 * carries its own formatting and its own buffering, and a logger that shares
 * neither is easier to reason about when it is interleaved with a progress
 * meter. It also keeps `noConsole` meaningful everywhere else.
 */
export function prettyLine(record: LogRecord): string {
  const time = new Date(record.ts).toISOString().slice(11, 23);
  const level = record.level.toUpperCase().padEnd(5);
  const entries = Object.entries(record.fields);
  const tail = entries.length === 0 ? "" : ` ${entries.map(([k, v]) => `${k}=${v}`).join(" ")}`;
  return `${time} ${level} ${record.scope}: ${record.message}${tail}\n`;
}

/** Writes to stderr, so stdout stays available for a command's actual output. */
export function stderrSink(format: (record: LogRecord) => string = prettyLine): Sink {
  return {
    write(record) {
      process.stderr.write(format(record));
    },
  };
}

/**
 * Collects records instead of writing them. For tests.
 *
 * `CollectingLogSink`, not `CollectingSink`: the journal has one of those, and
 * the two are unrelated. The same collision as `JournalRecord` against
 * TypeScript's own `Record`, and it is worth the longer name for the same
 * reason — a package with one export surface cannot have two things called the
 * obvious thing.
 */
export class CollectingLogSink implements Sink {
  readonly records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }
}
