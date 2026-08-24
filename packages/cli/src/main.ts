#!/usr/bin/env node
import { run } from "./run.js";

/**
 * Results on stdout, everything else on stderr.
 *
 * The progress line rewrites itself in place when a terminal is attached, and
 * is dropped entirely when one is not: a log file does not want ten thousand
 * copies of a counter, and a pipe does not want them at all.
 */
const interactive = process.stderr.isTTY === true;
const CLEAR = "\r[K";

const argv = process.argv.slice(2);
// `pnpm --filter @roost/cli start -- --help` forwards the separator itself, and
// `parseArgs` would then read `--help` as a positional and call it an unknown
// command. Dropping a leading one is what makes the documented invocation work.
if (argv[0] === "--") argv.shift();

process.exitCode = await run(argv, {
  out: (line) => process.stdout.write(`${line}\n`),
  warn: (line) => {
    if (interactive) process.stderr.write(CLEAR);
    process.stderr.write(`${line}\n`);
  },
  progress: (line) => {
    if (interactive) process.stderr.write(`${CLEAR}${line}`);
  },
});

if (interactive) process.stderr.write(CLEAR);
