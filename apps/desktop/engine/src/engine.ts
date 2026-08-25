import {
  fileSink,
  filterSink,
  isLogLevel,
  type LogLevel,
  setLogLevel,
  setSink,
  stderrSink,
  teeSink,
} from "@roost/core";
import type { Port } from "./port.js";
import { serve } from "./serve.js";

/**
 * The `utilityProcess` entry point (ADR-0006).
 *
 * Everything above this line is host-agnostic: `serve` takes a port and the
 * host takes requests, so the same engine can be driven by a test with no
 * Electron anywhere. This file is the only part that knows it was forked.
 */

// Installing the sink is a binary's job, never a library's (`CLAUDE.md` §6),
// and this is a separate process from main, so it installs its own — the same
// pair, for the same reasons. stderr is inherited from main, which is where a
// crash is read from anyway.
const requested = process.env["ROOST_LOG"] ?? "";
const terminalLevel: LogLevel = isLogLevel(requested) ? requested : "warn";
const logFile = fileSink();
setLogLevel("debug");
setSink(teeSink(logFile, filterSink(terminalLevel, stderrSink())));

/**
 * `parentPort` is added to `process` by Electron inside a `utilityProcess`.
 *
 * Read through an interface rather than by importing `electron`, so the
 * dependency stays where it belongs — in the host, not in the engine.
 */
const parentPort = (process as NodeJS.Process & { parentPort?: Port }).parentPort;
if (parentPort === undefined) {
  throw new Error("the engine must be started as an Electron utilityProcess");
}

const server = serve(parentPort);

// A library dropped without closing loses whatever the journal had buffered,
// and JavaScript has no destructor to do it (`library.ts`). The engine exits
// when main asks it to, so this is the last chance.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void server.close().finally(() => {
      logFile.close();
      process.exit(0);
    });
  });
}
