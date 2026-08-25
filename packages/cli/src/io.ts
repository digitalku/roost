import { type Command, helpFor } from "./help.js";

/**
 * Where a command's output goes.
 *
 * Results on stdout, everything else on stderr, so `roost stats | grep assets`
 * works and a progress line never lands in a pipe. Passed in rather than
 * written to directly, which is what makes the whole CLI testable without a
 * subprocess.
 */
export interface Streams {
  out(line: string): void;
  warn(line: string): void;
  progress(line: string): void;
}

/** Exit codes: 0 succeeded, 1 failed, 2 the command line was wrong. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/**
 * The flags one command was given.
 *
 * Each command parses against its own option table, because two of them spell
 * the same flag differently on purpose — `roost fixture --count 1000` asks for
 * a number of files, and `roost query --count` asks for a total instead of a
 * listing. One shared table could hold only one of those. What arrives here is
 * therefore whatever that command's table declared, and the accessors below are
 * how a caller states which it expects.
 */
export type Values = Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;

/** A flag declared `{ type: "string" }`. */
export function text(values: Values, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

/** A flag declared `{ type: "boolean" }`. */
export function flag(values: Values, key: string): boolean {
  return values[key] === true;
}

/** A flag declared `{ type: "string", multiple: true }`. */
export function list(values: Values, key: string): string[] {
  const value = values[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Reports a command line that cannot be acted on, and the help for it. */
export function usage(streams: Streams, command: Command | undefined, message: string): number {
  streams.warn(message);
  streams.warn("");
  streams.warn(helpFor(command));
  return EXIT.usage;
}
