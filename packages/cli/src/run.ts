import { type ParseArgsConfig, parseArgs } from "node:util";
import {
  isStorageMode,
  type LogLevel,
  setLogLevel,
  setSink,
  stderrSink,
  toWire,
} from "@roost/core";
import { comment, drop, edit, listOn } from "./commands/comment.js";
import { doctor } from "./commands/doctor.js";
import { fixture } from "./commands/fixture.js";
import { folder } from "./commands/folder.js";
import { runImport } from "./commands/import.js";
import { init } from "./commands/init.js";
import {
  emptyTheTrash,
  note,
  rate,
  remove,
  rename,
  restore,
  source,
  trash,
} from "./commands/mark.js";
import { poster } from "./commands/poster.js";
import { query } from "./commands/query.js";
import { rebuild } from "./commands/rebuild.js";
import { save } from "./commands/save.js";
import { show } from "./commands/show.js";
import { smart } from "./commands/smart.js";
import { stats } from "./commands/stats.js";
import { subtitle } from "./commands/subtitle.js";
import { tag } from "./commands/tag.js";
import { thumb } from "./commands/thumb.js";
import { type Command, helpFor, isCommand, VERSION } from "./help.js";
import { EXIT, flag, list, type Streams, text, usage, type Values } from "./io.js";
import { resolveLibrary } from "./resolve.js";

export { EXIT, type Streams } from "./io.js";

type OptionTable = NonNullable<ParseArgsConfig["options"]>;

/** Accepted by every command, and by no other spelling of the same idea. */
const GLOBAL_OPTIONS: OptionTable = {
  library: { type: "string", short: "L" },
  verbose: { type: "boolean", short: "v", multiple: true },
  help: { type: "boolean", short: "h" },
};

/**
 * One option table per command, rather than one table for all of them.
 *
 * Two commands spell the same flag differently on purpose: `roost fixture
 * --count 1000` takes a number, and `roost query --count` takes nothing. A
 * shared table could hold only one of those, and the one it held would make the
 * other command's documented flag an error.
 */
const COMMAND_OPTIONS: Readonly<Record<Command, OptionTable>> = {
  init: { name: { type: "string" } },
  import: {
    mode: { type: "string" },
    tag: { type: "string", multiple: true },
    hidden: { type: "boolean" },
  },
  stats: {},
  rebuild: {},
  thumb: {
    size: { type: "string", multiple: true },
    limit: { type: "string" },
    retry: { type: "boolean" },
    "retry-blocked": { type: "boolean" },
  },
  fixture: {
    count: { type: "string" },
    size: { type: "string", multiple: true },
    "duplicate-ratio": { type: "string" },
    seed: { type: "string" },
    "real-images": { type: "boolean" },
  },
  query: { limit: { type: "string" }, count: { type: "boolean" }, hashes: { type: "boolean" } },
  show: {},
  tag: { tag: { type: "string", multiple: true } },
  folder: { parent: { type: "string" } },
  smart: { rename: { type: "string" }, query: { type: "string" } },
  rate: {},
  note: { clear: { type: "boolean" } },
  source: { clear: { type: "boolean" } },
  comment: {
    at: { type: "string" },
    list: { type: "boolean" },
    edit: { type: "string" },
    remove: { type: "string" },
  },
  poster: { at: { type: "string" }, clear: { type: "boolean" } },
  save: { clear: { type: "boolean" } },
  subtitle: { detach: { type: "boolean" }, lang: { type: "string" } },
  rename: {},
  trash: { restore: { type: "boolean" }, empty: { type: "boolean" } },
  remove: {},
  doctor: {
    deep: { type: "boolean" },
    reclaim: { type: "boolean" },
    force: { type: "boolean" },
    examples: { type: "string" },
  },
};

export async function run(argv: readonly string[], streams: Streams): Promise<number> {
  const [first, ...rest] = argv;

  // The command comes first, because each command parses against its own option
  // table and there is nothing to choose one with until it is known.
  if (first === undefined) {
    streams.warn(helpFor(undefined));
    return EXIT.usage;
  }
  if (first === "-V" || first === "--version") {
    streams.out(`roost ${VERSION}`);
    return EXIT.ok;
  }
  if (first === "-h" || first === "--help") {
    streams.out(helpFor(undefined));
    return EXIT.ok;
  }
  if (!isCommand(first)) {
    streams.warn(`Unknown command "${first}".`);
    streams.warn("");
    streams.warn(helpFor(undefined));
    return EXIT.usage;
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...rest],
      options: { ...GLOBAL_OPTIONS, ...COMMAND_OPTIONS[first] },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usage(streams, first, error instanceof Error ? error.message : String(error));
  }

  const values: Values = parsed.values;
  if (flag(values, "help")) {
    streams.out(helpFor(first));
    return EXIT.ok;
  }

  installLogging(list(values, "verbose").length + (values["verbose"] === true ? 1 : 0));

  try {
    return await dispatch(first, parsed.positionals, values, streams);
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
  values: Values,
  streams: Streams,
): Promise<number> {
  const library = async (): Promise<string> => resolveLibrary(text(values, "library"));

  switch (command) {
    case "init": {
      const path = positionals[0];
      if (path === undefined) return usage(streams, command, "init needs a path");
      const name = text(values, "name");
      await init(name === undefined ? { path } : { path, name }, streams.out);
      return EXIT.ok;
    }

    case "import": {
      if (positionals.length === 0) {
        return usage(streams, command, "import needs at least one path");
      }
      const mode = text(values, "mode") ?? "managed";
      if (!isStorageMode(mode)) {
        return usage(streams, command, `mode must be managed or referenced, not "${mode}"`);
      }
      await runImport(
        await library(),
        {
          paths: positionals,
          mode,
          tags: list(values, "tag"),
          includeHidden: flag(values, "hidden"),
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
      const sizes = (list(values, "size").length === 0 ? ["256"] : list(values, "size")).map(
        Number,
      );
      if (sizes.some((size) => !Number.isInteger(size) || size <= 0)) {
        return usage(streams, command, "each --size must be a positive whole number of pixels");
      }
      const limit = numberOr(text(values, "limit"), Number.MAX_SAFE_INTEGER);
      if (!Number.isInteger(limit) || limit <= 0) {
        return usage(streams, command, "--limit must be a positive whole number");
      }
      await thumb(
        await library(),
        {
          sizes,
          limit,
          ...(flag(values, "retry") ? { retry: true } : {}),
          ...(flag(values, "retry-blocked") ? { retryBlocked: true } : {}),
        },
        streams.out,
        streams.progress,
      );
      return EXIT.ok;
    }

    case "fixture": {
      const out = positionals[0];
      if (out === undefined) return usage(streams, command, "fixture needs an output directory");
      const options = {
        count: numberOr(text(values, "count"), 1000),
        size: numberOr(list(values, "size")[0], 4096),
        duplicateRatio: numberOr(text(values, "duplicate-ratio"), 0.05),
        seed: numberOr(text(values, "seed"), 0),
        realImages: flag(values, "real-images"),
      };
      if (!Number.isInteger(options.count) || options.count <= 0) {
        return usage(streams, command, "--count must be a positive whole number");
      }
      await fixture(out, options, streams.out);
      return EXIT.ok;
    }

    case "query": {
      if (positionals.length === 0) return usage(streams, command, "query needs a query");
      const limit = numberOr(text(values, "limit"), 50);
      if (!Number.isInteger(limit) || limit <= 0) {
        return usage(streams, command, "--limit must be a positive whole number");
      }
      await query(
        await library(),
        {
          // Joined rather than taken as one argument, so an unquoted query is
          // merely inconvenient instead of wrong.
          query: positionals.join(" "),
          limit,
          countOnly: flag(values, "count"),
          hashesOnly: flag(values, "hashes"),
        },
        streams.out,
      );
      return EXIT.ok;
    }

    case "show": {
      const asset = positionals[0];
      if (asset === undefined) return usage(streams, command, "show needs an asset");
      await show(await library(), asset, streams.out);
      return EXIT.ok;
    }

    case "tag":
      return tag(await library(), positionals, list(values, "tag"), streams);

    case "folder":
      return folder(await library(), positionals, text(values, "parent"), streams);

    case "smart":
      return smart(
        await library(),
        positionals,
        { rename: text(values, "rename"), query: text(values, "query") },
        streams,
      );

    case "rate": {
      const [rating, ...assets] = positionals;
      if (rating === undefined || assets.length === 0) {
        return usage(streams, command, "rate needs a rating and at least one asset");
      }
      return rate(await library(), rating, assets, streams);
    }

    case "note": {
      const [asset, ...words] = positionals;
      if (asset === undefined) return usage(streams, command, "note needs an asset");
      // No text and no --clear is a request to clear it, which is what an empty
      // note means everywhere else in the library too.
      const text_ = flag(values, "clear") || words.length === 0 ? undefined : words.join(" ");
      return note(await library(), asset, text_, streams);
    }

    case "source": {
      const [asset, url] = positionals;
      if (asset === undefined) return usage(streams, command, "source needs an asset");
      // No URL and no --clear clears it, the way `note` reads a missing
      // argument: "no source" and "remove the source" are the same state.
      const url_ = flag(values, "clear") || url === undefined ? undefined : url;
      return source(await library(), asset, url_, streams);
    }

    case "comment": {
      const listing = flag(values, "list");
      const editing = text(values, "edit");
      const removing = text(values, "remove");
      // Three flags naming three different verbs. Two of them at once is a
      // typo, and guessing which was meant would edit the wrong comment.
      if ([listing, editing !== undefined, removing !== undefined].filter(Boolean).length > 1) {
        return usage(streams, command, "--list, --edit, and --remove ask for different things");
      }

      if (removing !== undefined) return drop(await library(), removing, streams);
      if (listing) {
        const [asset] = positionals;
        if (asset === undefined) return usage(streams, command, "--list needs an asset");
        return listOn(await library(), asset, streams);
      }
      if (editing !== undefined) {
        if (positionals.length === 0) {
          return usage(streams, command, "--edit needs the text to replace the comment with");
        }
        return edit(await library(), editing, positionals, text(values, "at"), streams);
      }

      const [asset, ...words] = positionals;
      if (asset === undefined || words.length === 0) {
        return usage(streams, command, "comment needs an asset and some text");
      }
      return comment(await library(), asset, words, text(values, "at"), streams);
    }

    case "poster": {
      const [asset] = positionals;
      if (asset === undefined) return usage(streams, command, "poster needs an asset");
      return poster(await library(), asset, text(values, "at"), flag(values, "clear"), streams);
    }

    case "save": {
      const [asset, file] = positionals;
      if (asset === undefined) return usage(streams, command, "save needs an asset");
      return save(await library(), asset, file, flag(values, "clear"), streams);
    }

    case "subtitle": {
      const [asset, track] = positionals;
      return subtitle(
        await library(),
        asset,
        track,
        { detach: flag(values, "detach"), lang: text(values, "lang") },
        streams,
      );
    }

    case "rename": {
      const [asset, name] = positionals;
      if (asset === undefined || name === undefined) {
        return usage(streams, command, "rename needs an asset and a new name");
      }
      return rename(await library(), asset, name, streams);
    }

    case "trash": {
      const empty = flag(values, "empty");
      const restoring = flag(values, "restore");
      if (empty && restoring) {
        return usage(streams, command, "--empty and --restore ask for opposite things");
      }
      if (empty) {
        if (positionals.length > 0) {
          return usage(streams, command, "--empty takes no assets — it empties the whole trash");
        }
        return emptyTheTrash(await library(), streams);
      }
      if (positionals.length === 0) {
        return usage(streams, command, "trash needs at least one asset");
      }
      return restoring
        ? restore(await library(), positionals, streams)
        : trash(await library(), positionals, streams);
    }

    case "remove": {
      if (positionals.length === 0) {
        return usage(streams, command, "remove needs at least one asset");
      }
      return remove(await library(), positionals, streams);
    }

    case "doctor": {
      const examples = numberOr(text(values, "examples"), 10);
      if (!Number.isInteger(examples) || examples < 0) {
        return usage(streams, command, "--examples must be a whole number");
      }
      if (flag(values, "force") && !flag(values, "reclaim")) {
        return usage(streams, command, "--force only means anything with --reclaim");
      }
      return doctor(
        await library(),
        {
          deep: flag(values, "deep"),
          reclaim: flag(values, "reclaim"),
          force: flag(values, "force"),
          examples,
        },
        streams,
      );
    }
  }
}

function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
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
