/**
 * `@roost/library` is the application service layer: everything the CLI and the
 * engine both need, and nothing either of them owns alone.
 *
 * It never imports `electron` — directly or transitively — because the CLI is
 * what proves the layering and the CLI has no Electron in it.
 */
export { discover } from "./discover.js";
export {
  addToFolder,
  apply,
  createFolder,
  createSmartFolder,
  createTagGroup,
  deleteFolder,
  deleteSmartFolder,
  deleteTagGroup,
  MAX_RATING,
  moveFolder,
  rate,
  removeAssets,
  removeFromFolder,
  renameAsset,
  renameFolder,
  renameTagGroup,
  resolveAsset,
  resolveFolder,
  resolveSmartFolder,
  resolveTagGroup,
  setFavorite,
  setNote,
  setTagGroup,
  tagAdd,
  tagRemove,
  tagRename,
  updateSmartFolder,
} from "./edit.js";
export {
  AlreadyALibraryError,
  AmbiguousHashError,
  EmptyNameError,
  FolderCycleError,
  InvalidRatingError,
  LibraryBusyError,
  LibraryTooNewError,
  NotALibraryError,
  PartialHashCollisionError,
  UnknownAssetError,
  UnknownFolderError,
  UnknownFolderPathError,
  UnknownSmartFolderError,
  UnknownTagGroupError,
} from "./error.js";
export {
  type FixtureOptions,
  type FixtureReport,
  generateFixture,
} from "./fixture.js";
export { childrenById, descendants } from "./folder-tree.js";
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
export {
  compileFor,
  count,
  list,
  matches,
  pageOf,
  pages,
  search,
} from "./search.js";
export {
  type FolderEntry,
  readSidebar,
  type Sidebar,
  type SmartFolderEntry,
  type TagEntry,
} from "./sidebar.js";
export { generateMissing, type ThumbnailReport } from "./thumbnails.js";
