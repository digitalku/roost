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
