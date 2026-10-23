import { type AssetId, isAssetId, isTake, RoostError, type Take } from "../model/index.js";

/**
 * Every `op` string this build understands, sorted.
 *
 * One list, used by replay to tell "written by a newer Roost" from "corrupt".
 * In the Rust implementation this was two lists once, and they drifted the
 * first time an operation was added.
 *
 * Thirty-three, which is `ops/REGISTRY.md` for revision 2.0 exactly. Version
 * 1's `supersede` is not among them: an edit no longer produces a new asset, so
 * there is nothing for it to say.
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
  "tag_add",
  "tag_delete",
  "tag_group_create",
  "tag_group_delete",
  "tag_group_rename",
  "tag_group_set",
  "tag_remove",
  "tag_rename",
  "trash",
  "watch_add",
  "watch_remove",
] as const;

export type OpName = (typeof OP_NAMES)[number];

export function isOpName(value: string): value is OpName {
  return (OP_NAMES as readonly string[]).includes(value);
}

/**
 * Which implementation an operation belongs to, read from its name (RL-41).
 *
 * A core operation carries no prefix; one belonging to a platform carries it
 * before a dot — `mac.quicklook_tag`, `win.shell_pin`. That single character is
 * the whole of what lets a message say *"this is available in Roost for
 * Windows"* without a registry of everybody's features, which is why the format
 * made it a requirement rather than a convention.
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
 * An `add`, and what version 2 took out of it.
 *
 * Version 1's `add` also carried `size`, `w`, `h`, `mode`, `link` and
 * `partial`. Every one of them describes the bytes, and the bytes now change
 * whenever somebody saves the file — so they are derived (RL-22) and never
 * journalled (RL-23).
 *
 * **The distinction between `?:` and `| null` here is the file format**, not a
 * style choice. A field declared `?:` is *omitted* when absent, because
 * `JSON.stringify` drops `undefined`; a field declared `| null` is always
 * written, because an absent field and an explicit `null` mean different things
 * to the operations that carry one (RL-50, and the registry's notes).
 */
export interface AddRecord {
  readonly id: AssetId;
  /** Without a dot, lowercase. **Empty when the file has none** — RL-9, RL-9a. */
  readonly ext: string;
  /** What a person reads, **without the extension** (RL-33). NFC (RL-49). */
  readonly name: string;
  /**
   * The source file's own date at import, unix seconds.
   *
   * The one fact about a file that survives RL-22, because nothing can recover
   * it afterwards: the stored file's date becomes the date of the last edit the
   * moment anybody saves it. An asset with no `created` is dated from this
   * record's own `ts`.
   */
  readonly created?: number;
}

/**
 * Every operation this build understands.
 *
 * Adding an operation is always safe: older builds skip `op` values they do not
 * recognise. **Repurposing one is not** — an older build would apply it under
 * its old meaning. Add a new `op` instead.
 *
 * `id` is the entity a record **creates**; `asset` is an asset it **refers
 * to**. Naming them apart is what lets one record carry a comment's id and the
 * id of the asset it is about.
 */
export type Op =
  | ({ readonly op: "add" } & AddRecord)
  | { readonly op: "remove"; readonly asset: AssetId }
  /**
   * Trash and restore (ADR-0022).
   *
   * Neither carries a timestamp of its own: the journal line already has `ts`,
   * and replay writes `assets.trashed_at` from it. Two `trash` ops for one
   * asset are idempotent — the later one wins, which is what somebody who
   * trashed, restored, and trashed again would expect Trash to show.
   *
   * `trash` is reversible and `remove` is not. That is the whole distinction:
   * `remove` is what "Empty trash" and "Delete permanently" send, and it is the
   * only operation that discards a person's work.
   */
  | { readonly op: "trash"; readonly asset: AssetId }
  | { readonly op: "restore"; readonly asset: AssetId }
  | { readonly op: "tag_add"; readonly asset: AssetId; readonly tags: readonly string[] }
  | { readonly op: "tag_remove"; readonly asset: AssetId; readonly tags: readonly string[] }
  | {
      readonly op: "folder_create";
      readonly id: number;
      readonly parent: number | null;
      readonly name: string;
    }
  | { readonly op: "folder_add"; readonly asset: AssetId; readonly folder: number }
  | { readonly op: "folder_remove"; readonly asset: AssetId; readonly folder: number }
  | { readonly op: "folder_rename"; readonly id: number; readonly name: string }
  | { readonly op: "folder_move"; readonly id: number; readonly parent: number | null }
  | { readonly op: "folder_delete"; readonly id: number }
  /**
   * A rename, which **never touches the disk** (RL-9, RL-33).
   *
   * The file is named by the id, so this cannot fail on a locked file, an
   * invalid character, a reserved name or a path that grew too long, and it
   * costs the same for one asset as for five hundred. The name excludes the
   * extension, which is what makes RL-9b free: a name carrying `.docx` would
   * have to be rewritten every time an application saved the file as something
   * else, and that is a journal record written because the bytes changed —
   * exactly what RL-23 forbids.
   */
  | { readonly op: "asset_rename"; readonly asset: AssetId; readonly name: string }
  | { readonly op: "tag_rename"; readonly from: string; readonly to: string }
  /**
   * A tag taken out of the library: off every asset that carries it, and out
   * of the vocabulary (ADR-0061). Named, as every tag operation is. Deleting a
   * tag nobody has is an ordinary no-op.
   */
  | { readonly op: "tag_delete"; readonly tag: string }
  | { readonly op: "rate"; readonly asset: AssetId; readonly rating: number | null }
  | { readonly op: "note_set"; readonly asset: AssetId; readonly note: string | null }
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
  | { readonly op: "source_set"; readonly asset: AssetId; readonly url: string | null }
  /**
   * Comments, which carry a moment (ADR-0023).
   *
   * `at` is **milliseconds** into the medium, or `null` for a comment about the
   * asset rather than about a moment in it. It is the one number in the format
   * that is not seconds (RL-32a): this is an offset, not a date, and a second
   * of granularity on a 24fps cut is twenty-four frames of ambiguity.
   *
   * **A comment survives the file being edited**, which version 2 has to be
   * honest about: the asset is the same asset after a save, so a comment at
   * 1:31.5 stays at 1:31.5 even if the cut it described has moved. That is the
   * price of an identity that does not change with the bytes.
   */
  | {
      readonly op: "comment_add";
      readonly id: number;
      readonly asset: AssetId;
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
   * default — a frame a tenth of the way in. It records **where to look, never
   * the pixels**: a rebuild replays it and the derive pass extracts the frame
   * again, which is what keeps the index rebuildable from `files/` plus the
   * journal (RL-24).
   */
  | { readonly op: "poster_set"; readonly asset: AssetId; readonly at: number | null }
  | { readonly op: "favorite_set"; readonly asset: AssetId; readonly favorite: boolean }
  /**
   * Which asset captions which (ADR-0025).
   *
   * `asset` is the video or audio; `track` is the subtitle, an ordinary asset
   * with an id of its own. The attachment is a judgement a person made about
   * two files — nothing in either file's bytes implies it — so it is
   * user-authored and invariant 9 applies. A `.srt` found beside a video at
   * import proposes the line; the line is what makes it true.
   *
   * `lang` is BCP-47 where a filename or a stream declared one, and absent
   * rather than guessed where nothing did. `label` is absent until somebody
   * types one.
   */
  | {
      readonly op: "subtitle_attach";
      readonly asset: AssetId;
      readonly track: AssetId;
      readonly lang?: string;
      readonly label?: string;
    }
  | { readonly op: "subtitle_detach"; readonly asset: AssetId; readonly track: AssetId }
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
  | { readonly op: "tag_group_set"; readonly tag: string; readonly group: number | null }
  /**
   * A directory the library keeps an eye on.
   *
   * Configuration somebody typed, which is why it is in the journal rather than
   * in `settings.json`: RL-2 puts that file outside the format, so a watched
   * root stored there would make *"is this folder watched?"* a question whose
   * answer depends on which implementation is asked.
   *
   * `take` is what happens to a file found there — `move` or `copy` — decided
   * once, when the root is registered, because nobody is at the screen when a
   * watched folder catches something. **The path is not a key; the id is**: two
   * `watch_add` records naming one directory are two roots, and replay keeps
   * both.
   */
  | {
      readonly op: "watch_add";
      readonly id: number;
      readonly path: string;
      readonly take: Take;
    }
  | { readonly op: "watch_remove"; readonly id: number };

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
 * A well-formed record naming something that is not there (RL-38).
 *
 * Not corruption, and the distinction is the whole reason this error exists
 * rather than a second `MalformedRecordError`. A membership in a folder nobody
 * created happens for two ordinary reasons — the creating operation belonged to
 * an extension this build skipped, or another implementation deleted the folder
 * afterwards — so it is counted and logged and no more. Reporting it as damage
 * would tell somebody their library had lost data every time they opened it in
 * two builds.
 *
 * What must **not** happen is the obliging repair: RL-38 forbids creating the
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

function assetId(source: Raw, field: string): AssetId {
  const value = str(source, field);
  if (!isAssetId(value)) {
    throw new MalformedRecordError(field, "expected 12 characters of Crockford base32");
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
  // Built field by field, never by spreading: an object carrying `undefined`
  // serialises differently from one missing the key, and `JSON.stringify`
  // silently drops the difference (`DATA_MODEL.md` §4).
  const add: Record<string, unknown> = {
    id: assetId(source, "id"),
    // An extension is required and may be empty — `""` is a file with none
    // (RL-9a), which is a different fact from "the writer forgot to say".
    ext: str(source, "ext"),
    name: str(source, "name"),
  };
  const created = optInt(source, "created");
  if (created !== undefined) add["created"] = created;

  return add as unknown as AddRecord;
}

/**
 * Validates one already-parsed JSON object into a record.
 *
 * Throws `MalformedRecordError` on a known `op` whose fields do not fit — that
 * is corruption, not a version gap, because this build defines those fields.
 * An *unknown* `op` is not this function's problem: replay checks the name
 * first and counts it as coming from a newer build.
 *
 * Unknown **fields** on a known operation are ignored and never rewritten away
 * (RL-44), which falls out of reading field by field rather than validating the
 * whole object.
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
      return { ts, op, asset: assetId(source, "asset") };
    case "tag_add":
    case "tag_remove":
      return { ts, op, asset: assetId(source, "asset"), tags: strArray(source, "tags") };
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
      return { ts, op, asset: assetId(source, "asset"), folder: int(source, "folder") };
    case "folder_rename":
      return { ts, op, id: int(source, "id"), name: str(source, "name") };
    case "folder_move":
      return { ts, op, id: int(source, "id"), parent: nullableInt(source, "parent") };
    case "folder_delete":
    case "smart_folder_delete":
    case "tag_group_delete":
    case "comment_remove":
    case "watch_remove":
      return { ts, op, id: int(source, "id") };
    case "asset_rename":
      return { ts, op, asset: assetId(source, "asset"), name: str(source, "name") };
    case "tag_rename":
      return { ts, op, from: str(source, "from"), to: str(source, "to") };
    case "tag_delete":
      return { ts, op, tag: str(source, "tag") };
    case "rate": {
      const rating = nullableInt(source, "rating");
      if (rating !== null && (rating < 0 || rating > 255)) {
        throw new MalformedRecordError("rating", "out of range");
      }
      return { ts, op, asset: assetId(source, "asset"), rating };
    }
    case "note_set":
      return { ts, op, asset: assetId(source, "asset"), note: nullableStr(source, "note") };
    case "source_set":
      return { ts, op, asset: assetId(source, "asset"), url: nullableStr(source, "url") };
    case "comment_add":
      return {
        ts,
        op,
        id: int(source, "id"),
        asset: assetId(source, "asset"),
        at: moment(source),
        body: str(source, "body"),
      };
    case "comment_set":
      return { ts, op, id: int(source, "id"), at: moment(source), body: str(source, "body") };
    case "poster_set":
      return { ts, op, asset: assetId(source, "asset"), at: moment(source) };
    case "favorite_set":
      return { ts, op, asset: assetId(source, "asset"), favorite: bool(source, "favorite") };
    case "subtitle_attach": {
      // Built field by field, never by spreading, for the reason `parseAdd`
      // gives: `undefined` and a missing key are the same object and two
      // different journal lines.
      const record: Record<string, unknown> = {
        ts,
        op,
        asset: assetId(source, "asset"),
        track: assetId(source, "track"),
      };
      const lang = optStr(source, "lang");
      if (lang !== undefined) record["lang"] = lang;
      const label = optStr(source, "label");
      if (label !== undefined) record["label"] = label;
      return record as unknown as JournalRecord;
    }
    case "subtitle_detach":
      return { ts, op, asset: assetId(source, "asset"), track: assetId(source, "track") };
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
    case "watch_add": {
      const take = str(source, "take");
      if (!isTake(take)) throw new MalformedRecordError("take", "expected move or copy");
      return { ts, op, id: int(source, "id"), path: str(source, "path"), take };
    }
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
 * `ts` is written first and `op` second. JSON object order carries no meaning,
 * but a journal is a text file people read and diff, and the registry publishes
 * its examples that way.
 */
export function toLine(record: JournalRecord): string {
  const { ts, op, ...rest } = record;
  return `${JSON.stringify({ ts, op, ...rest })}\n`;
}
