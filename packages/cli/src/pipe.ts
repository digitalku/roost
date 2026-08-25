import type { EventEmitter } from "node:events";

/**
 * A reader that closed the pipe is not a failure.
 *
 * `roost query --hashes | head -1` closes stdout while the command is still
 * writing to it, and Node reports that as an unhandled `EPIPE` with a stack
 * trace — for a shell pipeline that did exactly what it was asked to. Every
 * other command-line tool exits quietly here, and the documented way to use
 * `--hashes` is a pipeline, so this is not an edge case.
 *
 * Any other stream error is left to fail loudly: stdout that cannot be written
 * to for some other reason is a real problem, and swallowing it would lose
 * output silently.
 */
export function exitQuietlyOnBrokenPipe(
  streams: readonly EventEmitter[],
  exit: (code: number) => void,
): void {
  for (const stream of streams) {
    stream.on("error", (error: unknown) => {
      if (!isBrokenPipe(error)) throw error;
      exit(0);
    });
  }
}

function isBrokenPipe(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  // `Reflect.get` rather than a cast: the shape of what a stream emits is not
  // something this module gets to assert.
  return Reflect.get(error, "code") === "EPIPE";
}
