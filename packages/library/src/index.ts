/**
 * `@roost/library` is the application service layer: everything the CLI and the
 * engine both need, and nothing either of them owns alone.
 *
 * It never imports `electron` — directly or transitively — because the CLI is
 * what proves the layering and the CLI has no Electron in it.
 */
export { discover } from "./discover.js";
export {
  AlreadyALibraryError,
  AmbiguousHashError,
  LibraryBusyError,
  LibraryTooNewError,
  NotALibraryError,
  PartialHashCollisionError,
  UnknownAssetError,
} from "./error.js";
export {
  type FixtureOptions,
  type FixtureReport,
  generateFixture,
} from "./fixture.js";
export {
  filesPerSecond,
  type ImportFailure,
  type ImportOptions,
  type ImportReport,
  type ImportTimings,
  importInto,
  rankedStages,
} from "./import.js";
export { Library, nowUnix, type OpenOptions } from "./library.js";
export {
  discoverLibrary,
  LIBRARY_FORMAT_VERSION,
  MANIFEST_FILE,
  type Manifest,
  newManifest,
  readManifest,
  writeManifest,
} from "./manifest.js";
export { generateMissing, type ThumbnailReport } from "./thumbnails.js";
