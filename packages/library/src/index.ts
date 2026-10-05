/**
 * `@roost/library` is the application service layer: everything the CLI and the
 * engine both need, and nothing either of them owns alone.
 *
 * It never imports `electron` — directly or transitively — because the CLI is
 * what proves the layering and the CLI has no Electron in it.
 */
export { chooseThumbnail, chosenThumbnails, clearThumbnail } from "./chosen.js";
export { discover, type Measured, measure } from "./discover.js";
export {
  type Ambiguous,
  type Changed,
  check,
  DOCTOR_PAGE,
  type DoctorOptions,
  type DoctorReport,
  type DoctorStage,
  hasDamage,
  isClean,
  type Missing,
  type Orphan,
  RECLAIM_MODES,
  type ReclaimMode,
  reclaim,
  reclaimableBytes,
  type Unrecognised,
  unsoundForReclaim,
} from "./doctor.js";
export {
  type EagleComment,
  type EagleFolder,
  type EagleImportOptions,
  type EagleItem,
  type EagleProgress,
  type EagleReport,
  type EagleRoot,
  type EagleSurvey,
  type EagleTagGroup,
  type FolderRename,
  importEagle,
  readEagleRoot,
  surveyEagle,
} from "./eagle.js";
export {
  addComment,
  addToFolder,
  apply,
  attachSubtitle,
  comments,
  createAsset,
  createFolder,
  createSmartFolder,
  createTagGroup,
  deleteFolder,
  deleteSmartFolder,
  deleteSubtitle,
  deleteTagGroup,
  detachSubtitle,
  emptyTrash,
  type FolderDeletion,
  MAX_EDIT_BYTES,
  MAX_RATING,
  moveFolder,
  poster,
  type Removal,
  rate,
  removeAssets,
  removeComment,
  removeFromFolder,
  renameAsset,
  renameFolder,
  renameTagGroup,
  resolveAsset,
  resolveFolder,
  resolveSmartFolder,
  resolveTagGroup,
  restoreAssets,
  saveEdit,
  setComment,
  setNote,
  setPoster,
  setSource,
  setTagGroup,
  subtitles,
  tagAdd,
  tagRemove,
  tagRename,
  trashAssets,
  updateSmartFolder,
} from "./edit.js";
export {
  AlreadyALibraryError,
  AmbiguousFolderNameError,
  AmbiguousIdError,
  DuplicateFolderNameError,
  EditTooLargeError,
  EmptyCommentError,
  EmptyNameError,
  FolderCycleError,
  InvalidLibraryNameError,
  InvalidMomentError,
  InvalidRatingError,
  LibraryBusyError,
  LibraryNameTakenError,
  LibraryNotFoundError,
  LibraryTooNewError,
  NotALibraryError,
  NotAnEagleLibraryError,
  NotAPictureError,
  NotAVideoError,
  NotEditableError,
  SameLibraryError,
  TransferRunningError,
  UnknownAssetError,
  UnknownCommentError,
  UnknownFolderError,
  UnknownFolderPathError,
  UnknownSmartFolderError,
  UnknownTagGroupError,
  UnsoundReclaimError,
} from "./error.js";
export { type ExportReport, exportAssets } from "./export.js";
export {
  type FixtureOptions,
  type FixtureReport,
  generateFixture,
} from "./fixture.js";
export { childrenById, descendants } from "./folder-tree.js";
export {
  fileInPlaces,
  filesPerSecond,
  type ImportBytes,
  type ImportFailure,
  type ImportOptions,
  type ImportReport,
  type ImportTimings,
  importInto,
  rankedStages,
} from "./import.js";
export {
  type DeriveFailureGroup,
  type DeriveFailureSample,
  type DeriveFailures,
  type DeriveReport,
  deriveFailures,
  enqueueDerives,
  enqueueMissing,
  type FailureOptions,
  normaliseReason,
  type QueueStatus,
  queueStatus,
  type Redrawn,
  type RunOptions,
  releaseNowSupported,
  retryBlocked,
  retryFailed,
  runDerives,
} from "./jobs.js";
export { type JournalNotice, NOTHING_SKIPPED, type SkippedOp } from "./journal-state.js";
export { type FoldProgress, Library, nowUnix, type OpenOptions } from "./library.js";
export {
  alignExtension,
  type FileAmbiguous,
  type FileMissing,
  idFromPath,
  type Located,
  type Resolution,
  resolveFile,
} from "./locate.js";
export {
  discoverLibrary,
  LIBRARY_FORMAT_VERSION,
  MANIFEST_FILE,
  type Manifest,
  newManifest,
  readManifest,
  writeManifest,
} from "./manifest.js";
export { ByteMeter, LARGE_FILE, type MeterShare } from "./meter.js";
export {
  checkLibraryName,
  hasLibrarySuffix,
  LIBRARY_SUFFIX,
  libraryDirectory,
  libraryNameFromPath,
  withLibrarySuffix,
} from "./naming.js";
export {
  forgetLibrary,
  listRecent,
  pinLibrary,
  RECENT_FILE,
  RECENT_LIMIT,
  type RecentEntry,
  type RecentLibrary,
  recentPath,
  rememberLibrary,
} from "./recent.js";
export {
  type CatchUpOptions,
  type CatchUpReport,
  catchUp,
  type RefreshOutcome,
  refreshAsset,
} from "./refresh.js";
export {
  findMovedLibrary,
  ROOT_POLL_MS,
  type RootWatcher,
  type RootWatchOptions,
  renameLibrary,
  renameTarget,
  watchRoot,
} from "./rename.js";
export {
  compileFor,
  count,
  findFolders,
  list,
  matches,
  pageOf,
  pages,
  type Section,
  type SectionedPage,
  search,
  sectionedPage,
} from "./search.js";
export {
  type FolderEntry,
  type PlaceEntry,
  readSidebar,
  type Sidebar,
  type SmartFolderEntry,
  type TagEntry,
  type TypeEntry,
} from "./sidebar.js";
export {
  addSubtitles,
  isSubtitlePath,
  languageFrom,
  type SubtitlesAdded,
} from "./subtitles.js";
export {
  ensurePreview,
  generateMissing,
  redrawPoster,
  type ThumbnailReport,
} from "./thumbnails.js";
export {
  type TransferFailure,
  type TransferOptions,
  type TransferProgress,
  type TransferReport,
  transferAssets,
  transferToLibrary,
} from "./transfer.js";
export { Requested, Wanted } from "./wanted.js";
export { type FileWatcher, type WatchOptions, watchFiles } from "./watch.js";
