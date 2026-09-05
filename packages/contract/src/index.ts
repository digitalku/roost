/**
 * `@roost/contract` is the IPC surface as data: one union of request messages,
 * one union of event messages, and a validator per member (ADR-0007).
 *
 * It is imported by main, preload, the renderer, and the engine, so it depends
 * on nothing — not on `@roost/core`, not on a Node built-in, not on the DOM.
 * That is enforced by the compiler rather than asked for in review: this is the
 * one package with no `@types/node` (`CLAUDE.md` §6).
 *
 * Anything `structuredClone` cannot carry does not belong here, and neither do
 * bytes — those travel over `roost://` (ADR-0008).
 */

export type { Outcome, RoostBridge } from "./bridge.js";
export {
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
export {
  ASSET_KINDS,
  type AssetCard,
  type AssetKind,
  type AssetPage,
  type DeriveProgress,
  type ImportProgress,
  LIBRARY_SUFFIX,
  type LibraryStats,
  type LibrarySummary,
  type QueryCheck,
  type SidebarRow,
  STORAGE_MODES,
  type StorageMode,
  type WireAssetDetail,
  type WireCapability,
  type WireComment,
  type WireCreated,
  type WireCursor,
  type WireDeriveReason,
  type WireDeriveStatus,
  type WireExportReport,
  type WireImportFailure,
  type WireImportReport,
  type WirePasted,
  type WireProblem,
  type WireRecentLibrary,
  type WireSelectionSummary,
  type WireSidebar,
  type WireSubtitle,
} from "./dto.js";
export {
  checkEventEnvelope,
  checkReplyEnvelope,
  checkRequestEnvelope,
  type EventEnvelope,
  type Message,
  type ReplyEnvelope,
  type RequestEnvelope,
} from "./envelope.js";
export {
  checkEvent,
  EVENT_TYPES,
  EVENT_VALIDATORS,
  type Event,
  type EventOf,
  type EventType,
  isEventType,
} from "./event.js";
export {
  checkRequest,
  isRequestType,
  MAX_PAGE_LIMIT,
  REQUEST_TYPES,
  REQUEST_VALIDATORS,
  type Request,
  type RequestOf,
  type RequestType,
  type ResponseOf,
  type Responses,
} from "./request.js";
