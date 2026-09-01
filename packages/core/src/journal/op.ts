import {
  type ContentHash,
  isContentHash,
  isLinkMethod,
  isStorageMode,
  type LinkMethod,
  RoostError,
  type StorageMode,
} from "../model/index.js";

/**
 * Every `op` string this build understands, sorted.
 *
 * One list, used by replay to tell "written by a newer Roost" from "corrupt".
 * In the Rust implementation this was two lists once, and they drifted the
 * first time an operation was added.
 */
export const OP_NAMES = [
  "add",
  "asset_rename",
  "favorite_set",
  "folder_add",
  "folder_create",
  "folder_delete",
  "folder_move",
  "folder_remove",
  "folder_rename",
  "note_set",
  "rate",
  "remove",
  "restore",
  "smart_folder_create",
  "smart_folder_delete",
  "smart_folder_update",
  "tag_add",
  "tag_group_create",
  "tag_group_delete",
  "tag_group_rename",
  "tag_group_set",
  "tag_remove",
  "tag_rename",
  "trash",
] as const;

export type OpName = (typeof OP_NAMES)[number];

export function isOpName(value: string): value is OpName {
  return (OP_NAMES as readonly string[]).includes(value);
}

/**
 * The optional fields of an `add`.
 *
 * **The distinction between `?:` and `| null` here is the file format**, not a
 * style choice. A field declared `?:` is *omitted* when absent, because
 * `JSON.stringify` drops `undefined`; a field declared `| null` is always
 * written, because an absent field and an explicit `null` mean different things
 * to the operations that carry one (`STORAGE_SPEC.md` §Ops added after v1).
 *
 * Three of these exist only here: `created`, `ref`, and `partial` cannot be
 * recovered from `originals/`, so a rebuild without them loses data.
 */
export interface AddRecord {
  readonly hash: ContentHash;
  readonly ext: string;
  readonly size: number;
  /** The user's original filename. On disk the name is the hash (invariant 3). */
  readonly name: string;
  readonly mode: StorageMode;
  /** Absent in referenced mode: nothing was linked, because nothing was placed. */
  readonly link?: LinkMethod;
  readonly w?: number;
  readonly h?: number;
  /** Source file mtime, unix seconds. The library copy's mtime is the import time. */
  readonly created?: number;
  /** Absolute path, referenced mode only. Replay has nowhere else to learn it. */
  readonly ref?: string;
  /**
   * Mirrors `assets.is_partial_hash`. Derivable from `size` today, but recorded
   * so that changing the threshold later cannot reinterpret old records. Only
   * ever written when true.
   */
  readonly partial?: true;
}

/**
 * Every operation this build understands.
 *
 * Adding an operation is always safe: older builds skip `op` values they do not
 * recognise. **Repurposing one is not** — an older build would apply it under
 * its old meaning. Add a new `op` instead.
 */
export type Op =
  | ({ readonly op: "add" } & AddRecord)
  | { readonly op: "remove"; readonly hash: ContentHash }
  /**
   * Trash and restore (ADR-0022).
   *
   * Neither carries a timestamp of its own: the journal line already has `ts`,
   * and replay writes `assets.trashed_at` from it. Two `trash` ops for one
   * asset are idempotent — the later one wins, which is what somebody who
   * trashed, restored, and trashed again would expect Trash to show.
   *
   * `trash` is reversible and `remove` is not. That is the whole distinction:
   * `remove` keeps exactly the meaning it has always had, and is what "Empty
   * trash" and "Delete permanently" send.
   */
  | { readonly op: "trash"; readonly hash: ContentHash }
  | { readonly op: "restore"; readonly hash: ContentHash }
  | { readonly op: "tag_add"; readonly hash: ContentHash; readonly tags: readonly string[] }
  | { readonly op: "tag_remove"; readonly hash: ContentHash; readonly tags: readonly string[] }
  | {
      readonly op: "folder_create";
      readonly id: number;
      readonly parent: number | null;
      readonly name: string;
    }
  | { readonly op: "folder_add"; readonly hash: ContentHash; readonly folder: number }
  | { readonly op: "folder_remove"; readonly hash: ContentHash; readonly folder: number }
  | { readonly op: "folder_rename"; readonly id: number; readonly name: string }
  | { readonly op: "folder_move"; readonly id: number; readonly parent: number | null }
  | { readonly op: "folder_delete"; readonly id: number }
  | { readonly op: "asset_rename"; readonly hash: ContentHash; readonly name: string }
  | { readonly op: "tag_rename"; readonly from: string; readonly to: string }
  | { readonly op: "rate"; readonly hash: ContentHash; readonly rating: number | null }
  | { readonly op: "note_set"; readonly hash: ContentHash; readonly note: string | null }
  | { readonly op: "favorite_set"; readonly hash: ContentHash; readonly favorite: boolean }
  | {
      readonly op: "smart_folder_create";
      readonly id: number;
      readonly parent: number | null;
      readonly name: string;
      readonly query: string;
    }
  | {
      readonly op: "smart_folder_update";
      readonly id: number;
      readonly name: string;
      readonly query: string;
    }
  | { readonly op: "smart_folder_delete"; readonly id: number }
  | { readonly op: "tag_group_create"; readonly id: number; readonly name: string }
  | { readonly op: "tag_group_rename"; readonly id: number; readonly name: string }
  | { readonly op: "tag_group_delete"; readonly id: number }
  | { readonly op: "tag_group_set"; readonly tag: string; readonly group: number | null };

/** One journal line: a timestamp in unix seconds, and an operation. */
export type JournalRecord = { readonly ts: number } & Op;

/** A line that is not a record this build can use. */
export class MalformedRecordError extends RoostError {
  readonly code = "malformed_record";

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`, { field, reason });
  }
}

// --- Field readers -----------------------------------------------------------
//
// Hand-written rather than driven by a schema library. Replay runs this a
// million times per rebuild, and in the Rust implementation's measurements the
// schema cost showed up as the second-largest replay stage (`CLAUDE.md` §6).

type Raw = Record<string, unknown>;

function req(source: Raw, field: string): unknown {
  const value = source[field];
  if (value === undefined) throw new MalformedRecordError(field, "missing");
  return value;
}

function str(source: Raw, field: string): string {
  const value = req(source, field);
  if (typeof value !== "string") throw new MalformedRecordError(field, "expected a string");
  return value;
}

function int(source: Raw, field: string): number {
  const value = req(source, field);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    // A float, a NaN, or an integer beyond 2^53 all land here. The last one
    // matters: it is the point at which a JSON number stops round-tripping.
    throw new MalformedRecordError(field, "expected a safe integer");
  }
  return value;
}

/** Present and an integer, or explicitly `null`. An absent field is malformed. */
function nullableInt(source: Raw, field: string): number | null {
  return req(source, field) === null ? null : int(source, field);
}

function nullableStr(source: Raw, field: string): string | null {
  return req(source, field) === null ? null : str(source, field);
}

/** Absent or `null` both read as absent; anything else must be the right type. */
function optInt(source: Raw, field: string): number | undefined {
  const value = source[field];
  return value === undefined || value === null ? undefined : int(source, field);
}

function optStr(source: Raw, field: string): string | undefined {
  const value = source[field];
  return value === undefined || value === null ? undefined : str(source, field);
}

function bool(source: Raw, field: string): boolean {
  const value = req(source, field);
  if (typeof value !== "boolean") throw new MalformedRecordError(field, "expected a boolean");
  return value;
}

function hash(source: Raw, field: string): ContentHash {
  const value = str(source, field);
  if (!isContentHash(value)) {
    throw new MalformedRecordError(field, "expected 64 lowercase hex characters");
  }
  return value;
}

function strArray(source: Raw, field: string): string[] {
  const value = req(source, field);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new MalformedRecordError(field, "expected an array of strings");
  }
  return value as string[];
}

function parseAdd(source: Raw): AddRecord {
  const mode = str(source, "mode");
  if (!isStorageMode(mode)) throw new MalformedRecordError("mode", "not a storage mode");

  const link = optStr(source, "link");
  if (link !== undefined && !isLinkMethod(link)) {
    throw new MalformedRecordError("link", "not a link method");
  }

  // Built field by field, never by spreading: an object carrying `undefined`
  // serialises differently from one missing the key, and `JSON.stringify`
  // silently drops the difference (`DATA_MODEL.md` §4).
  const add: Record<string, unknown> = {
    hash: hash(source, "hash"),
    ext: str(source, "ext"),
    size: int(source, "size"),
    name: str(source, "name"),
    mode,
  };
  if (link !== undefined) add["link"] = link;
  const w = optInt(source, "w");
  if (w !== undefined) add["w"] = w;
  const h = optInt(source, "h");
  if (h !== undefined) add["h"] = h;
  const created = optInt(source, "created");
  if (created !== undefined) add["created"] = created;
  const ref = optStr(source, "ref");
  if (ref !== undefined) add["ref"] = ref;
  // Written only when true, so `false` and absent are the same record.
  if (source["partial"] === true) add["partial"] = true;

  return add as unknown as AddRecord;
}

/**
 * Validates one already-parsed JSON object into a record.
 *
 * Throws `MalformedRecordError` on a known `op` whose fields do not fit — that
 * is corruption, not a version gap, because this build defines those fields.
 * An *unknown* `op` is not this function's problem: replay checks the name
 * first and counts it as coming from a newer build.
 */
export function toRecord(source: Raw): JournalRecord {
  const ts = int(source, "ts");
  const op = str(source, "op");

  switch (op) {
    case "add":
      return { ts, op, ...parseAdd(source) };
    case "remove":
    case "trash":
    case "restore":
      return { ts, op, hash: hash(source, "hash") };
    case "tag_add":
    case "tag_remove":
      return { ts, op, hash: hash(source, "hash"), tags: strArray(source, "tags") };
    case "folder_create":
      return {
        ts,
        op,
        id: int(source, "id"),
        parent: nullableInt(source, "parent"),
        name: str(source, "name"),
      };
    case "folder_add":
    case "folder_remove":
      return { ts, op, hash: hash(source, "hash"), folder: int(source, "folder") };
    case "folder_rename":
      return { ts, op, id: int(source, "id"), name: str(source, "name") };
    case "folder_move":
      return { ts, op, id: int(source, "id"), parent: nullableInt(source, "parent") };
    case "folder_delete":
    case "smart_folder_delete":
    case "tag_group_delete":
      return { ts, op, id: int(source, "id") };
    case "asset_rename":
      return { ts, op, hash: hash(source, "hash"), name: str(source, "name") };
    case "tag_rename":
      return { ts, op, from: str(source, "from"), to: str(source, "to") };
    case "rate": {
      const rating = nullableInt(source, "rating");
      if (rating !== null && (rating < 0 || rating > 255)) {
        throw new MalformedRecordError("rating", "out of range");
      }
      return { ts, op, hash: hash(source, "hash"), rating };
    }
    case "note_set":
      return { ts, op, hash: hash(source, "hash"), note: nullableStr(source, "note") };
    case "favorite_set":
      return { ts, op, hash: hash(source, "hash"), favorite: bool(source, "favorite") };
    case "smart_folder_create":
      return {
        ts,
        op,
        id: int(source, "id"),
        parent: nullableInt(source, "parent"),
        name: str(source, "name"),
        query: str(source, "query"),
      };
    case "smart_folder_update":
      return {
        ts,
        op,
        id: int(source, "id"),
        name: str(source, "name"),
        query: str(source, "query"),
      };
    case "tag_group_create":
    case "tag_group_rename":
      return { ts, op, id: int(source, "id"), name: str(source, "name") };
    case "tag_group_set":
      return { ts, op, tag: str(source, "tag"), group: nullableInt(source, "group") };
    default:
      throw new MalformedRecordError("op", `unhandled operation "${op}"`);
  }
}

/**
 * One record as a journal line, newline included.
 *
 * `ts` is written first and `op` second, matching what the Rust implementation
 * emits. JSON object order carries no meaning, but a journal is a text file
 * people read and diff, and there is no reason for the two to disagree.
 */
export function toLine(record: JournalRecord): string {
  const { ts, op, ...rest } = record;
  return `${JSON.stringify({ ts, op, ...rest })}\n`;
}
