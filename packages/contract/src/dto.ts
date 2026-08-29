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
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly importedAt: number;
  readonly rating: number | null;
  readonly isFavorite: boolean;
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

/** The navigation pane, in the order it is drawn. */
export interface WireSidebar {
  readonly places: readonly SidebarRow[];
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
  readonly rating: number | null;
  readonly note: string | null;
  readonly isFavorite: boolean;
  readonly tags: readonly string[];
  /** Slash-separated folder paths this asset is in. */
  readonly folders: readonly string[];
  /** Video and audio only, in milliseconds. */
  readonly durationMs: number | null;
  /** Documents only. */
  readonly pageCount: number | null;
  /**
   * Whatever the format's own backend had to say: a font's family and style, a
   * video's codec, an audio file's sample rate.
   *
   * A map rather than fields, because the vocabulary is per format and grows
   * with each backend (`DATA_MODEL.md` §2.5). The renderer shows what is there
   * and knows nothing about what any key means.
   */
  readonly props: Readonly<Record<string, string>>;
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
