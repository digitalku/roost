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
  "comment_add",
  "comment_remove",
  "comment_set",
  "favorite_set",
  "folder_add",
  "folder_create",
  "folder_delete",
  "folder_move",
  "folder_remove",
  "folder_rename",
  "note_set",
  "poster_set",
  "rate",
  "remove",
  "restore",
  "smart_folder_create",
  "smart_folder_delete",
  "smart_folder_update",
  "source_set",
  "subtitle_attach",
  "subtitle_detach",
  "supersede",
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
 * Which implementation an operation belongs to, read from its name (RL-29).
 *
 * A core operation carries no prefix; one belonging to a platform carries it
 * before a dot — `mac.quicklook_tag`, `win.shell_pin`. That single character is
 * the whole of what lets a message say *"this is available in Roost for Mac"*
 * without a registry of everybody's features, which is why the format made it a
 * requirement rather than a convention.
 *
 * The two unknowns it separates carry very different weight. An unprefixed name
 * this build does not know is a **core operation from a later revision of the
 * format**, and other core operations may depend on it. A prefixed one is
 * another operating system's, and is safe to ignore forever — except when the
 * prefix is this platform's own, which means a newer build of the same Roost.
 */
export function platformOf(op: string): string | undefined {
  const dot = op.indexOf(".");
  return dot === -1 ? undefined : op.slice(0, dot);
}

/**
 * The name a person would recognise for a platform prefix.
 *
 * An unknown prefix is handed back as it was written rather than guessed at: a
 * prefix nobody here has seen is exactly the case where inventing a product
 * name would be wrong, and the raw string is still something to search for.
 */
export function platformName(prefix: string): string {
  switch (prefix) {
    case "win":
      return "Roost for Windows";
    case "mac":
      return "Roost for Mac";
    case "linux":
      return "Roost for Linux";
    default:
      return prefix;
  }
}

/**
 * The optional fields of an `add`.
 *
 * **The distinction between `?:` and `| null` here is the file format**, not a
 * style choice. A field declared `?:` is *omitted* when absent, because
 * `JSON.stringify` drops `undefined`; a field declared `| null` is always
 * written, because an absent field and an explicit `null` mean different things
 * to the operations that carry one (RL-37, and the registry's notes).
 *
 * Three of these exist only here: `created`, `ref`, and `partial` cannot be
 * recovered from `originals/`, so a rebuild without them loses data.
 */
export interface AddRecord {
  readonly hash: ContentHash;
  readonly ext: string;
  readonly size: number;
  /** The user's original filename. On disk the name is the hash (RL-8). NFC (RL-36). */
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
  /**
   * Where the file came from (ADR-0030).
   *
   * `note_set`'s shape on purpose: last write wins, clearing is the same op
   * with `null`, and there is no `source_clear` to keep in step with it.
   *
   * Stored as typed, trimmed. Roost neither parses nor normalises it and does
   * not require a scheme — `file:///archive/2019/` and a bare
   * `instagram.com/p/xyz` are both answers to the question that was asked. The
   * scheme decides only whether a window offers to open it, which is the
   * window's business rather than the journal's.
   */
  | { readonly op: "source_set"; readonly hash: ContentHash; readonly url: string | null }
  /**
   * Comments, which carry a moment (ADR-0023).
   *
   * `at` is **milliseconds** into the medium, or `null` for a comment about the
   * asset rather than about a moment in it. It is the one number in the format
   * that is not seconds: this is an offset, not a date, and a second of
   * granularity on a 24fps cut is twenty-four frames of ambiguity. Named `at`
   * rather than `ts` so it cannot be misread as the line's own timestamp, which
   * is what `created_at` is replayed from.
   *
   * `comment_set` follows `note_set` — last write wins, and editing keeps the
   * comment's identity. Removing and re-adding would move it in every list
   * ordered by creation and lose anything that referred to its id.
   */
  | {
      readonly op: "comment_add";
      readonly id: number;
      readonly hash: ContentHash;
      readonly at: number | null;
      readonly body: string;
    }
  | {
      readonly op: "comment_set";
      readonly id: number;
      readonly at: number | null;
      readonly body: string;
    }
  | { readonly op: "comment_remove"; readonly id: number }
  /**
   * Which frame a video's thumbnail is taken from (ADR-0024 stage 4).
   *
   * `at` is **milliseconds**, like a comment's, and `null` restores the
   * default — a frame a tenth of the way in. Clearing is this op with the value
   * absent rather than an op of its own, because "use the default again" and
   * "use this moment" are the same decision.
   *
   * The line records **where to look, never the pixels**: a rebuild replays it
   * and the derive pass re-extracts the frame, which is what keeps the index
   * rebuildable from `originals/` plus the journal (invariant 1).
   */
  | { readonly op: "poster_set"; readonly hash: ContentHash; readonly at: number | null }
  | { readonly op: "favorite_set"; readonly hash: ContentHash; readonly favorite: boolean }
  /**
   * Which asset replaced which (ADR-0026).
   *
   * Identity is the content hash, so an edit cannot be a write: the new bytes
   * arrive as their own `add`, and this line is what says the old asset is no
   * longer the current one. `to` is the replacement, and `null` clears the
   * mark — "this is current again" and "that one replaced it" are the same
   * decision with the value absent, exactly as `poster_set` treats `at`.
   *
   * **The chain is history and nothing prunes it.** Removing an old version is
   * `remove` on that hash, a second and deliberate gesture. Everything
   * user-authored travels to the replacement through the op that owns it —
   * `tag_add`, `folder_add`, `rate`, and the rest — so a rebuild reconstructs
   * the carry-over from the journal rather than from a rule in the code that
   * replayed it.
   */
  | { readonly op: "supersede"; readonly hash: ContentHash; readonly to: ContentHash | null }
  /**
   * Which asset captions which (ADR-0025).
   *
   * `hash` is the video or audio; `track` is the subtitle, an ordinary
   * content-addressed asset. The attachment is a judgement a person made about
   * two files — nothing in either file's bytes implies it — so it is
   * user-authored and invariant 9 applies. A `.srt` found beside a video at
   * import proposes the line; the line is what makes it true, which is why
   * moving either file afterwards changes nothing.
   *
   * `lang` is BCP-47 where a filename or a stream declared one, and absent
   * rather than guessed where nothing did. `label` is absent until somebody
   * types one.
   *
   * `subtitle_detach` un-says the sentence and deletes nothing: both assets
   * stay, and the track becomes an ordinary text file again.
   */
  | {
      readonly op: "subtitle_attach";
      readonly hash: ContentHash;
      readonly track: ContentHash;
      readonly lang?: string;
      readonly label?: string;
    }
  | { readonly op: "subtitle_detach"; readonly hash: ContentHash; readonly track: ContentHash }
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

/**
 * A well-formed record naming something that is not there (RL-26a).
 *
 * Not corruption, and the distinction is the whole reason this error exists
 * rather than a second `MalformedRecordError`. A membership in a folder nobody
 * created happens for two ordinary reasons — the creating operation belonged to
 * an extension this build skipped, or another implementation deleted the folder
 * afterwards — so it is counted and logged and no more. Reporting it as damage
 * would tell somebody their library had lost data every time they opened it in
 * two builds.
 *
 * What must **not** happen is the obliging repair: RL-26a forbids creating the
 * missing entity to accept the record, because that puts a folder nobody made
 * in the sidebar and a rebuild invents a different one each time.
 */
export class DanglingReferenceError extends RoostError {
  readonly code = "dangling_reference";

  constructor(op: string, what: string, id: string | number) {
    super(`${op} names ${what} ${id}, which does not exist`, { op, what, id });
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
    case "comment_remove":
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
    case "source_set":
      return { ts, op, hash: hash(source, "hash"), url: nullableStr(source, "url") };
    case "comment_add":
      return {
        ts,
        op,
        id: int(source, "id"),
        hash: hash(source, "hash"),
        at: moment(source),
        body: str(source, "body"),
      };
    case "comment_set":
      return { ts, op, id: int(source, "id"), at: moment(source), body: str(source, "body") };
    case "poster_set":
      return { ts, op, hash: hash(source, "hash"), at: moment(source) };
    case "favorite_set":
      return { ts, op, hash: hash(source, "hash"), favorite: bool(source, "favorite") };
    case "subtitle_attach": {
      // Built field by field, never by spreading: an object carrying
      // `undefined` serialises differently from one missing the key, and
      // `JSON.stringify` silently drops the difference (`DATA_MODEL.md` §4).
      const record: Record<string, unknown> = {
        ts,
        op,
        hash: hash(source, "hash"),
        track: hash(source, "track"),
      };
      const lang = optStr(source, "lang");
      if (lang !== undefined) record["lang"] = lang;
      const label = optStr(source, "label");
      if (label !== undefined) record["label"] = label;
      return record as unknown as JournalRecord;
    }
    case "subtitle_detach":
      return { ts, op, hash: hash(source, "hash"), track: hash(source, "track") };
    case "supersede":
      return {
        ts,
        op,
        hash: hash(source, "hash"),
        // Present and either a hash or explicitly `null`. An absent `to` is
        // malformed rather than a clear: the two spellings would otherwise be
        // the same line, and one of them is a bug in whatever wrote it.
        to: req(source, "to") === null ? null : hash(source, "to"),
      };
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
 * An `at`, in milliseconds, or `null`.
 *
 * A comment's moment, or a poster's. `null` means different things to the two —
 * a comment about the whole asset, a thumbnail at the default frame — and both
 * are the absence of a moment.
 *
 * Rejected rather than clamped when negative: a negative offset is a writer
 * that computed a position wrongly, and replaying it as zero would put the
 * comment somewhere the person never placed it.
 */
function moment(source: Raw): number | null {
  const at = nullableInt(source, "at");
  if (at !== null && at < 0) throw new MalformedRecordError("at", "negative");
  return at;
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
