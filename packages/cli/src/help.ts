/**
 * The one place command names, flags, and their descriptions are written.
 *
 * Every string below is a template literal, so a backtick inside one has to be
 * escaped. An unescaped one ends the string and the error is a parse failure
 * two hundred lines further down, which says nothing about the cause.
 */

export const VERSION = "0.0.0";

export const COMMANDS = [
  "init",
  "import",
  "stats",
  "rebuild",
  "thumb",
  "fixture",
  "query",
  "show",
  "tag",
  "folder",
  "smart",
  "rate",
  "note",
  "comment",
  "poster",
  "save",
  "subtitle",
  "rename",
  "trash",
  "remove",
  "doctor",
] as const;

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
  query     Search the library with RQL
  show      Show everything the library knows about one asset
  tag       Add, remove, rename, or list tags, and arrange them in groups
  folder    Create and populate folders. Folders are collections, not locations
  smart     Save, list, and update smart folders — RQL queries under a name
  rate      Rate assets from 1 to 5, or \`none\` to clear
  note      Set or clear an asset's note
  comment   Comment on an asset, or on a moment in one
  poster    Choose which frame a video's thumbnail comes from
  save      Replace an asset's contents with a file's, as a new version
  subtitle  Attach, list, or detach the caption tracks of a video
  rename    Change an asset's display name. The file on disk is untouched
  trash     Move assets to the trash, restore them, or empty it
  remove    Remove assets from the library. Originals are not deleted
  doctor    Check a library against itself, and reclaim what nothing references

Options:
${GLOBAL}

Run \`roost <COMMAND> --help\` for the options a command takes.`;

const PER_COMMAND: Readonly<Record<Command, string>> = {
  init: `Create a new library.

A library is a folder ending in .roost, the way an Eagle library ends in
.library — one object in a file manager rather than a directory of hashes. The
suffix is added if it is missing, so \`roost init ~/Photos\` and
\`roost init ~/Photos.roost\` create the same thing. The path actually used is
printed.

Usage: roost init <PATH> [OPTIONS]

Options:
      --name <NAME>      Display name. Defaults to the folder's own name,
                         without the suffix
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

  thumb: `Generate thumbnails and metadata for assets that have none.

Works the derive queue: images, SVG, fonts, PDF pages, video frames, and
audio waveforms, each through the backend that draws it. Safe to run
repeatedly and safe to interrupt — what it finished, it keeps.

Work nobody can do is parked rather than retried: a format this build cannot
draw, or a tool this machine does not have. That is what makes a second run
finish immediately instead of trying everything again.

Usage: roost thumb [OPTIONS]

Options:
${LIBRARY_FLAG}
      --size <PIXELS>    Longest edge. Repeatable. Default: 256
      --limit <N>        Stop after this many assets
      --retry            Offer failed jobs again, up to three attempts each
      --retry-blocked    Offer parked jobs again, after installing a tool
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
  query: `Search the library with RQL.

Adjacent terms are ANDed; \`OR\` and parentheses are explicit; a leading \`-\` negates.
Fields: tag, folder, ext, size, w, h, duration, created, imported, rating, is.
Anything unqualified is full-text over names, tags, notes, and comments.

Usage: roost query <QUERY>... [OPTIONS]

Examples:
  roost query 'tag:wood rating:>=4'
  roost query 'ext:png OR ext:jpg' --limit 20
  roost query 'is:untagged' --hashes | xargs roost tag add --tag triage
  roost query 'size:>10mb' --count
  roost query --count -- '-tag:wip'

A query starting with \`-\` reads as a flag, here and in the Rust build alike.
Put \`--\` before it, and every other flag before that: everything
after \`--\` is part of the query.

Options:
${LIBRARY_FLAG}
      --limit <N>        Stop after this many results. Default: 50
      --count            Print the number of matches instead of the matches
      --hashes           Print one hash per line, for piping into another command
${GLOBAL}`,

  show: `Show everything the library knows about one asset.

Usage: roost show <ASSET> [OPTIONS]

<ASSET> is a full hash or an unambiguous prefix.

Options:
${LIBRARY_FLAG}
${GLOBAL}`,

  tag: `Add, remove, rename, or list tags.

Usage: roost tag add    --tag <TAG>... <ASSET>...
       roost tag remove --tag <TAG>... <ASSET>...
       roost tag rename <FROM> <TO>
       roost tag list
       roost tag group create <NAME>
       roost tag group rename <NAME> <NEW_NAME>
       roost tag group delete <NAME>
       roost tag group add <GROUP> <TAG>...
       roost tag group remove <TAG>...
       roost tag group list

Renaming onto an existing tag merges into it: tag names are unique, so there is
no other outcome that both succeeds and replays to the same state.

Groups arrange tags for the sidebar. They do not nest them, so \`tag:\` still
names exactly one tag.

Options:
${LIBRARY_FLAG}
      --tag <TAG>        Repeatable. Required by add and remove
${GLOBAL}`,

  folder: `Create and populate folders.

Folders are collections, not locations: adding an asset to one moves nothing on
disk, and deleting one deletes no assets.

Usage: roost folder create <NAME> [--parent <PATH>]
       roost folder rename <PATH> <NAME>
       roost folder move <PATH> [--parent <PATH>]
       roost folder delete <PATH>
       roost folder add <PATH> <ASSET>...
       roost folder remove <PATH> <ASSET>...
       roost folder list

A <PATH> is slash-separated, as in \`Design/Icons\`. Names are unique among
siblings only, which is why the path and not the name is what names a folder.

Options:
${LIBRARY_FLAG}
      --parent <PATH>    Parent folder. Without it, create and move go to the
                         top level
${GLOBAL}`,

  smart: `Save, list, and update smart folders — RQL queries under a name.

A smart folder stores its query, not its results, so it is evaluated every time
it is read and can never go stale. The query is parsed before it is saved, so a
typo is caught now rather than in a sidebar later.

Usage: roost smart create <NAME> <QUERY>
       roost smart update <NAME> [--rename <NAME>] [--query <QUERY>]
       roost smart delete <NAME>
       roost smart list

Options:
${LIBRARY_FLAG}
      --rename <NAME>    New name for the smart folder
      --query <QUERY>    New query for the smart folder
${GLOBAL}`,

  rate: `Rate assets from 1 to 5, or \`none\` to clear.

There is no zero: an unrated asset has no rating, which is a different thing
from one rated zero, and only one of the two is a value the schema holds.

Usage: roost rate <RATING> <ASSET>... [OPTIONS]

Options:
${LIBRARY_FLAG}
${GLOBAL}`,

  note: `Set or clear an asset's note.

Usage: roost note <ASSET> [TEXT]... [OPTIONS]

With no text, or with --clear, the note is removed. A note of nothing but
whitespace is removed too, rather than stored as an empty badge forever.

Options:
${LIBRARY_FLAG}
      --clear            Remove the note
${GLOBAL}`,

  comment: `Comment on an asset, or on a moment in one.

Usage: roost comment <ASSET> <TEXT>... [--at TIME]
       roost comment --list <ASSET>
       roost comment --edit <ID> <TEXT>... [--at TIME]
       roost comment --remove <ID>

Without --at, the comment is about the asset as a whole. With it, the comment
is about that moment in a video or an audio track — \`1:31.5\`, \`91.5s\`, and
\`91500ms\` all name the same one.

An edit keeps the comment's id and its place in the list, so correcting a typo
does not move it to the end.

Options:
${LIBRARY_FLAG}
      --at <TIME>        The moment the comment is about
      --list             List an asset's comments, with their ids
      --edit <ID>        Replace a comment's text, and its moment with --at
      --remove <ID>      Remove a comment
${GLOBAL}`,

  save: `Replace an asset's contents with a file's, as a new version.

Usage: roost save <ASSET> <FILE>
       roost save <ASSET> --clear

Identity here is the content hash, so a save is not a write: the new bytes
become a **new asset** and the old one is marked superseded, which takes it out
of every view but \`is:superseded\`. Everything you authored travels with it —
tags, folders, rating, note, favourite, the pinned frame, and the comments.

Nothing is destroyed and nothing expires. An old version is still a row, and
removing one is \`roost remove\` on it: a second, deliberate gesture.

With --clear the asset stops being superseded and is current again.

Refused for an asset whose bytes are your own — a referenced original lives in
your directory, and Roost never writes there — and for one in the trash, since
superseding it would produce a live replacement.

Options:
${LIBRARY_FLAG}
      --clear            Make this asset current again
${GLOBAL}`,

  subtitle: `Attach, list, or detach the caption tracks of a video.

Usage: roost subtitle <ASSET> <TRACK> [--lang CODE]
       roost subtitle <ASSET> <TRACK> --detach
       roost subtitle <ASSET>

Both arguments are assets: the subtitle is an ordinary content-addressed file
in the library, and this records which video it captions. Importing a folder
where \`film.srt\` sits beside \`film.mkv\` attaches them on its own — this is for
the rest.

Without a track it lists what is attached. Detaching un-says the sentence and
deletes nothing: both files stay, and the track becomes an ordinary text asset
again, visible in the grid.

An attached track is hidden from every view but \`is:subtitle\`, and
\`is:captioned\` finds the videos that have one.

Options:
${LIBRARY_FLAG}
      --lang <CODE>      BCP-47 language, where the filename did not say
      --detach           Un-say it
${GLOBAL}`,

  poster: `Choose which frame a video's thumbnail comes from.

Usage: roost poster <ASSET> --at TIME
       roost poster <ASSET> --clear
       roost poster <ASSET>

Without a flag it says where the thumbnail is taken from. With --at it is
pinned to that moment — \`1:31.5\`, \`91.5s\`, and \`91500ms\` all name the same
one. With --clear it goes back to the default frame, which is not the first
one: a frame a tenth of the way in, because a first frame tends to be a slate.

The journal records the moment, never the picture, so a rebuild re-extracts
the frame. Nothing is redrawn here — run \`roost thumb\` afterwards.

Options:
${LIBRARY_FLAG}
      --at <TIME>        The moment to take the thumbnail from
      --clear            Go back to the default frame
${GLOBAL}`,

  rename: `Change an asset's display name.

The file on disk keeps its hash filename, as it always does — this changes what
the library shows, not what is stored.

Usage: roost rename <ASSET> <NAME> [OPTIONS]

Options:
${LIBRARY_FLAG}
${GLOBAL}`,

  trash: `Move assets to the trash.

Nothing is deleted and nothing on disk moves. A trashed asset keeps its tags,
its rating, its note, and its folder memberships, and stops appearing in every
query but \`is:trashed\` — which is the query the Trash place carries.

There is no timer. The trash is emptied when you empty it, never on a schedule.

Usage: roost trash <ASSET>... [OPTIONS]
       roost trash --restore <ASSET>...
       roost trash --empty

Options:
      --restore          Bring the named assets back out of the trash
      --empty            Remove everything in the trash from the library.
                         This is \`roost remove\` over what the trash holds, and
                         it is not reversible
${LIBRARY_FLAG}
${GLOBAL}`,

  remove: `Remove assets from the library.

Not reversible, and not what \`Delete\` does in the window — see \`roost trash\`.
This is what emptying the trash sends.

Index rows only. The bytes under originals/ stay where they are: reclaiming them
is a separate, reviewable step, because deleting someone's only copy of a file
as a side effect of a metadata edit is not a trade this project makes.

Usage: roost remove <ASSET>... [OPTIONS]

Options:
${LIBRARY_FLAG}
${GLOBAL}`,
  doctor: `Check a library against itself.

Roost keeps three copies of the truth: the journal, the index, and the bytes
under originals/. \`roost rebuild\` proves the first two agree. This checks the
third: objects with no row, rows with no bytes, referenced originals that moved,
search rows for assets that are gone, and files in journal/ that replay skips.

Exits 1 when it finds damage, so a scheduled run is a check rather than a report
nobody reads. Objects nothing references are not damage — they cost space.

Usage: roost doctor [OPTIONS]

Options:
${LIBRARY_FLAG}
      --deep             Re-hash every object and compare it to its filename.
                         The only check that catches silent corruption, and it
                         reads the whole library
      --reclaim          Delete the objects nothing references. Refused when the
                         index and the object store disagree, because an orphan
                         is only an orphan relative to the index — run
                         \`roost rebuild\` first
      --force            Reclaim even then, for bytes a rebuild cannot bring
                         back. The deletion is permanent
      --examples <N>     Print at most this many examples per problem.
                         Default: 10
${GLOBAL}`,
};

export function helpFor(command: Command | undefined): string {
  return command === undefined ? TOP : PER_COMMAND[command];
}
