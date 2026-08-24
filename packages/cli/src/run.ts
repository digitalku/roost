import { parseArgs } from "node:util";
import {
  isStorageMode,
  type LogLevel,
  setLogLevel,
  setSink,
  stderrSink,
  toWire,
} from "@roost/core";
import { fixture } from "./commands/fixture.js";
import { runImport } from "./commands/import.js";
import { init } from "./commands/init.js";
import { rebuild } from "./commands/rebuild.js";
import { stats } from "./commands/stats.js";
import { thumb } from "./commands/thumb.js";
import { type Command, helpFor, isCommand, VERSION } from "./help.js";
import { resolveLibrary } from "./resolve.js";

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

const OPTIONS = {
  library: { type: "string", short: "L" },
  name: { type: "string" },
  mode: { type: "string" },
  tag: { type: "string", multiple: true },
  hidden: { type: "boolean" },
  size: { type: "string", multiple: true },
  limit: { type: "string" },
  count: { type: "string" },
  "duplicate-ratio": { type: "string" },
  seed: { type: "string" },
  "real-images": { type: "boolean" },
  verbose: { type: "boolean", short: "v", multiple: true },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const;

type Parsed = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;

export async function run(argv: readonly string[], streams: Streams): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    streams.warn(error instanceof Error ? error.message : String(error));
    streams.warn("");
    streams.warn(helpFor(undefined));
    return EXIT.usage;
  }

  const { values, positionals } = parsed;
  const [first, ...rest] = positionals;

  if (values.version === true) {
    streams.out(`roost ${VERSION}`);
    return EXIT.ok;
  }

  const command: Command | undefined = first !== undefined && isCommand(first) ? first : undefined;

  if (values.help === true) {
    streams.out(helpFor(command));
    return EXIT.ok;
  }
  if (first === undefined) {
    streams.warn(helpFor(undefined));
    return EXIT.usage;
  }
  if (command === undefined) {
    streams.warn(`Unknown command "${first}".`);
    streams.warn("");
    streams.warn(helpFor(undefined));
    return EXIT.usage;
  }

  installLogging(values.verbose?.length ?? 0);

  try {
    return await dispatch(command, rest, values, streams);
  } catch (error) {
    // Every Roost error carries a stable code; anything else is reported as
    // itself rather than dressed up as one.
    const wire = toWire(error);
    streams.warn(`error [${wire.code}]: ${wire.message}`);
    return EXIT.failed;
  }
}

async function dispatch(
  command: Command,
  positionals: readonly string[],
  values: Parsed["values"],
  streams: Streams,
): Promise<number> {
  const library = async (): Promise<string> => resolveLibrary(values.library);

  switch (command) {
    case "init": {
      const path = positionals[0];
      if (path === undefined) return usage(streams, command, "init needs a path");
      await init(values.name === undefined ? { path } : { path, name: values.name }, streams.out);
      return EXIT.ok;
    }

    case "import": {
      if (positionals.length === 0) {
        return usage(streams, command, "import needs at least one path");
      }
      const mode = values.mode ?? "managed";
      if (!isStorageMode(mode)) {
        return usage(streams, command, `mode must be managed or referenced, not "${mode}"`);
      }
      await runImport(
        await library(),
        {
          paths: positionals,
          mode,
          tags: values.tag ?? [],
          includeHidden: values.hidden === true,
        },
        streams.out,
        streams.progress,
        streams.warn,
      );
      return EXIT.ok;
    }

    case "stats":
      await stats(await library(), streams.out);
      return EXIT.ok;

    case "rebuild":
      await rebuild(await library(), streams.out, streams.warn);
      return EXIT.ok;

    case "thumb": {
      const sizes = (values.size ?? ["256"]).map(Number);
      if (sizes.some((size) => !Number.isInteger(size) || size <= 0)) {
        return usage(streams, command, "each --size must be a positive whole number of pixels");
      }
      const limit = values.limit === undefined ? Number.MAX_SAFE_INTEGER : Number(values.limit);
      if (!Number.isInteger(limit) || limit <= 0) {
        return usage(streams, command, "--limit must be a positive whole number");
      }
      await thumb(await library(), { sizes, limit }, streams.out, streams.progress);
      return EXIT.ok;
    }

    case "fixture": {
      const out = positionals[0];
      if (out === undefined) return usage(streams, command, "fixture needs an output directory");
      const options = {
        count: numberOr(values.count, 1000),
        size: numberOr(values.size?.[0], 4096),
        duplicateRatio: numberOr(values["duplicate-ratio"], 0.05),
        seed: numberOr(values.seed, 0),
        realImages: values["real-images"] === true,
      };
      if (!Number.isInteger(options.count) || options.count <= 0) {
        return usage(streams, command, "--count must be a positive whole number");
      }
      await fixture(out, options, streams.out);
      return EXIT.ok;
    }
  }
}

function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function usage(streams: Streams, command: Command, message: string): number {
  streams.warn(message);
  streams.warn("");
  streams.warn(helpFor(command));
  return EXIT.usage;
}

/**
 * Installs the log sink.
 *
 * **A binary's job, never a library's.** Packages emit and know nothing about
 * where output goes; with no sink installed, nothing is even formatted. Quiet
 * by default: `-v` for info, `-vv` for debug, `-vvv` for trace.
 */
function installLogging(verbosity: number): void {
  const levels: LogLevel[] = ["warn", "info", "debug", "trace"];
  setLogLevel(levels[Math.min(verbosity, levels.length - 1)] ?? "warn");
  setSink(stderrSink());
}
