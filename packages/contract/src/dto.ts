/**
 * The shapes that travel between processes.
 *
 * Deliberately **not** the types in `@roost/core`. This package depends on
 * nothing (ADR-0007), so the wire shapes are declared here and the engine maps
 * its own types onto them. The duplication is the boundary: adding a column to
 * `assets` then has to be a decision about the wire rather than a side effect
 * of one about the schema.
 *
 * Nothing here may be anything `structuredClone` cannot carry — no class
 * instances, no functions, no `Date` where a unix integer will do — and nothing
 * here may be bytes. Thumbnails and originals travel over `roost://`
 * (ADR-0008); a `Uint8Array` in this file is a review failure.
 */

/**
 * What a library directory is called: `<Name>.roost` (ADR-0014).
 *
 * Declared here as well as in `@roost/library` because the renderer needs it to
 * show what it is about to create, and this package is the only one it may
 * import. The engine asserts the two agree — two constants that must match and
 * cannot import each other need a test, not a comment.
 */
export const LIBRARY_SUFFIX = ".roost";

/**
 * The backends a window may ask to have installed (ADR-0042).
 *
 * Two, and both of them optional at runtime (ADR-0017, ADR-0040). The three
 * that ship with Roost are absent on purpose: there is nothing to install, and
 * a vocabulary that named them would invite a request that means nothing.
 *
 * Here rather than beside the request that carries it, because the event the
 * install emits names a backend too and the two files may not import each
 * other.
 */
export const INSTALLABLE_BACKENDS = ["media", "heif"] as const;

/** One of {@link INSTALLABLE_BACKENDS}. */
export type InstallableBackend = (typeof INSTALLABLE_BACKENDS)[number];

/** Whether an asset's bytes were copied into the library or left where they are. */
export const STORAGE_MODES = ["managed", "referenced"] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];

/**
 * What the import chooser offers to pick.
 *
 * The two are separate dialogs rather than one that accepts either, because a
 * file chooser and a directory chooser are different controls on every desktop
 * Roost runs on: the file one filters and previews, the directory one navigates
 * into what the other one would have opened. A single dialog offering both is
 * the compromise that does neither well, and the `Add` menu (`UI_SPEC.md` §1)
 * has room to ask which was meant before the dialog opens.
 */
export const IMPORT_SUBJECTS = ["files", "folders"] as const;
export type ImportSubject = (typeof IMPORT_SUBJECTS)[number];

/**
 * What an asset broadly is, which is what selects the preview (`UI_SPEC.md` §7).
 *
 * Declared here as well as in `@roost/core` because the renderer needs it and
 * this package is the only one it may import — the same duplication ADR-0007
 * calls the boundary. The engine asserts the two agree.
 *
 * `other` is not a failure. A format Roost cannot draw still imports, still
 * carries tags, and opens in the application that owns it.
 */
export const ASSET_KINDS = ["image", "video", "audio", "document", "font", "other"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * The orders the view menu can ask for (ADR-0039).
 *
 * Declared here as well as in `@roost/core` for the reason above, and checked
 * against it the same way. Each key but the last names something the schema has
 * an index for; `random` is a seeded shuffle with no index and no column, and
 * it is the one order that costs what it costs.
 *
 * `added` is the order the application had before it had a menu, and it is
 * still the default.
 */
export const SORT_KEYS = ["added", "created", "name", "size", "rating", "random"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export function isSortKey(value: string): value is SortKey {
  return (SORT_KEYS as readonly string[]).includes(value);
}

/**
 * The three ways a grid can be drawn (ADR-0018).
 *
 * Here rather than only in the renderer because the chosen one is remembered in
 * the library (ADR-0039 §7), and a preference that crosses the boundary needs a
 * vocabulary on both sides of it. What each view *looks like* stays entirely in
 * the renderer.
 */
export const GRID_VIEWS = ["icons", "compact", "details"] as const;
export type GridView = (typeof GRID_VIEWS)[number];

export function isGridView(value: string): value is GridView {
  return (GRID_VIEWS as readonly string[]).includes(value);
}

/** What the window shows about the library it has open. */
export interface LibrarySummary {
  readonly root: string;
  readonly name: string;
  readonly id: string;
  readonly formatVersion: number;
  readonly schemaVersion: number;
}

/**
 * One row of the picker's recent list.
 *
 * `available` is checked when the list is read rather than stored, because the
 * answer changes without this application being involved. An entry that is gone
 * is shown and marked rather than hidden — dropping it silently reads as the
 * application having forgotten.
 */
export interface WireRecentLibrary {
  readonly root: string;
  readonly name: string;
  readonly id: string;
  /** Unix seconds. */
  readonly openedAt: number;
  readonly pinned: boolean;
  readonly available: boolean;
}

/**
 * What deleting a folder did (ADR-0033).
 *
 * One number, and it is the one the status bar has to say: a delete that also
 * emptied the folder into the trash and one that only removed the shelf look
 * identical afterwards in the sidebar, and only one of them is undone by
 * restoring.
 */
export interface WireFolderDeleted {
  readonly trashed: number;
}

/**
 * One folder, as a thing an asset is in rather than a row to draw.
 *
 * **Both fields, because neither substitutes for the other.** `id` is what
 * `asset:folderAdd` and `asset:folderRemove` name — the journal's ops name a
 * folder by id, and it is the only way to be exact about which folder is meant.
 * `path` is what the window draws: folder names are unique only among siblings,
 * so `Icons` alone does not say which `Icons`.
 */
export interface WireFolderRef {
  readonly id: number;
  /** Slash-separated, from the root: `Design/Icons`. */
  readonly path: string;
}

/**
 * What a selection of several assets shares, and what it does not.
 *
 * The inspector edits the selection, so it has to be able to say "3 assets ·
 * mixed ratings" — and a tag two of three assets carry is not the same thing as
 * one all three carry. One request rather than a detail per asset: a selection
 * is routinely hundreds of rows and the panel shows a summary of them.
 */
export interface WireSelectionSummary {
  readonly count: number;
  readonly totalBytes: number;
  /** The rating they all carry, or `null` when they disagree or none is rated. */
  readonly rating: number | null;
  readonly ratingMixed: boolean;
  /** Tags every selected asset carries. */
  readonly sharedTags: readonly string[];
  /** Tags some of them carry. */
  readonly partialTags: readonly string[];
  /** Folders every selected asset is in. */
  readonly sharedFolders: readonly WireFolderRef[];
  /** Folders some of them are in, drawn apart exactly as the tags are. */
  readonly partialFolders: readonly WireFolderRef[];
  /** The commonest extensions present, most first. At most five. */
  readonly kinds: readonly string[];
}

/** The counts behind a library's summary view. */
export interface LibraryStats {
  readonly assets: number;
  readonly managed: number;
  readonly referenced: number;
  readonly partialHashes: number;
  readonly totalBytes: number;
  readonly tags: number;
  readonly tagGroups: number;
  readonly folders: number;
  readonly smartFolders: number;
  readonly rated: number;
  readonly notes: number;
  readonly trashed: number;
  readonly thumbnails: number;
}

/**
 * The error shape a rejected request carries.
 *
 * A `RoostError` does not survive `structuredClone` — the algorithm keeps
 * `name`, `message`, and `stack` and discards the prototype with every own
 * property the subclass added, so the `code` that made it actionable would be
 * lost. `@roost/core` converts to and from this shape; the field is a plain
 * string here because the list of codes is the engine's business, not the
 * renderer's.
 */
export interface WireProblem {
  readonly code: string;
  readonly message: string;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Where a listing resumes.
 *
 * Keyset paging, never an offset (`DATA_MODEL.md`): a cursor costs the same at
 * row 900,000 as at row 100, and the grid scrolls through both. The renderer
 * never builds one — it sends back what the previous page handed it.
 *
 * `key` is the sort key's value on the last row of the page, whatever that
 * order made of it (ADR-0039 §4). **It is opaque here on purpose**: a window
 * that understood it would be a window with a second opinion about the order,
 * and the order is defined in SQL.
 */
export interface WireCursor {
  readonly key: number | string;
  readonly hash: string;
}

/**
 * The order a listing is asked for (ADR-0039).
 *
 * Sent with the page rather than held by the engine: the request says what it
 * wants, and the *preference* — which is a different thing — lives in
 * `settings.json` and reaches the window through {@link WireSettings}. Two
 * windows onto one library therefore share the remembered order and can still
 * be looking at it differently for as long as one of them is changed.
 */
export interface WireSort {
  readonly key: SortKey;
  /** Newest, largest, five stars, Z first. The key's own words, not a symbol. */
  readonly descending: boolean;
  /**
   * Which shuffle `random` means. Ignored by every other key.
   *
   * A number the window rolls and gives back; what it selects is the engine's
   * business. Seeds past the last shuffle wrap onto one it has.
   */
  readonly seed: number;
}

/**
 * One asset, as much of it as a grid cell draws.
 *
 * `width` and `height` are `| null` rather than optional, because that is what
 * the column holds: absent for anything not probed as an image or a video. The
 * grid needs them to reserve a cell's shape before the thumbnail arrives, which
 * is the difference between laying out once and reflowing on every load
 * (`UI_SPEC.md` §6).
 *
 * No thumbnail here, and there never will be one: the cell asks for
 * `roost://thumb/<hash>@256` and the bytes never enter a message (invariant 12).
 */
export interface AssetCard {
  readonly hash: string;
  readonly name: string;
  readonly ext: string;
  /**
   * What the asset broadly is, so the grid knows whether opening it means the
   * preview or the desktop.
   *
   * Here rather than fetched on a double-click: a file Roost cannot draw goes
   * straight to the application that owns it (`UI_SPEC.md` §6), and a round
   * trip to find that out would put a blank pane on screen first.
   */
  readonly kind: AssetKind;
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly importedAt: number;
  readonly rating: number | null;
  /**
   * The moment a video's thumbnail is pinned to, or `null` (ADR-0024 stage 4).
   *
   * Here because it is part of the thumbnail's **address** rather than because
   * a cell draws it. `roost://thumb/<hash>@<size>` is served as immutable on
   * the promise that a hash and a size fix the pixels; a pinned frame is the
   * one thing that can change them, so it goes in the URL and the promise
   * stays true.
   */
  readonly posterMs: number | null;
}

/** One page of the grid, and where the next one starts. */
export interface AssetPage {
  readonly assets: readonly AssetCard[];
  /** `null` when this was the last page, so the grid stops asking. */
  readonly next: WireCursor | null;
}

/**
 * One row of the navigation pane.
 *
 * **Every row carries the RQL that selects it** (`UI_SPEC.md` §4.1), built in
 * `@roost/library`. The renderer never assembles a query string: a frontend
 * concatenating `tag:Some Name` would be a second, worse implementation of the
 * grammar, and it is the decision that keeps the search field honest — what it
 * shows is what is actually being asked.
 */
export interface SidebarRow {
  /** Unique within its section, and stable enough to key a list on. */
  readonly id: string;
  readonly name: string;
  readonly query: string;
  /** `null` where a count would be a second query nobody asked for. */
  readonly count: number | null;
  /** How deep in the folder tree, for indentation. Zero everywhere else. */
  readonly depth: number;
  /**
   * Filled stars to draw, or `null` for a row that is not a rating.
   *
   * A number, not a glyph: the engine says what the row *is* and the window
   * decides what that looks like. `0` is the unrated row — not a rating of
   * zero, which the schema does not have.
   */
  readonly stars: number | null;
  /** The group a tag belongs to, or `null`. Groups are shown in order. */
  readonly group: string | null;
}

/**
 * What **Add subtitle…** or a drop onto an open video did (ADR-0025).
 *
 * `ignored` carries the paths that were not subtitles, so a caller that offered
 * a whole drop to the video can send the rest to the import it would otherwise
 * have gone to — without the window needing to know which extensions count as a
 * subtitle, which is the engine's list and should stay there.
 */
export interface WireSubtitlesAdded {
  readonly attached: number;
  readonly ignored: readonly string[];
}

/**
 * One caption track attached to an asset (ADR-0025).
 *
 * The hash is the track's own — it is an ordinary asset — and it is what
 * `roost://subtitle/<hash>` addresses. Bytes do not travel here (invariant 12):
 * what crosses is the sentence saying this track captions that video.
 */
export interface WireSubtitle {
  readonly hash: string;
  /** BCP-47 where a filename or a stream declared one, `null` where none did. */
  readonly lang: string | null;
  readonly label: string | null;
  /** The track's own filename, which is what a menu falls back to. */
  readonly name: string;
  /**
   * Whether Roost can serve it without an external tool.
   *
   * SubRip and WebVTT convert here; ASS and an embedded stream need ffmpeg,
   * which is a capability and may be absent. A menu shows the difference rather
   * than offering a row that produces an empty track.
   */
  readonly servable: boolean;
}

/**
 * A folder's row, which is a {@link SidebarRow} and two things only a folder
 * has.
 *
 * The sidebar draws it as any other row and never reads the extra fields. They
 * are here for the inspector, which offers **every** folder to add to and needs
 * to name the one that is chosen: the window already re-reads this tree
 * whenever the library changes, so a second request for the same rows would be
 * a second read of one small table and a second idea of what it holds.
 */
export interface SidebarFolderRow extends SidebarRow {
  /** The folder's own id, which is what an edit names. */
  readonly folder: number;
  /** Slash-separated, from the root. `name` is only the last segment. */
  readonly path: string;
  /**
   * Every live asset in this folder and beneath it (ADR-0036).
   *
   * `count` is the count of this row's *query*, which follows *Show subfolder
   * contents*; this one never does. **Delete folder…** asks about the subtree
   * whatever the pane is drawing, so the question and what it does have to be
   * counted the same way.
   */
  readonly descendants: number;
}

/**
 * One extension the library holds, for the filter bar's Types facet
 * (ADR-0035).
 *
 * The one thing here that is **not** a {@link SidebarRow}, and the missing
 * field is the reason: it carries no query. A facet value is `OR`ed with the
 * others ticked beside it, so what selects it depends on what else is on — the
 * engine composes that when asked, and no single row can carry it.
 */
export interface SidebarTypeRow {
  /** Lowercased and without a dot, as the schema stores it. `""` for none. */
  readonly ext: string;
  readonly count: number;
}

/** The navigation pane, in the order it is drawn, and the vocabularies over it. */
export interface WireSidebar {
  readonly places: readonly SidebarRow[];
  /**
   * One row per star, then unrated — six, always.
   *
   * Drawn by the filter bar since 2026-09-07 rather than by the pane
   * (ADR-0035). Still here, and still six: what moved is where the counts are
   * shown, not what the engine answers.
   */
  readonly ratings: readonly SidebarRow[];
  readonly folders: readonly SidebarFolderRow[];
  readonly smartFolders: readonly SidebarRow[];
  /** Every tag: the bar's Tags facet, and the inspector's suggestions. */
  readonly tags: readonly SidebarRow[];
  /** Every extension the library holds, commonest first (ADR-0035). */
  readonly types: readonly SidebarTypeRow[];
}

/** The five ratings a filter can select. Unrated is not one of them. */
export const STARS = [1, 2, 3, 4, 5] as const;

export type WireStars = (typeof STARS)[number];

/**
 * How several tags in the filter bar are joined (ADR-0035 §7).
 *
 * `any` matches an asset carrying one of them, `all` an asset carrying every
 * one. Tags are the only facet with a rule: an asset has one extension and one
 * rating, so `all` on either would be a button whose only outcome is an empty
 * grid.
 */
export const TAG_RULES = ["any", "all"] as const;

export type WireTagRule = (typeof TAG_RULES)[number];

/**
 * What the filter bar has narrowed the query to (ADR-0035).
 *
 * Structured, never a query string: the renderer holds this, changes one field
 * of it, and asks the engine for the query it spells. Within a facet the values
 * are `OR`ed and across facets they are `AND`ed — which is the only thing two
 * ratings can mean together.
 */
export interface WireFacets {
  readonly tags: readonly string[];
  /**
   * Whether the tags are `OR`ed or `AND`ed.
   *
   * Below two tags both rules spell the same query, so the window remembers the
   * choice and a split reports `any` (ADR-0035 §7.2). It is the one thing in
   * the bar not read back out of the query, and deliberately the one thing the
   * query cannot express.
   */
  readonly tagRule: WireTagRule;
  readonly stars: readonly WireStars[];
  /** `is:unrated`, which sits in the rating facet without being a rating. */
  readonly unrated: boolean;
  readonly exts: readonly string[];
}

/**
 * This library's preferences (ADR-0019).
 *
 * They live in `settings.json` inside the library, so they travel with the
 * folder and both frontends read the same ones.
 */
export interface WireSettings {
  /** Whether opening a folder shows what is in its subfolders (ADR-0036). */
  readonly showSubfolderContents: boolean;
  /** The order the grid is in, and which shuffle is on (ADR-0039). */
  readonly sortKey: SortKey;
  readonly sortDescending: boolean;
  readonly shuffleSeed: number;
  /**
   * The view menu's three (ADR-0018, ADR-0039 §7).
   *
   * `gridView` arrives as a plain string rather than a `GridView`, because the
   * list of views is a fact about the interface and the engine holds no copy of
   * it: a value this build does not know falls back to `icons` in the window,
   * where the vocabulary is. `gridZoom` is a cell's width in CSS pixels, which
   * the window clamps to its own steps.
   */
  readonly gridView: string;
  readonly matchImageProportions: boolean;
  readonly gridZoom: number;
  /**
   * Whether the preview scales a video up to the pane (ADR-0024 §8).
   *
   * Off is the state the pane has always had: a video is fitted but never
   * blown up, so a 320×240 clip is 320×240 in a pane ten times its size.
   */
  readonly fitVideoToWindow: boolean;
  /**
   * How loud the player is, and whether it is silenced (ADR-0024 §9).
   *
   * A whole percent, 0–100, rather than the element's own 0–1 — the slider and
   * the keyboard both move in percent, and this is the number a person reads if
   * they open `settings.json`. Muting travels with it: giving back the volume
   * and not the silence is the same surprise pointing the other way.
   */
  readonly mediaVolume: number;
  readonly mediaMuted: boolean;
}

/** A query read as somewhere to look plus what the bar narrowed it to. */
export interface WireSplitQuery {
  /** Everything the bar does not own, in the words it was written in. */
  readonly place: string;
  readonly facets: WireFacets;
  /**
   * Whether the query on screen reaches into subfolders (ADR-0036).
   *
   * `true` for `folder:`, `false` for `infolder:`, and **`null` when the query
   * names no folder** — the checkbox has nothing to reflect then and shows the
   * library's setting, which is what the next folder opened will use.
   */
  readonly subfolders: boolean | null;
  /**
   * Whether the bar can show this query honestly.
   *
   * False for a top-level `OR`, or two terms of one facet, which mean `AND`
   * where the bar can only mean `OR`. Nothing is absorbed then: every chip is
   * off, and choosing one adds to the query rather than claiming to own it.
   */
  readonly representable: boolean;
}

/**
 * Whether a query parses, and where it stopped if it did not.
 *
 * The parse error crosses as a message and a position rather than as a
 * `WireProblem`, because it is not a failure: a half-typed query is the normal
 * state of a search field, and the field draws a caret under it rather than an
 * error state (`UI_SPEC.md` §5).
 *
 * `at` is a **JavaScript string index**, not a byte offset. The Rust
 * implementation reports bytes; a caret in a text input is measured in UTF-16
 * code units, and a byte offset points at the wrong character the moment a
 * query contains anything outside ASCII.
 */
export interface QueryCheck {
  readonly ok: boolean;
  /** `null` when the query parses. */
  readonly message: string | null;
  /** `null` when the failure has nowhere to point — an empty query does not. */
  readonly at: number | null;
}

/**
 * Everything the inspector shows about one asset.
 *
 * Deliberately a second declaration of what `@roost/core` already knows
 * (ADR-0007): adding a column to `assets` has to be a decision about the wire
 * rather than a side effect of one about the schema. `origName` becomes `name`
 * here, because the wire calls it what the interface draws.
 *
 * `rating` is `null` for unrated, which is **not** the same as zero
 * (`DATA_MODEL.md`): zero is a deliberate "bad", and the control must be able
 * to express the difference.
 */
export interface WireAssetDetail {
  readonly hash: string;
  readonly name: string;
  readonly ext: string;
  /**
   * Decided by the engine from the format table, not from the extension in the
   * renderer: `@roost/media` owns that table, and a second copy of it here
   * would disagree the first time a format is added.
   */
  readonly kind: AssetKind;
  /**
   * Whether an `<img>` can show the asset's own bytes (ADR-0040 §7).
   *
   * `false` for HEIC, RAW and TIFF: Roost imports all three and Chromium
   * decodes none of them, so the pane asks `roost://render/<hash>` for a
   * rendition instead of loading the original. Decided by the engine from the
   * same format table `kind` comes from, for the same reason — a second copy of
   * Chromium's decoder list in the renderer would disagree the first time a
   * format is added.
   */
  readonly browserDrawable: boolean;
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly storageMode: StorageMode;
  /** Where a referenced original lives; `null` for a managed one. */
  readonly refPath: string | null;
  readonly isPartialHash: boolean;
  /** The source file's mtime, unix seconds. `null` when it was not readable. */
  readonly createdAt: number | null;
  readonly importedAt: number;
  /** Unix seconds if this asset is in the trash, `null` if it is live. */
  readonly trashedAt: number | null;
  readonly rating: number | null;
  readonly note: string | null;
  /**
   * Where the file came from, as the user typed it (ADR-0030).
   *
   * Unparsed and unnormalised, so it is not necessarily a URL a browser would
   * accept. The window decides from the scheme whether to offer opening it.
   */
  readonly sourceUrl: string | null;
  readonly tags: readonly string[];
  /** The folders this asset is in (`UI_SPEC.md` §3.9). */
  readonly folders: readonly WireFolderRef[];
  /** Video and audio only, in milliseconds. */
  readonly durationMs: number | null;
  /** The moment this video's thumbnail is pinned to (ADR-0024 stage 4). */
  readonly posterMs: number | null;
  /**
   * The asset that replaced this one, or `null` if this is the current version
   * (ADR-0026).
   *
   * The window needs it for two things: to say *you are looking at an old
   * version* about something reached through `is:superseded`, and to refuse to
   * edit one — a save made from an old version would supersede the version that
   * already superseded it.
   */
  readonly supersededBy: string | null;
  /** Documents only. */
  readonly pageCount: number | null;
  /** Caption tracks attached to this asset, in the order they were attached. */
  readonly subtitles: readonly WireSubtitle[];
  /**
   * Whatever the format's own backend had to say: a font's family and style, a
   * video's codec, an audio file's sample rate.
   *
   * A map rather than fields, because the vocabulary is per format and grows
   * with each backend (`DATA_MODEL.md` §2.5). The renderer shows what is there
   * and knows nothing about what any key means.
   */
  readonly props: Readonly<Record<string, string>>;
  /**
   * Comments, timed ones first and in timeline order (ADR-0023).
   *
   * Carried by the detail rather than fetched on their own, because both
   * readers already have one: the inspector draws the list under the note, and
   * the preview draws a tick per comment under the player. A second request
   * would be a second round trip for both, and two ideas of when the list is
   * stale.
   */
  readonly comments: readonly WireComment[];
}

/**
 * One comment, and the moment it points at (ADR-0023).
 *
 * `atMs` is milliseconds into the medium, and `null` means the comment is about
 * the asset rather than about a moment in it — which is what lets a `.zip`
 * carry one. It is the one number on this wire that is **not** unix seconds,
 * and it is spelled `atMs` so that it cannot be read as one.
 *
 * There is no `hash` here: comments arrive inside the detail of the asset they
 * are on, so a hash would be a second copy of what the reader already asked by.
 */
export interface WireComment {
  readonly id: number;
  readonly atMs: number | null;
  readonly body: string;
  /** Unix seconds, like every other timestamp here. */
  readonly createdAt: number;
  /** `null` until the comment is edited. */
  readonly updatedAt: number | null;
}

/** One of the backends that draws a format, and whether this machine has it. */
export interface WireCapability {
  readonly name: string;
  readonly available: boolean;
  readonly version: string | null;
  /** One line for a person: which build is loaded, or what to install. */
  readonly detail: string;
  /**
   * The command that would install it on this machine, or `null` when it is
   * already here (ADR-0040 §5).
   *
   * A separate field from `detail` because the two are read at different
   * lengths and in different places: the status bar has room for a sentence,
   * and a shell command belongs somewhere it can be copied rather than
   * truncated. Chosen from `/etc/os-release` in the engine — the renderer has
   * no filesystem and could not work out which distribution it is on.
   */
  readonly install: string | null;
  /**
   * Whether a button may be drawn beside that command (ADR-0042).
   *
   * A boolean and nothing else: the window is told whether it may *ask*, never
   * what would run. The command it displays is the engine's too, and displaying
   * it is all the window does with it — which is what keeps a compromised
   * renderer (invariant 11) from reaching a program, a flag, or a path.
   */
  readonly installable: boolean;
}

/** What running the install said, and what this machine can do now. */
export interface WireInstallOutcome {
  /** Whether the package manager exited clean. "Already installed" is `false`. */
  readonly installed: boolean;
  /** Its own words, progress bars removed. Shown verbatim, never translated. */
  readonly detail: string;
  /**
   * The capabilities as they are **now**, re-probed after the run.
   *
   * Carried back so one round trip answers "and now?", the way `derive:retry`
   * answers with the status it produced.
   */
  readonly capabilities: readonly WireCapability[];
}

/** Why derived work is parked, and how much of it. */
export interface WireDeriveReason {
  readonly reason: string;
  readonly count: number;
}

/**
 * What the derive queue is holding.
 *
 * The window shows this so that an empty cell can say *why* it is empty — a
 * format nothing draws, or a tool nobody installed (`ROADMAP.md` M4).
 */
export interface WireDeriveStatus {
  readonly ready: number;
  readonly running: number;
  readonly blocked: number;
  readonly failed: number;
  readonly reasons: readonly WireDeriveReason[];
  readonly capabilities: readonly WireCapability[];
}

/** One of the files a derive could not draw. */
export interface WireDeriveFailureSample {
  readonly hash: string;
  readonly name: string;
  readonly ext: string;
}

/** Files whose derive failed for what is recognisably the same reason. */
export interface WireDeriveFailureGroup {
  /**
   * The backend's own message, with the parts that differ from file to file
   * taken out — paths and hashes. Grouped on this, and shown as it is: the
   * window turns it into a sentence for a person, and keeps this underneath so
   * a bug report has the real words.
   */
  readonly reason: string;
  readonly count: number;
  /** The most tries any file in the group has had. */
  readonly attempts: number;
  readonly samples: readonly WireDeriveFailureSample[];
}

/**
 * What could not be drawn, and why (`UI_SPEC.md` §3.13).
 *
 * A count on its own is not something anybody can act on: it says a number of
 * files are missing previews without saying which, or what went wrong. This is
 * the answer behind that number.
 */
export interface WireDeriveFailures {
  /** Every failed job, including any beyond `read`. */
  readonly total: number;
  /** How many rows were actually grouped. Below `total` only at scale. */
  readonly read: number;
  /** Failures in groups too small to be worth a row of their own. */
  readonly hidden: number;
  readonly groups: readonly WireDeriveFailureGroup[];
}

/**
 * How far the derive queue has got.
 *
 * Like {@link ImportProgress}, this carries numbers rather than pointing at
 * something to re-read: they exist only while the run is happening.
 */
export interface DeriveProgress {
  readonly derived: number;
  readonly remaining: number;
  readonly blocked: number;
  readonly failed: number;
}

/**
 * What filing an import's duplicates into a folder did (ADR-0037 §3).
 *
 * `expired` is the honest answer to a dialog left open too long: the list
 * belongs to the last run, and another import — or closing the library —
 * replaces it. Nothing was filed then, and the window says so rather than
 * reporting a zero that reads like "they were already there".
 */
export interface WireFiled {
  readonly filed: number;
  readonly expired: boolean;
}

/** One file that could not be imported, and why. */
export interface WireImportFailure {
  readonly path: string;
  readonly reason: string;
}

/**
 * What an import did.
 *
 * `duplicates` is not a failure: deduplication is structural — identical bytes
 * have one address (`STORAGE_SPEC.md` invariant 1) — so re-importing a folder
 * is the ordinary case, and the number is here to say so rather than to warn.
 *
 * The timings are deliberately absent. They are a benchmark's business, and a
 * window that showed them would invite reading a single run as a measurement.
 */
export interface WireImportReport {
  readonly scanned: number;
  readonly imported: number;
  readonly duplicates: number;
  /** Probable duplicates: a partial hash matched, and the bytes were unreachable. */
  readonly partialDuplicates: number;
  /** Refused: a partial hash matched an existing asset but the bytes did not. */
  readonly partialCollisions: number;
  readonly bytes: number;
  /**
   * Subtitles attached to the file they were found beside (ADR-0025 §3).
   *
   * A journal write the run made from a filename rather than from an
   * instruction, so the window says it happened.
   */
  readonly subtitles: number;
  /** Subtitles that found no film beside them, and are now loose in the grid. */
  readonly subtitlesUnattached: number;
  /**
   * The first few duplicates by name, for the dialog to draw (ADR-0037 §3.1).
   *
   * A preview, never the whole list: re-importing a large directory is the
   * ordinary way to produce a hundred thousand duplicates, and a window cannot
   * draw that many names or usefully be sent them. `duplicates` is the total,
   * and the engine holds the rest — `import:fileDuplicates` acts on all of
   * them without any of them crossing back.
   */
  readonly duplicateNames: readonly string[];
  /**
   * Thumbnails generated for what was imported.
   *
   * Part of the same run rather than a separate step, because the grid an
   * import produces is otherwise a screen of placeholders. The CLI keeps them
   * apart — `roost import` then `roost thumb` — because a headless import into
   * a library nobody is looking at should not pay for pictures.
   */
  readonly thumbnails: number;
  readonly elapsedMs: number;
  readonly failed: readonly WireImportFailure[];
}

/** A folder Eagle allows and Roost does not, and the name it will get. */
export interface WireFolderRename {
  readonly from: string;
  readonly to: string;
}

/**
 * What an Eagle library holds, before anything is imported (ADR-0032 §6).
 *
 * Counts rather than lists, with two exceptions. The renames are named because
 * the user is being asked to approve them, and there are as many as there are
 * folders — a number, not a library's worth. Everything else that could grow
 * without bound arrives as a count: a survey of a hundred thousand items must
 * not put a hundred thousand strings through the port to fill in a dialog that
 * would say "and 99,990 more".
 */
export interface WireEagleSurvey {
  /** Eagle's `applicationVersion`, so a surprise is attributable. */
  readonly version: string;
  readonly items: number;
  /** Eagle's own total, which is what a survey can know without hashing. */
  readonly bytes: number;
  readonly folders: number;
  readonly tagGroups: number;
  readonly tags: number;
  readonly rated: number;
  readonly notes: number;
  readonly sources: number;
  readonly comments: number;
  readonly subtitles: number;
  readonly trashed: number;
  readonly renamedFolders: readonly WireFolderRename[];
  /** Items whose file is not where Eagle's metadata says it is. */
  readonly missing: number;
  /** Item directories whose `metadata.json` could not be read. */
  readonly unreadable: number;
}

/**
 * What importing an Eagle library did (ADR-0032).
 *
 * `assets` and `imported` are different numbers and both are worth showing:
 * a subtitle is an asset of its own (ADR-0025), so a library of fourteen items
 * with one `.srt` beside a film writes fifteen files. `collapsed` is the count
 * that reads as data loss when it arrives unexplained — Eagle identifies an
 * item by id and Roost by content hash, so identical bytes are one asset here.
 */
export interface WireEagleReport {
  readonly items: number;
  readonly assets: number;
  readonly imported: number;
  readonly duplicates: number;
  readonly collapsed: number;
  readonly folders: number;
  readonly tagGroups: number;
  readonly tagged: number;
  readonly ratings: number;
  readonly notes: number;
  readonly sources: number;
  /**
   * What Eagle brought for an asset that already had one (ADR-0032 §8).
   *
   * Eagle fills what is empty and never overwrites, so this is the number that
   * says the import declined to say something — and without it, "the note did
   * not change" and "there was no note" look the same afterwards.
   */
  readonly preserved: number;
  readonly comments: number;
  readonly trashed: number;
  readonly subtitles: number;
  readonly bytes: number;
  readonly thumbnails: number;
  readonly elapsedMs: number;
  readonly failed: readonly WireImportFailure[];
}

/**
 * What pasting found on the clipboard, and what was done about it (ADR-0026 §5).
 *
 * Paste is four gestures wearing one name, and only two of them import. The
 * clipboard is read in **main**, because the renderer has no ambient authority
 * (invariant 11) and a sandboxed page cannot be trusted with the desktop's
 * clipboard even if it could reach it.
 *
 * `text` hands the words back for a draft rather than importing them: a
 * paragraph on the clipboard is something to put in a file, not a file.
 *
 * `url` does **nothing**. Invariant 7 permits exactly one network operation —
 * an explicit, user-initiated import from a URL — and a fetch triggered by
 * `Ctrl+V` is precisely what that rule exists to forbid.
 */
export type WirePasted =
  | { readonly kind: "imported"; readonly report: WireImportReport }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "empty" };

/**
 * A file the window made, and whether it is new (ADR-0026 §4).
 *
 * `created` is `false` when the bytes were already in the library: identical
 * bytes are one asset by invariant 1, so writing a file that already exists
 * answers with the one that is there rather than adding a second row.
 */
export interface WireCreated {
  readonly hash: string;
  readonly created: boolean;
}

/**
 * How far an import has got.
 *
 * Counts only — no path. A progress event fires per file, a bulk import is
 * hundreds of thousands of them, and a string per event is a string per file
 * crossing two process boundaries for a status bar nobody reads at that speed.
 */
export interface ImportProgress {
  readonly scanned: number;
  readonly imported: number;
  readonly duplicates: number;
  readonly failed: number;
  /** Non-zero once the import is done and the thumbnails are being made. */
  readonly thumbnails: number;
  /**
   * How many there are in total, when that is known before the run ends.
   *
   * `null` for an import of paths, and not as an oversight: the total is the
   * walk's own result, so a bar that filled to an estimate would jump back
   * every time the walk found more. An Eagle import knows it from the survey,
   * which is the whole difference — there, "3 of 14" is a fact rather than a
   * guess (ADR-0032).
   */
  readonly total: number | null;
}

/**
 * What a removal took out of the library (ADR-0031).
 *
 * Two numbers because they answer two different questions, and only one of them
 * used to be answerable: how much of the library is gone, and how much of the
 * disk came back. `bytes` is zero for a referenced asset — those bytes are the
 * user's own file, and Roost does not touch them (invariant 6) — so a status
 * line that said only "Deleted 3 assets" would leave the interesting half out.
 */
export interface WireRemoval {
  readonly assets: number;
  readonly bytes: number;
}

/**
 * What "Reclaim space" would delete, or did (ADR-0031).
 *
 * `blocked` carries the reason a reclaim would be refused — the index and the
 * object store disagree, so "nothing references these bytes" may simply be the
 * index being wrong — or `null` when it is safe. It is a sentence for the user
 * rather than a flag, because the answer is always the same action (`roost
 * rebuild`) and the interesting part is which disagreement was found.
 */
export interface WireReclaimable {
  readonly objects: number;
  readonly bytes: number;
  readonly blocked: string | null;
}

/**
 * What an export did.
 *
 * Counts rather than a list of names: exporting a selection of ten thousand is
 * one gesture, and the interesting answer is "how many, and did any not make
 * it" rather than a scroll of filenames nobody reads.
 *
 * `renamed` is the subset that landed under a suffixed name because the
 * destination already held that filename. It is reported separately because a
 * silent rename is the one outcome a person would want to know about — the file
 * they went looking for afterwards is not called what they expected.
 */
export interface WireExportReport {
  readonly exported: number;
  readonly renamed: number;
  /** Assets whose bytes are not on this machine — a moved `referenced` original. */
  readonly missing: number;
  readonly failed: number;
}

/**
 * What the About dialog says about the build it is running in (ADR-0038 §5.1).
 *
 * Answered by **main**, because everything here is the shell's own knowledge:
 * the renderer has no `process` and no `app`, and inventing these in the
 * renderer would mean maintaining a second version number that drifts.
 *
 * **Both identifiers are nullable, and for the same reason**: a build says what
 * it knows and nothing more. Seen in a real window on 2026-09-08 — an
 * unpackaged Electron reports *Electron's own* version from `app.getVersion()`,
 * so the dialog claimed to be Roost 43.4.1. A build that is not packaged has no
 * version, and saying so is the only answer that cannot mislead a support
 * email.
 *
 * `commit` is null in a build that was not told which one it is. `ROOST_COMMIT`
 * is set by `scripts/dev.mjs` from `git rev-parse` and by packaging; a bare
 * `electron .` run has no way to know. Between the two, one of them is
 * populated in every build anybody can report a bug from.
 */
export interface WireAbout {
  /** `null` in an unpackaged build, which has no version of its own. */
  readonly version: string | null;
  readonly commit: string | null;
  readonly electron: string;
  readonly chromium: string;
}
