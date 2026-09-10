import {
  bad,
  type Checked,
  isRecord,
  ok,
  readBoolean,
  readHash,
  readHashArray,
  readInteger,
  readNonEmpty,
  readNullable,
  readOneOf,
  readString,
  readStringArray,
  within,
} from "./checked.js";
import type {
  AssetPage,
  LibraryStats,
  LibrarySummary,
  QueryCheck,
  StorageMode,
  WireAbout,
  WireAssetDetail,
  WireCreated,
  WireCursor,
  WireDeriveStatus,
  WireEagleReport,
  WireEagleSurvey,
  WireExportReport,
  WireFacets,
  WireFiled,
  WireFolderDeleted,
  WireImportReport,
  WirePasted,
  WireRecentLibrary,
  WireReclaimable,
  WireRemoval,
  WireSelectionSummary,
  WireSettings,
  WireSidebar,
  WireSort,
  WireSplitQuery,
  WireStars,
  WireSubtitlesAdded,
  WireTagRule,
} from "./dto.js";
import {
  IMPORT_SUBJECTS,
  type ImportSubject,
  SORT_KEYS,
  type SortKey,
  STARS,
  STORAGE_MODES,
  TAG_RULES,
} from "./dto.js";

/**
 * Every request the renderer can make, and what each one answers with.
 *
 * Adding a command means adding a member here, its response, its validator, and
 * its handler — **in one change**, because the mapped type below does not
 * compile without all four (ADR-0007). Members arrive with the feature that
 * needs them; a contract written ahead of its handlers is a contract that
 * describes something nobody built.
 */
export type Request =
  /** Open an existing library. Refused if the directory holds no `library.json`. */
  | { readonly type: "library:open"; readonly path: string }
  /**
   * Create a library called `name` inside `parent`, and open it.
   *
   * The two are sent apart rather than joined, because joining them is path
   * work and the renderer has no `node:path` — nor any business doing it. The
   * engine composes `<parent>/<name>.roost` and validates the name on the way
   * (ADR-0014).
   */
  | { readonly type: "library:create"; readonly parent: string; readonly name: string }
  /** The library this engine currently holds, if any. */
  | { readonly type: "library:current" }
  /**
   * The libraries this machine has opened, pinned first and then newest.
   *
   * Application state rather than library state, for the plainest of the three
   * reasons ADR-0019 gives: this list is what *finds* a library, so it cannot
   * live inside one.
   */
  | { readonly type: "recent:list" }
  /** Drops one entry from the recent list, and answers with what is left. */
  | { readonly type: "recent:forget"; readonly root: string }
  /** Pins or unpins one entry. A pinned entry is never evicted by the limit. */
  | { readonly type: "recent:pin"; readonly root: string; readonly pinned: boolean }
  /** Release the library, its journal, and its lock. */
  | { readonly type: "library:close" }
  /**
   * End the application (ADR-0028).
   *
   * Here because the window has no menu bar on Linux or Windows and Quit has to
   * come from somewhere. It answers `null` and the reply is never seen: the
   * process is on its way out.
   */
  | { readonly type: "app:quit" }
  /**
   * What this build is, for the About dialog (ADR-0038 §5.1).
   *
   * Answered by **main**: the version belongs to the application rather than to
   * any library, and it is readable from a window with no library open — which
   * is where somebody looking for the support address most often is.
   */
  | { readonly type: "app:about" }
  /** The counts behind the library view. */
  | { readonly type: "library:stats" }
  /** The navigation pane: places, folders, smart folders, tags. */
  | { readonly type: "library:sidebar" }
  /**
   * One page of the grid.
   *
   * `query` is RQL, or empty for the whole library — the engine decides what
   * empty means, because two frontends deciding separately is how they come to
   * disagree. `after` is a cursor a previous page handed back, or `null` to
   * start at the newest asset.
   */
  | {
      readonly type: "assets:page";
      readonly query: string;
      readonly limit: number;
      readonly after: WireCursor | null;
      /**
       * The order to page in, or `null` for the default — newest first
       * (ADR-0039).
       *
       * Explicit rather than read from the library's settings here, because a
       * cursor belongs to the order it was handed out under: a page that took
       * the order from a preference could be resumed against a different one
       * the moment another window changed it.
       */
      readonly sort: WireSort | null;
    }
  /**
   * How many assets a query matches.
   *
   * Separate from a page because it is separate work: a page is one screen and
   * a count is every row. The status bar asks for it once per query, not once
   * per scroll.
   */
  | { readonly type: "assets:count"; readonly query: string }
  /**
   * Whether a query parses, and where it stopped.
   *
   * The renderer cannot answer this itself: the grammar lives in
   * `@roost/search`, and the renderer's only import is the contract. A half
   * typed query is checked here rather than being sent to the grid and
   * bouncing (`UI_SPEC.md` §5).
   */
  | { readonly type: "query:check"; readonly query: string }
  /**
   * A query, read as somewhere to look plus the three facets the bar draws
   * (ADR-0035).
   *
   * The renderer cannot answer this either, and for a stronger reason than
   * `query:check`: reading a query means knowing the grammar, and there is one
   * implementation of it. The bar sends the string it holds and draws what
   * comes back.
   */
  | { readonly type: "query:split"; readonly query: string }
  /**
   * The query a place and a set of facets spell.
   *
   * The other half of `query:split`, and the reason the bar never concatenates
   * anything: it changes one field of the structure it was given and asks what
   * that says. Also how a sidebar row keeps the filters standing — the row's
   * own query is the new `place`.
   */
  | { readonly type: "query:join"; readonly place: string; readonly facets: WireFacets }
  /**
   * The same query, asking at the other depth (ADR-0036).
   *
   * *Show subfolder contents* rewrites the folder term the query names —
   * `folder:Design` to `infolder:Design` and back — and returns a query naming
   * no folder **unchanged, byte for byte**. The bar sends the string it holds
   * for the same reason `query:join` exists: the grammar has one implementation
   * and the sandbox is not the place for a second.
   */
  | { readonly type: "query:subfolders"; readonly query: string; readonly on: boolean }
  /** This library's preferences (ADR-0019). */
  | { readonly type: "settings:read" }
  /**
   * Changes one or more preferences, and answers with all of them.
   *
   * Answers rather than acknowledges, because the write may not have reached
   * the disk — a library on read-only media keeps the setting for the session
   * (ADR-0019) — and the window should draw what the engine actually holds.
   */
  | {
      readonly type: "settings:write";
      readonly showSubfolderContents?: boolean;
      readonly fitVideoToWindow?: boolean;
      readonly mediaVolume?: number;
      readonly mediaMuted?: boolean;
      readonly sortKey?: SortKey;
      readonly sortDescending?: boolean;
      readonly shuffleSeed?: number;
      readonly gridView?: string;
      readonly matchImageProportions?: boolean;
      readonly gridZoom?: number;
    }
  /**
   * Everything the inspector shows about one asset.
   *
   * `null` rather than a failure when the hash is not in the library: a
   * selection can outlive the asset it points at — another window removed it,
   * or a rebuild dropped a row — and an empty inspector is the right answer to
   * that, not an error dialog.
   */
  | { readonly type: "asset:detail"; readonly hash: string }
  /**
   * What a selection of several assets shares, and what it does not.
   *
   * Asked instead of `asset:detail` once more than one asset is selected. The
   * inspector cannot fetch a detail each: a selection is routinely hundreds of
   * rows, and what it draws is a summary of them rather than each of them.
   */
  | { readonly type: "asset:summary"; readonly hashes: readonly string[] }
  /**
   * Set or clear a rating on every selected asset.
   *
   * `null` clears. Not zero: unrated and rated-zero are different states in the
   * schema, and a wire that could not say so would lose the difference
   * (`DATA_MODEL.md`).
   */
  | {
      readonly type: "asset:rate";
      readonly hashes: readonly string[];
      readonly rating: number | null;
    }
  /** `null` clears the note, and so does an all-whitespace one. */
  | { readonly type: "asset:note"; readonly hash: string; readonly note: string | null }
  /**
   * Where the file came from (ADR-0030). `null` clears it, and so does an
   * all-whitespace value.
   *
   * One hash, like the note and unlike the rating: a source is one asset's
   * answer, and writing one across a selection is a mistake with no undo.
   */
  | { readonly type: "asset:source"; readonly hash: string; readonly url: string | null }
  /**
   * Pin a video's thumbnail to a moment, or let it go back to the default
   * (ADR-0024 stage 4).
   *
   * `atMs` is milliseconds into the video; `null` restores the default frame,
   * which is not the first one — the backend takes a frame a tenth of the way
   * in, because a first frame tends to be a slate. Clearing is this request
   * with the value absent rather than a request of its own.
   *
   * The engine refuses it for anything that is not a video, and pinning the
   * moment it is already pinned to writes nothing.
   */
  | { readonly type: "asset:poster"; readonly hash: string; readonly atMs: number | null }
  /**
   * Creates an asset from text the window holds, under a name the user chose
   * (ADR-0026 §4).
   *
   * `text` may be empty, and usually is: **New file** asks for a name and
   * nothing else. The cost is real and is reported rather than prevented —
   * every empty file has one hash and `assets.hash` is the primary key, so the
   * library holds one empty file however many are made.
   *
   * Answers the hash and whether it is new; identical bytes are one asset, so a
   * file that already exists comes back with `created: false`.
   */
  | { readonly type: "asset:create"; readonly name: string; readonly text: string }
  /**
   * Reads the clipboard and does what its contents deserve (ADR-0026 §5).
   *
   * Answered in **main**: the clipboard is the desktop's, the renderer has no
   * ambient authority (invariant 11), and the engine has no shell. File paths
   * are imported, image bytes are imported under a synthesised name, text comes
   * back for a draft, and a URL is left alone — pasting never fetches.
   */
  | { readonly type: "clipboard:paste"; readonly mode: StorageMode }
  /**
   * Imports files and attaches them to this asset as caption tracks
   * (ADR-0025).
   *
   * One request rather than an import followed by an attach: apart, the two
   * have a state between them — a track imported and not attached is a stray
   * text asset in the grid — and the renderer would have to learn the hash of
   * something it only handed over a path to.
   *
   * Always imported **managed**, whatever the default mode is: the whole point
   * of a track being an asset is that it survives its source.
   *
   * Answers how many were attached. Files that are not subtitles are ignored
   * rather than refused, because the chooser can return a folder's worth.
   */
  | {
      readonly type: "asset:addSubtitle";
      readonly hash: string;
      readonly paths: readonly string[];
    }
  /**
   * Detaches a caption track and moves it to the trash (ADR-0025, ADR-0022).
   *
   * One request because the window offers one gesture: a track somebody is
   * finished with is a file they are finished with, and leaving the `.srt`
   * behind in the grid as an ordinary text asset was the wrong half of the
   * answer.
   *
   * `Delete` means what it means everywhere else — the trash, which keeps the
   * row and is reversible. Nothing is emptied on a schedule.
   */
  | { readonly type: "asset:subtitleDelete"; readonly hash: string; readonly track: string }
  /** Renames what the library shows. Nothing under `originals/` is touched. */
  | { readonly type: "asset:rename"; readonly hash: string; readonly name: string }
  | {
      readonly type: "asset:tagAdd";
      readonly hashes: readonly string[];
      readonly tags: readonly string[];
    }
  | {
      readonly type: "asset:tagRemove";
      readonly hashes: readonly string[];
      readonly tags: readonly string[];
    }
  /**
   * Puts the selection in a folder, or takes it out of one.
   *
   * **By id, not by path.** A path is what the window draws and it is what RQL
   * names, but folder names are unique only among siblings — and a name holding
   * a `/` is still readable from a library written before that was refused
   * (`TODO.md`), so a path can be ambiguous in exactly the case an edit must
   * not be. The id is the folder.
   *
   * Both take the whole selection, like the tag pair above and for the same
   * reason (`UI_SPEC.md` §3.2): the panel edits the selection, and one request
   * is one journal batch. Adding an asset already in the folder and removing
   * one that is not are both no-ops in the engine, so neither caller has to
   * check first.
   */
  | {
      readonly type: "asset:folderAdd";
      readonly hashes: readonly string[];
      readonly folder: number;
    }
  | {
      readonly type: "asset:folderRemove";
      readonly hashes: readonly string[];
      readonly folder: number;
    }
  /**
   * The folder tree's own three edits (ADR-0033).
   *
   * Separate from the membership pair above because they are about the shelf
   * rather than about what is on it: `folder:create` makes one, `folder:rename`
   * changes what it is called, and `folder:delete` takes it away along with its
   * descendants and every membership in them.
   *
   * **`trashContents` is the whole of the question `folder:delete` asks.**
   * `false` deletes the folder and leaves the assets in the library, no longer
   * filed anywhere; `true` sends every live asset in the subtree to the trash
   * in the same journal batch. It is never inferred — the window asks with a
   * checkbox and the CLI with a flag, because the two outcomes are not
   * degrees of the same thing.
   */
  | { readonly type: "folder:create"; readonly name: string; readonly parent: number | null }
  | { readonly type: "folder:rename"; readonly folder: number; readonly name: string }
  /**
   * Re-parents a folder. `null` is the top level, which is a real destination
   * rather than a missing one.
   *
   * The engine refuses a move into the folder's own subtree: it would cut that
   * subtree off from the root, leaving it undrawable in the pane and therefore
   * undeletable through it.
   */
  | { readonly type: "folder:move"; readonly folder: number; readonly parent: number | null }
  | {
      readonly type: "folder:delete";
      readonly folder: number;
      readonly trashContents: boolean;
    }
  /**
   * Add a comment to one asset, at a moment or about the whole of it (ADR-0023).
   *
   * `atMs` is milliseconds into the medium; `null` is a comment about the
   * asset, which is what lets a `.zip` carry one. One hash rather than the
   * selection: a comment is a paragraph about one thing, for the reason
   * `UI_SPEC.md` §3.2 keeps the note off a multi-selection.
   *
   * The id is minted and journalled by the engine, so it is neither sent nor
   * answered with — the caller re-reads the asset, like every other edit.
   */
  | {
      readonly type: "comment:add";
      readonly hash: string;
      readonly atMs: number | null;
      readonly body: string;
    }
  /**
   * Edit a comment in place, keeping its identity and its place in the list.
   *
   * By id rather than by hash and index: an index would name a different
   * comment the moment another window added one, and the id is what the
   * journal already carries.
   */
  | {
      readonly type: "comment:set";
      readonly id: number;
      readonly atMs: number | null;
      readonly body: string;
    }
  | { readonly type: "comment:remove"; readonly id: number }
  /**
   * Hand an asset to the desktop's own handler.
   *
   * Answered by **main**: it needs `shell.openPath`, and the engine has no
   * desktop. `CONCEPT.md` §5 — a library holds anything, so a format Roost
   * cannot draw must not be a dead end.
   */
  | { readonly type: "asset:openExternally"; readonly hash: string }
  /**
   * Hand a URL to the desktop's browser (ADR-0030 §5).
   *
   * Answered by **main**, which is where `shell` lives, and **refused unless
   * the scheme is `http:` or `https:`** — the renderer may not hand an
   * arbitrary scheme to the desktop's URL handler on a click, and `false` comes
   * back rather than an error, because a stored value that is not a link is an
   * ordinary state rather than a failure.
   *
   * This is not a network operation and does not touch invariant 7: nothing is
   * fetched here. The browser that opens is the user's, with their session and
   * their extensions, and Roost learns nothing about what it found.
   */
  | { readonly type: "link:open"; readonly url: string }
  /**
   * Show one asset in the desktop's file manager, selected.
   *
   * Answered by **main**, for the reason `asset:openExternally` gives, and with
   * the same rule: the renderer asks by hash and learns only whether the
   * desktop did something. A path is what main acts on, never what the renderer
   * receives.
   */
  | { readonly type: "asset:reveal"; readonly hash: string }
  /**
   * Put the selection's paths on the clipboard, one per line.
   *
   * Answered by **main**, which owns the clipboard. This is deliberately the
   * one way a path leaves the engine to somewhere a person can read it: the
   * user asked for it, it goes to them rather than to the renderer, and the
   * renderer learns only whether anything was copied.
   */
  | { readonly type: "asset:copyPath"; readonly hashes: readonly string[] }
  /**
   * Puts the selection on the clipboard as **files**, for pasting into a file
   * manager or anything else that takes them (ADR-0034).
   *
   * Not the same thing as `asset:copyPath`, which puts the paths on as text —
   * that reaches a terminal and a text field, and a file manager ignores it.
   * Both are offered, because they answer different questions.
   */
  | { readonly type: "asset:copyFiles"; readonly hashes: readonly string[] }
  /**
   * Move the selection to the trash, or bring it back out (ADR-0022).
   *
   * Reversible, and the only thing `Delete` does. Nothing on disk moves and no
   * metadata is lost — a trashed asset keeps its tags, rating, note, and folder
   * memberships, and simply stops matching every query but `is:trashed`.
   */
  | { readonly type: "assets:trash"; readonly hashes: readonly string[] }
  | { readonly type: "assets:restore"; readonly hashes: readonly string[] }
  /**
   * Remove the selection from the library, permanently.
   *
   * What "Delete permanently" sends. Not reversible: the row, everything
   * hanging off it, and the bytes it owned under `originals/` are all gone
   * (ADR-0031). A referenced original is never touched.
   */
  | { readonly type: "assets:remove"; readonly hashes: readonly string[] }
  /**
   * Remove everything the trash holds, and answer with what went.
   *
   * The count comes back because the renderer cannot compute it: emptying is
   * over what the *engine* sees in the trash, not over a selection, and the
   * status bar has to be able to say what happened.
   */
  | { readonly type: "assets:emptyTrash" }
  /**
   * What "Reclaim space" would delete: objects nothing references (ADR-0031).
   *
   * A whole-store walk, so it is asked for by a menu item and never on a
   * schedule. Separate from the reclaim itself because the numbers are what the
   * confirmation is *about* — nobody should approve a deletion whose size they
   * have not been shown.
   */
  | { readonly type: "library:reclaimable" }
  /**
   * Delete the objects nothing references, and answer with what went.
   *
   * Checks again rather than acting on the numbers the dialog was shown: those
   * are a screenful old by the time anyone clicks, and this deletes files.
   * Refuses — as `roost doctor --reclaim` does — when the index and the object
   * store disagree, because an orphan is only an orphan relative to the index.
   */
  | { readonly type: "library:reclaim" }
  /**
   * Copy the selection's originals into a directory the user chose.
   *
   * The one place Roost writes into a user's directory, and it does so only
   * because the user picked the directory in a dialog and asked for it by name.
   * Nothing under `originals/` is moved, modified, or removed — an export is a
   * copy out (`STORAGE_SPEC.md` invariant 6 is about the reverse direction).
   */
  | {
      readonly type: "assets:export";
      readonly hashes: readonly string[];
      readonly destination: string;
    }
  /**
   * Import files and directories into the open library.
   *
   * Paths, not bytes: the renderer gets a path for a dropped file from the
   * preload and never reads one. Directories are walked by the engine, which
   * is the side with a filesystem.
   *
   * Originals are never moved, modified, or deleted (`STORAGE_SPEC.md`
   * invariant 8), and in `referenced` mode nothing is written into the user's
   * directories at all.
   */
  | {
      readonly type: "import:paths";
      readonly paths: readonly string[];
      readonly mode: StorageMode;
      /** Applied to everything imported in this run. */
      readonly tags: readonly string[];
      /**
       * The folder every newly imported asset joins, or `null` for none
       * (ADR-0037).
       *
       * The window sends the folder it is showing, so an import lands where
       * the person who started it was looking. `null` where no folder is open
       * — the library's root is a destination, not a missing answer.
       *
       * Duplicates do not join it; `import:fileDuplicates` is how they can.
       */
      readonly folder: number | null;
    }
  /**
   * Put the last import's duplicates into a folder (ADR-0037 §3).
   *
   * The answer to the pop-up a finished import raises: these files were already
   * here, and *this* is where they should also be. It is an **add** — an asset
   * belongs to as many folders as it was put in — so nothing is taken out of
   * anywhere, and the dialog's other choice writes nothing at all.
   *
   * The hashes are not sent. The engine kept the list from the run that
   * reported them, because a large re-import produces more of them than a
   * window should be handed and then handed back.
   */
  | { readonly type: "import:fileDuplicates"; readonly folder: number }
  /**
   * What an Eagle library holds, without importing any of it (ADR-0032 §6).
   *
   * Writes nothing, and needs no library open: reading what is in an Eagle
   * library is a question that stands on its own, and answering it should not
   * require having somewhere to put the answer yet.
   *
   * It is **not** a filter. Nothing is selected from the result — the import
   * brings everything — so this exists to answer "what am I about to do",
   * including the parts that cannot be carried across.
   */
  | { readonly type: "eagle:survey"; readonly path: string }
  /**
   * Import an Eagle library, translating its metadata (ADR-0032).
   *
   * `managed` by default and by intention: `referenced` would leave every asset
   * pointing into the Eagle library, so deleting it afterwards would empty
   * Roost. Eagle's own library is only ever read.
   */
  | { readonly type: "eagle:import"; readonly path: string; readonly mode: StorageMode }
  /**
   * What the derive queue is holding, and what this machine can draw.
   *
   * Asked when the window opens a library and after a run finishes, so an
   * empty cell can say why it is empty rather than looking broken.
   */
  | { readonly type: "derive:status" }
  /**
   * Offer parked work again, now that a missing tool may exist.
   *
   * `reason` names which parked work to release — `missing:ffmpeg` after
   * installing it — or `null` for all of it. Releasing everything would also
   * retry formats this build genuinely cannot draw, which costs a full pass to
   * reach the same answer.
   */
  | { readonly type: "derive:retry"; readonly reason: string | null }
  /**
   * Ask the user for something to import. Answered by main.
   *
   * `what` picks the dialog rather than filtering one: `files` opens a file
   * chooser, `folders` a directory chooser. It used to be one dialog with both
   * properties set, which every desktop resolves by drawing the file chooser
   * and letting a directory be picked in it — so "import that folder" meant
   * navigating to the folder's parent, which is the one place its contents are
   * not shown.
   */
  | { readonly type: "dialog:chooseImport"; readonly what: ImportSubject }
  /**
   * The chooser for **Add subtitle…** (ADR-0025).
   *
   * Not `dialog:chooseImport` with `what: "files"`: that one says "Import" on
   * its button and takes anything. Attaching a caption track is narrower — it
   * is filtered to the extensions a subtitle has, and it opens in Downloads
   * rather than Pictures, because that is where one arrives.
   */
  | { readonly type: "dialog:chooseSubtitle" }
  /**
   * Ask the user for an Eagle library directory (ADR-0032).
   *
   * Its own chooser rather than `dialog:chooseImport` with `what: "folders"`,
   * for the reason {@link dialog:chooseSubtitle} has one: that dialog says
   * "Import" on its button and takes several directories, and this takes
   * exactly one and does something different with it.
   */
  | { readonly type: "dialog:chooseEagle" }
  /**
   * Ask the user for an existing library directory.
   *
   * Answered by **main**, not the engine: a dialog belongs to a window, and the
   * engine has none. It is a request like any other so that the renderer has
   * exactly one way to ask for anything.
   */
  | { readonly type: "dialog:openLibrary" }
  /** Ask the user where a new library should go. Answered by main. */
  | { readonly type: "dialog:chooseLocation" };

export type RequestType = Request["type"];

/** The member of {@link Request} named by `T`. */
export type RequestOf<T extends RequestType> = Extract<Request, { type: T }>;

/**
 * The response to each request.
 *
 * `null` where there is nothing to say: an explicit null round-trips through
 * `structuredClone` and through a validator, and `undefined` does not survive
 * every path it would have to take.
 */
export interface Responses {
  "library:open": LibrarySummary;
  "library:create": LibrarySummary;
  "library:current": LibrarySummary | null;
  "recent:list": readonly WireRecentLibrary[];
  /** The new list, so one round trip answers "and now?". */
  "recent:forget": readonly WireRecentLibrary[];
  "recent:pin": readonly WireRecentLibrary[];
  "library:close": null;
  "app:quit": null;
  "app:about": WireAbout;
  "library:stats": LibraryStats;
  "library:sidebar": WireSidebar;
  "assets:page": AssetPage;
  "assets:count": number;
  "query:check": QueryCheck;
  "query:split": WireSplitQuery;
  /** The composed query text, which the window puts in the search field. */
  "query:join": string;
  /** The rewritten query text, or the one that came in when it named no folder. */
  "query:subfolders": string;
  "settings:read": WireSettings;
  "settings:write": WireSettings;
  "asset:detail": WireAssetDetail | null;
  "asset:summary": WireSelectionSummary;
  /**
   * Every edit answers with `null` and the inspector re-reads.
   *
   * `UI_SPEC.md` asks each edit to read the record back rather than trust what
   * it sent, and an edit that returned its own idea of the new state would be
   * exactly the trust it is avoiding — the engine normalises names, drops an
   * all-whitespace note, and deduplicates tags.
   */
  "asset:rate": null;
  "asset:note": null;
  "asset:source": null;
  "asset:poster": null;
  "asset:rename": null;
  "asset:create": WireCreated;
  /** How many caption tracks were attached (ADR-0025). */
  "asset:addSubtitle": WireSubtitlesAdded;
  "asset:subtitleDelete": null;
  "clipboard:paste": WirePasted;
  "asset:tagAdd": null;
  "asset:tagRemove": null;
  "asset:folderAdd": null;
  "asset:folderRemove": null;
  /** The new folder's id, so the window can go straight to it. */
  "folder:create": number;
  "folder:rename": null;
  "folder:move": null;
  "folder:delete": WireFolderDeleted;
  "comment:add": null;
  "comment:set": null;
  "comment:remove": null;
  /** `false` when the desktop had no handler for it. */
  "asset:openExternally": boolean;
  /** `false` when the scheme is not `http(s)`, or the desktop refused it. */
  "link:open": boolean;
  /** `false` when the bytes are not on this machine. */
  "asset:reveal": boolean;
  /** `false` when nothing could be located, so nothing was put on the clipboard. */
  "asset:copyPath": boolean;
  /** How many files reached the clipboard; zero when none could be staged. */
  "asset:copyFiles": number;
  "assets:trash": null;
  "assets:restore": null;
  "assets:remove": WireRemoval;
  "assets:emptyTrash": WireRemoval;
  "library:reclaimable": WireReclaimable;
  /** What was actually deleted; `blocked` is always `null` here. */
  "library:reclaim": WireReclaimable;
  "assets:export": WireExportReport;
  "import:paths": WireImportReport;
  "import:fileDuplicates": WireFiled;
  "eagle:survey": WireEagleSurvey;
  "eagle:import": WireEagleReport;
  "derive:status": WireDeriveStatus;
  /** The status after the retry, so one round trip answers "and now?". */
  "derive:retry": WireDeriveStatus;
  /** `null` when the user cancelled; an empty array is not a thing a dialog returns. */
  "dialog:chooseImport": readonly string[] | null;
  /** The chosen subtitles, or `null` if the dialog was cancelled. */
  "dialog:chooseSubtitle": readonly string[] | null;
  /** One Eagle library directory, or `null` if the dialog was cancelled. */
  "dialog:chooseEagle": string | null;
  /** `null` when the user cancelled, which is an outcome rather than a failure. */
  "dialog:openLibrary": string | null;
  "dialog:chooseLocation": string | null;
}

export type ResponseOf<T extends RequestType> = Responses[T];

/** A validator per member. A member without one does not compile. */
export const REQUEST_VALIDATORS: {
  readonly [T in RequestType]: (source: Record<string, unknown>) => Checked<RequestOf<T>>;
} = {
  "library:open": (source) => {
    const path = readNonEmpty(source, "path");
    if (!path.ok) return path;
    return ok({ type: "library:open", path: path.value });
  },

  "library:create": (source) => {
    const parent = readNonEmpty(source, "parent");
    if (!parent.ok) return parent;
    // Non-empty is all this end knows: a library has to be called something.
    // What a filesystem will actually accept is the engine's question, and it
    // asks it before turning the name into a path.
    const name = readNonEmpty(source, "name");
    if (!name.ok) return name;
    return ok({ type: "library:create", parent: parent.value, name: name.value });
  },

  "library:current": () => ok({ type: "library:current" }),

  "recent:list": () => ok({ type: "recent:list" }),

  "recent:forget": (source) => {
    const root = readNonEmpty(source, "root");
    if (!root.ok) return root;
    return ok({ type: "recent:forget", root: root.value });
  },

  "recent:pin": (source) => {
    const root = readNonEmpty(source, "root");
    if (!root.ok) return root;
    const pinned = readBoolean(source, "pinned");
    if (!pinned.ok) return pinned;
    return ok({ type: "recent:pin", root: root.value, pinned: pinned.value });
  },
  "library:close": () => ok({ type: "library:close" }),
  "app:quit": () => ok({ type: "app:quit" }),
  "app:about": () => ok({ type: "app:about" }),
  "library:stats": () => ok({ type: "library:stats" }),
  "library:sidebar": () => ok({ type: "library:sidebar" }),

  "assets:page": (source) => {
    // An empty query is legal and means the whole library, so this is
    // `readString` rather than `readNonEmpty`.
    const query = readString(source, "query");
    if (!query.ok) return query;

    const limit = readInteger(source, "limit");
    if (!limit.ok) return limit;
    // A limit is bounded at both ends here rather than clamped, because a
    // renderer asking for a million rows is a bug and answering it politely
    // would hide the bug behind a slow window.
    if (limit.value < 1 || limit.value > MAX_PAGE_LIMIT) {
      return bad(`limit: expected 1 to ${MAX_PAGE_LIMIT}`);
    }

    const after = readCursor(source["after"]);
    if (!after.ok) return within("after", after);

    const sort = readSort(source["sort"]);
    if (!sort.ok) return within("sort", sort);

    return ok({
      type: "assets:page",
      query: query.value,
      limit: limit.value,
      after: after.value,
      sort: sort.value,
    });
  },
  "assets:count": (source) => {
    const query = readString(source, "query");
    return query.ok ? ok({ type: "assets:count", query: query.value }) : query;
  },

  "query:check": (source) => {
    const query = readString(source, "query");
    return query.ok ? ok({ type: "query:check", query: query.value }) : query;
  },

  "query:split": (source) => {
    const query = readString(source, "query");
    return query.ok ? ok({ type: "query:split", query: query.value }) : query;
  },

  "query:join": (source) => {
    // An empty place is the whole library, so `readString` rather than
    // `readNonEmpty` — filtering everything is the ordinary case.
    const place = readString(source, "place");
    if (!place.ok) return place;
    const facets = readFacets(source["facets"]);
    return facets.ok
      ? ok({ type: "query:join", place: place.value, facets: facets.value })
      : facets;
  },

  "query:subfolders": (source) => {
    const query = readString(source, "query");
    if (!query.ok) return query;
    const on = readBoolean(source, "on");
    return on.ok ? ok({ type: "query:subfolders", query: query.value, on: on.value }) : on;
  },

  "settings:read": () => ok({ type: "settings:read" }),

  "settings:write": (source) => {
    // Every field is optional and absent means "leave it alone", so a build
    // that learns another setting does not have to send the first one back.
    // A key that is present is still validated: "absent" and "not a boolean"
    // are different answers, and only the first of them is a request.
    const patch: {
      showSubfolderContents?: boolean;
      fitVideoToWindow?: boolean;
      mediaVolume?: number;
      mediaMuted?: boolean;
      sortKey?: SortKey;
      sortDescending?: boolean;
      shuffleSeed?: number;
      gridView?: string;
      matchImageProportions?: boolean;
      gridZoom?: number;
    } = {};

    for (const key of [
      "showSubfolderContents",
      "fitVideoToWindow",
      "mediaMuted",
      "sortDescending",
      "matchImageProportions",
    ] as const) {
      if (source[key] === undefined) continue;
      const on = readBoolean(source, key);
      if (!on.ok) return on;
      patch[key] = on.value;
    }

    if (source["sortKey"] !== undefined) {
      const key = readOneOf(source, "sortKey", SORT_KEYS);
      if (!key.ok) return key;
      patch.sortKey = key.value as SortKey;
    }

    // The view is a string rather than one of `GRID_VIEWS` on purpose: the
    // vocabulary is the window's, and an engine refusing a view it has not
    // heard of would refuse the next build's (`WireSettings`).
    if (source["gridView"] !== undefined) {
      const view = readNonEmpty(source, "gridView");
      if (!view.ok) return view;
      patch.gridView = view.value;
    }

    for (const key of ["shuffleSeed", "gridZoom"] as const) {
      if (source[key] === undefined) continue;
      const value = readInteger(source, key);
      if (!value.ok) return value;
      if (value.value < 0) return bad(`${key}: expected zero or more`);
      patch[key] = value.value;
    }

    // Percent, and bounded on both sides: the element takes 0–1 and throws on
    // anything outside it, so a window sending 400 would be a window that
    // cannot play the next video it opens.
    if (source["mediaVolume"] !== undefined) {
      const value = readInteger(source, "mediaVolume");
      if (!value.ok) return value;
      if (value.value < 0 || value.value > 100) return bad("mediaVolume: expected 0 to 100");
      patch.mediaVolume = value.value;
    }

    return ok({ type: "settings:write", ...patch });
  },

  "asset:detail": (source) => {
    const hash = readHash(source, "hash");
    return hash.ok ? ok({ type: "asset:detail", hash: hash.value }) : hash;
  },

  "asset:summary": (source) => {
    const hashes = readHashArray(source, "hashes");
    if (!hashes.ok) return hashes;
    return ok({ type: "asset:summary", hashes: hashes.value });
  },

  "asset:rate": (source) => {
    const hashes = readHashArray(source, "hashes");
    if (!hashes.ok) return hashes;
    const rating = readNullable(source, "rating", readInteger);
    if (!rating.ok) return rating;
    // The range is checked by the engine, which owns `MAX_RATING`. What is
    // checked here is that it is an integer or an explicit null — the shape,
    // not the rule.
    return ok({ type: "asset:rate", hashes: hashes.value, rating: rating.value });
  },

  "asset:note": (source) => {
    const hash = readHash(source, "hash");
    if (!hash.ok) return hash;
    const note = readNullable(source, "note", readString);
    if (!note.ok) return note;
    return ok({ type: "asset:note", hash: hash.value, note: note.value });
  },

  "asset:source": (source) => {
    const hash = readHash(source, "hash");
    if (!hash.ok) return hash;
    // No shape beyond "a string or an explicit null": what counts as a source
    // is the user's to decide (ADR-0030 §2), and the scheme is read where the
    // value is *opened*, not where it is stored.
    const url = readNullable(source, "url", readString);
    if (!url.ok) return url;
    return ok({ type: "asset:source", hash: hash.value, url: url.value });
  },

  "link:open": (source) => {
    const url = readNonEmpty(source, "url");
    return url.ok ? ok({ type: "link:open", url: url.value }) : url;
  },

  "asset:poster": (source) => {
    const hash = readHash(source, "hash");
    if (!hash.ok) return hash;
    const atMs = readMoment(source);
    if (!atMs.ok) return atMs;
    return ok({ type: "asset:poster", hash: hash.value, atMs: atMs.value });
  },

  "asset:create": (source) => {
    const name = readNonEmpty(source, "name");
    if (!name.ok) return name;
    // `readString`, not `readNonEmpty`: an empty file is the ordinary case
    // here, since the dialog asks for a name and nothing else.
    const text = readString(source, "text");
    if (!text.ok) return text;
    return ok({ type: "asset:create", name: name.value, text: text.value });
  },

  "clipboard:paste": (source) => {
    const mode = readOneOf(source, "mode", STORAGE_MODES);
    return mode.ok ? ok({ type: "clipboard:paste", mode: mode.value }) : mode;
  },

  "asset:addSubtitle": (source) => {
    const hash = readHash(source, "hash");
    if (!hash.ok) return hash;
    const paths = readStringArray(source, "paths");
    if (!paths.ok) return paths;
    if (paths.value.length === 0) return bad("paths: expected at least one");
    if (paths.value.some((path) => path.trim() === "")) {
      return bad("paths: expected non-empty strings");
    }
    return ok({ type: "asset:addSubtitle", hash: hash.value, paths: paths.value });
  },

  "asset:subtitleDelete": (source) => {
    const hash = readHash(source, "hash");
    if (!hash.ok) return hash;
    const track = readHash(source, "track");
    if (!track.ok) return track;
    return ok({ type: "asset:subtitleDelete", hash: hash.value, track: track.value });
  },

  "asset:rename": (source) => {
    const hash = readHash(source, "hash");
    if (!hash.ok) return hash;
    const name = readNonEmpty(source, "name");
    if (!name.ok) return name;
    return ok({ type: "asset:rename", hash: hash.value, name: name.value });
  },

  "asset:tagAdd": (source) => {
    const hashes = readHashArray(source, "hashes");
    if (!hashes.ok) return hashes;
    const tags = readStringArray(source, "tags");
    if (!tags.ok) return tags;
    return ok({ type: "asset:tagAdd", hashes: hashes.value, tags: tags.value });
  },

  "asset:tagRemove": (source) => {
    const hashes = readHashArray(source, "hashes");
    if (!hashes.ok) return hashes;
    const tags = readStringArray(source, "tags");
    if (!tags.ok) return tags;
    return ok({ type: "asset:tagRemove", hashes: hashes.value, tags: tags.value });
  },

  "asset:folderAdd": (source) => {
    const hashes = readHashArray(source, "hashes");
    if (!hashes.ok) return hashes;
    const folder = readFolder(source);
    if (!folder.ok) return folder;
    return ok({ type: "asset:folderAdd", hashes: hashes.value, folder: folder.value });
  },

  "asset:folderRemove": (source) => {
    const hashes = readHashArray(source, "hashes");
    if (!hashes.ok) return hashes;
    const folder = readFolder(source);
    if (!folder.ok) return folder;
    return ok({ type: "asset:folderRemove", hashes: hashes.value, folder: folder.value });
  },

  "folder:create": (source) => {
    const name = readNonEmpty(source, "name");
    if (!name.ok) return name;
    // `null` is the top level, which is a real answer rather than a missing
    // one: there is no root row for a folder to be created under.
    const parent = readNullable(source, "parent", readFolderIn);
    if (!parent.ok) return parent;
    return ok({ type: "folder:create", name: name.value, parent: parent.value });
  },

  "folder:rename": (source) => {
    const folder = readFolder(source);
    if (!folder.ok) return folder;
    const name = readNonEmpty(source, "name");
    if (!name.ok) return name;
    return ok({ type: "folder:rename", folder: folder.value, name: name.value });
  },

  "folder:move": (source) => {
    const folder = readFolder(source);
    if (!folder.ok) return folder;
    const parent = readNullable(source, "parent", readFolderIn);
    if (!parent.ok) return parent;
    return ok({ type: "folder:move", folder: folder.value, parent: parent.value });
  },

  "folder:delete": (source) => {
    const folder = readFolder(source);
    if (!folder.ok) return folder;
    const trashContents = readBoolean(source, "trashContents");
    if (!trashContents.ok) return trashContents;
    return ok({
      type: "folder:delete",
      folder: folder.value,
      trashContents: trashContents.value,
    });
  },

  "comment:add": (source) => {
    const hash = readHash(source, "hash");
    if (!hash.ok) return hash;
    const atMs = readMoment(source);
    if (!atMs.ok) return atMs;
    const body = readNonEmpty(source, "body");
    if (!body.ok) return body;
    return ok({ type: "comment:add", hash: hash.value, atMs: atMs.value, body: body.value });
  },

  "comment:set": (source) => {
    const id = readInteger(source, "id");
    if (!id.ok) return id;
    const atMs = readMoment(source);
    if (!atMs.ok) return atMs;
    const body = readNonEmpty(source, "body");
    if (!body.ok) return body;
    return ok({ type: "comment:set", id: id.value, atMs: atMs.value, body: body.value });
  },

  "comment:remove": (source) => {
    const id = readInteger(source, "id");
    return id.ok ? ok({ type: "comment:remove", id: id.value }) : id;
  },

  "asset:openExternally": (source) => {
    const hash = readHash(source, "hash");
    return hash.ok ? ok({ type: "asset:openExternally", hash: hash.value }) : hash;
  },

  "asset:reveal": (source) => {
    const hash = readHash(source, "hash");
    return hash.ok ? ok({ type: "asset:reveal", hash: hash.value }) : hash;
  },

  "asset:copyPath": (source) => {
    const hashes = readHashArray(source, "hashes");
    return hashes.ok ? ok({ type: "asset:copyPath", hashes: hashes.value }) : hashes;
  },

  "asset:copyFiles": (source) => {
    const hashes = readHashArray(source, "hashes");
    return hashes.ok ? ok({ type: "asset:copyFiles", hashes: hashes.value }) : hashes;
  },

  "assets:trash": (source) => {
    const hashes = readHashArray(source, "hashes");
    return hashes.ok ? ok({ type: "assets:trash", hashes: hashes.value }) : hashes;
  },

  "assets:restore": (source) => {
    const hashes = readHashArray(source, "hashes");
    return hashes.ok ? ok({ type: "assets:restore", hashes: hashes.value }) : hashes;
  },

  "assets:remove": (source) => {
    const hashes = readHashArray(source, "hashes");
    return hashes.ok ? ok({ type: "assets:remove", hashes: hashes.value }) : hashes;
  },

  "assets:emptyTrash": () => ok({ type: "assets:emptyTrash" }),

  "library:reclaimable": () => ok({ type: "library:reclaimable" }),

  "library:reclaim": () => ok({ type: "library:reclaim" }),

  "assets:export": (source) => {
    const hashes = readHashArray(source, "hashes");
    if (!hashes.ok) return hashes;
    const destination = readNonEmpty(source, "destination");
    if (!destination.ok) return destination;
    return ok({ type: "assets:export", hashes: hashes.value, destination: destination.value });
  },

  "import:paths": (source) => {
    const paths = readStringArray(source, "paths");
    if (!paths.ok) return paths;
    if (paths.value.length === 0) return bad("paths: expected at least one");
    if (paths.value.some((path) => path.trim() === "")) {
      return bad("paths: expected non-empty strings");
    }
    const mode = readOneOf(source, "mode", STORAGE_MODES);
    if (!mode.ok) return mode;
    const tags = readStringArray(source, "tags");
    if (!tags.ok) return tags;
    // `null` is an import into no folder at all, which is what an import made
    // outside one does (ADR-0037 §2).
    const folder = readNullable(source, "folder", readFolderIn);
    if (!folder.ok) return folder;
    return ok({
      type: "import:paths",
      paths: paths.value,
      mode: mode.value,
      tags: tags.value,
      folder: folder.value,
    });
  },

  "import:fileDuplicates": (source) => {
    const folder = readFolder(source);
    return folder.ok ? ok({ type: "import:fileDuplicates", folder: folder.value }) : folder;
  },

  "eagle:survey": (source) => {
    const path = readNonEmpty(source, "path");
    return path.ok ? ok({ type: "eagle:survey", path: path.value }) : path;
  },

  "eagle:import": (source) => {
    const path = readNonEmpty(source, "path");
    if (!path.ok) return path;
    const mode = readOneOf(source, "mode", STORAGE_MODES);
    if (!mode.ok) return mode;
    return ok({ type: "eagle:import", path: path.value, mode: mode.value });
  },

  "derive:status": () => ok({ type: "derive:status" }),

  "derive:retry": (source) => {
    // `null` releases everything parked; a string releases only what is parked
    // on that reason.
    const reason = readNullable(source, "reason", readNonEmpty);
    if (!reason.ok) return reason;
    return ok({ type: "derive:retry", reason: reason.value });
  },

  "dialog:chooseImport": (source) => {
    const what = readOneOf(source, "what", IMPORT_SUBJECTS);
    return what.ok ? ok({ type: "dialog:chooseImport", what: what.value }) : what;
  },

  "dialog:chooseSubtitle": () => ok({ type: "dialog:chooseSubtitle" }),

  "dialog:chooseEagle": () => ok({ type: "dialog:chooseEagle" }),

  "dialog:openLibrary": () => ok({ type: "dialog:openLibrary" }),
  "dialog:chooseLocation": () => ok({ type: "dialog:chooseLocation" }),
};

/**
 * The most rows one request may ask for.
 *
 * Not a performance guess: `DEFAULT_PAGE_LIMIT` is 100, a screen of grid with
 * room to scroll into, and this is two orders above it. Anything larger is a
 * caller that meant to page and did not.
 */
export const MAX_PAGE_LIMIT = 10_000;

/**
 * A folder id, refused here when it could not be one.
 *
 * Rowids start at one, so zero and below are not a folder that has been deleted
 * but a number that was never an id — the same distinction `readMoment` draws
 * below. Whether the folder still exists is the engine's to answer, and it
 * raises rather than inventing one.
 */
function readFolder(source: Record<string, unknown>): Checked<number> {
  return readFolderIn(source, "folder");
}

/** The same check under whatever key names the folder. */
function readFolderIn(source: Record<string, unknown>, key: string): Checked<number> {
  const folder = readInteger(source, key);
  if (!folder.ok) return folder;
  if (folder.value < 1) return bad(`${key}: expected a folder id`);
  return folder;
}

/**
 * A moment into a medium: milliseconds, or `null` for a comment about the asset.
 *
 * Refused here rather than left to the engine, unlike a rating's range: a
 * negative offset is not a value out of bounds but a number that cannot mean
 * anything, and the same check runs again where the journal is written
 * (`op.ts`) because that is the side that has to survive a replay.
 */
function readMoment(source: Record<string, unknown>): Checked<number | null> {
  const at = readNullable(source, "atMs", readInteger);
  if (!at.ok) return at;
  if (at.value !== null && at.value < 0) return bad("atMs: expected zero or more milliseconds");
  return at;
}

/** A cursor as it arrives: `null`, or the two fields a previous page handed out. */
/**
 * The filter bar's three facets, checked one field at a time (ADR-0035).
 *
 * A star is checked against the five the schema has rather than against a
 * range: `rating:0` is not unrated, it is a value the grammar refuses, and a
 * message that gets past here would be refused deeper down where nothing can
 * say which field was wrong.
 */
function readFacets(value: unknown): Checked<WireFacets> {
  if (!isRecord(value)) return bad("facets: expected an object");
  const tags = readStringArray(value, "tags");
  if (!tags.ok) return tags;
  const exts = readStringArray(value, "exts");
  if (!exts.ok) return exts;
  const unrated = readBoolean(value, "unrated");
  if (!unrated.ok) return unrated;
  const tagRule = readOneOf(value, "tagRule", TAG_RULES);
  if (!tagRule.ok) return tagRule;

  const stars = value["stars"];
  if (!Array.isArray(stars)) return bad("facets.stars: expected an array");
  const checked: WireStars[] = [];
  for (const star of stars) {
    if (typeof star !== "number" || !STARS.includes(star as WireStars)) {
      return bad(`facets.stars: expected one of ${STARS.join(", ")}`);
    }
    checked.push(star as WireStars);
  }

  return ok({
    tags: tags.value,
    tagRule: tagRule.value as WireTagRule,
    stars: checked,
    unrated: unrated.value,
    exts: exts.value,
  });
}

function readCursor(value: unknown): Checked<WireCursor | null> {
  if (value === null) return ok(null);
  if (!isRecord(value)) return bad("expected null or an object");
  // The key is whatever the order made of the last row (ADR-0039 §4) — a
  // timestamp, a size, a folded name, a rotated hash — so this checks that it
  // is one of the two things a sort key can be and nothing more. A cursor is
  // the engine's own words handed back; validating its *meaning* here would be
  // the contract holding a second opinion about the order.
  const key = value["key"];
  if (typeof key !== "number" && typeof key !== "string") {
    return bad("key: expected a number or a string");
  }
  if (typeof key === "number" && !Number.isFinite(key)) return bad("key: expected a finite number");
  const hash = readHash(value, "hash");
  if (!hash.ok) return hash;
  return ok({ key, hash: hash.value });
}

/** The order a page is asked for, or `null` for the default (ADR-0039). */
function readSort(value: unknown): Checked<WireSort | null> {
  if (value === null) return ok(null);
  if (!isRecord(value)) return bad("expected null or an object");
  const key = readOneOf(value, "key", SORT_KEYS);
  if (!key.ok) return key;
  const descending = readBoolean(value, "descending");
  if (!descending.ok) return descending;
  const seed = readInteger(value, "seed");
  if (!seed.ok) return seed;
  // Negative seeds are refused rather than folded: a frontend that rolls one is
  // rolling a random number, and a negative one is a sign it rolled something
  // else.
  if (seed.value < 0) return bad("seed: expected zero or more");
  return ok({ key: key.value as SortKey, descending: descending.value, seed: seed.value });
}

export const REQUEST_TYPES = Object.keys(REQUEST_VALIDATORS) as RequestType[];

export function isRequestType(value: string): value is RequestType {
  return Object.hasOwn(REQUEST_VALIDATORS, value);
}

/**
 * Validates one request from an untrusted value.
 *
 * The `type` is read first so an unknown one is reported as itself rather than
 * as a missing field of whatever member happened to be tried.
 */
export function checkRequest(value: unknown): Checked<Request> {
  if (!isRecord(value)) return bad("expected an object");
  const type = value["type"];
  if (typeof type !== "string") return bad("type: expected a string");
  if (!isRequestType(type)) return bad(`type: unknown request "${type}"`);
  // Every validator returns its own member, and every member is a `Request`.
  return within(type, REQUEST_VALIDATORS[type](value) as Checked<Request>);
}
