/** The one place command names, flags, and their descriptions are written. */

export const VERSION = "0.0.0";

export const COMMANDS = ["init", "import", "stats", "rebuild", "thumb", "fixture"] as const;

export type Command = (typeof COMMANDS)[number];

export function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

const LIBRARY_FLAG = `  -L, --library <PATH>   The library. Defaults to $ROOST_LIBRARY, or the
                         nearest library at or above the working directory`;

const GLOBAL = `  -v, --verbose          Print more. Repeat for more still: -v info, -vv debug
  -h, --help             Print help
  -V, --version          Print version`;

const TOP = `Roost — a local-first digital asset manager

Usage: roost <COMMAND> [OPTIONS]

Commands:
  init      Create a new library
  import    Import files and directories into a library
  stats     Show what a library contains
  rebuild   Delete the index and rebuild it by replaying the journal
  thumb     Generate thumbnails for assets that have none
  fixture   Generate a synthetic corpus for benchmarking

Options:
${GLOBAL}

Run \`roost <COMMAND> --help\` for the options a command takes.`;

const PER_COMMAND: Readonly<Record<Command, string>> = {
  init: `Create a new library.

Usage: roost init <PATH> [OPTIONS]

Options:
      --name <NAME>      Display name. Defaults to the directory's own name
${GLOBAL}`,

  import: `Import files and directories into a library.

Originals are never moved, modified, or deleted. Identical bytes deduplicate
against what the library already holds, so re-importing a folder is a no-op.

Usage: roost import <PATH>... [OPTIONS]

Options:
${LIBRARY_FLAG}
      --mode <MODE>      managed (copy into the library) or referenced (leave
                         the file where it is). Default: managed
      --tag <TAG>        Apply to everything imported in this run. Repeatable
      --hidden           Descend into dot-directories and import dotfiles
${GLOBAL}`,

  stats: `Show what a library contains.

Usage: roost stats [OPTIONS]

Options:
${LIBRARY_FLAG}
${GLOBAL}`,

  rebuild: `Delete the index and rebuild it by replaying the journal.

The index is a derived cache; this proves it. Thumbnails do not come back —
they derive from bytes, not from journal records. Run \`roost thumb\` after.

Usage: roost rebuild [OPTIONS]

Options:
${LIBRARY_FLAG}
${GLOBAL}`,

  thumb: `Generate thumbnails for assets that have none.

Safe to run repeatedly: assets that already have one are skipped.

Usage: roost thumb [OPTIONS]

Options:
${LIBRARY_FLAG}
      --size <PIXELS>    Longest edge. Repeatable. Default: 256
      --limit <N>        Stop after this many assets
${GLOBAL}`,

  fixture: `Generate a synthetic corpus for benchmarking.

Deterministic given the same seed, and byte-identical to what the Rust
implementation writes, so two runs are comparable across both builds.

Usage: roost fixture <OUT> [OPTIONS]

Options:
      --count <N>        Files to write. Default: 1000
      --size <BYTES>     Approximate bytes per file, for non-image files.
                         Default: 4096
      --duplicate-ratio <R>
                         Fraction of files duplicating an earlier one.
                         Default: 0.05
      --seed <N>         Default: 0
      --real-images      Encode real gradients for image extensions. Slower by
                         an order of magnitude. Without it every file is random
                         bytes: enough to measure hashing, placing, and
                         indexing, but nothing it writes can be thumbnailed,
                         which looks like a broken pipeline and is only ever
                         the fixture
${GLOBAL}`,
};

export function helpFor(command: Command | undefined): string {
  return command === undefined ? TOP : PER_COMMAND[command];
}
