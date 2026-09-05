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

/** Whether an asset's bytes were copied into the library or left where they are. */
export const STORAGE_MODES = ["managed", "referenced"] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];

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
  readonly favorite: "all" | "none" | "mixed";
  /** Tags every selected asset carries. */
  readonly sharedTags: readonly string[];
  /** Tags some of them carry. */
  readonly partialTags: readonly string[];
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
  readonly favorites: number;
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
 */
export interface WireCursor {
  readonly importedAt: number;
  readonly hash: string;
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
  readonly isFavorite: boolean;
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
  /** The group a tag belongs to, or `null`. Groups are shown in order. */
  readonly group: string | null;
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

/** The navigation pane, in the order it is drawn. */
export interface WireSidebar {
  readonly places: readonly SidebarRow[];
  /** One row per star, always five, drawn under Places (`UI_SPEC.md` §4.1). */
  readonly ratings: readonly SidebarRow[];
  readonly folders: readonly SidebarRow[];
  readonly smartFolders: readonly SidebarRow[];
  readonly tags: readonly SidebarRow[];
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
  readonly isFavorite: boolean;
  readonly tags: readonly string[];
  /** Slash-separated folder paths this asset is in. */
  readonly folders: readonly string[];
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
