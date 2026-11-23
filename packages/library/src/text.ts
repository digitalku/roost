import { open, stat } from "node:fs/promises";
import type { AssetId } from "@roost/core";
import { decodeText, encodeText, isWritableEncoding, type TextEncoding } from "@roost/media";
import { MAX_EDIT_BYTES, saveEdit } from "./edit.js";
import { ChangedOnDiskError, NotEditableError, UnknownAssetError } from "./error.js";
import type { Library } from "./library.js";
import { resolveFile } from "./locate.js";

/**
 * Reading a text asset for the window's own view, and saving what was edited
 * there over the file (ADR-0070 §3.4).
 *
 * The text crosses to the window as a string of at most {@link MAX_EDIT_BYTES},
 * decoded here. That is the one place a file's contents travel through IPC, and
 * the bound is why invariant 12 is read as permitting it.
 */

/** What a text asset says, and whether it may be written back. */
export type TextRead =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly encoding: TextEncoding;
      readonly crlf: boolean;
      /** Only the first {@link MAX_EDIT_BYTES} were read. */
      readonly truncated: boolean;
      /** UTF-8 and read whole: a save would change only what was edited. */
      readonly editable: boolean;
      /** What the file was when it was read, which a save checks first. */
      readonly size: number;
      readonly mtimeMs: number;
    }
  /** The bytes are not text after all: a NUL in them, and no UTF-16 mark. */
  | { readonly kind: "binary" }
  /** RL-25: the row is here and the file is not. */
  | { readonly kind: "missing" };

/** The file as it is after a save, which the next save checks against. */
export interface TextSaved {
  readonly size: number;
  readonly mtimeMs: number;
}

/** Reads a text asset, at most {@link MAX_EDIT_BYTES} of it. */
export async function readText(library: Library, id: AssetId): Promise<TextRead> {
  if (library.db.repo.assetDetail(id) === undefined) throw new UnknownAssetError(id);
  const resolved = await resolveFile(library, id);
  if (resolved.kind !== "found") return { kind: "missing" };

  // Opened, read and closed at once: nothing here may hold the file open in a
  // way that stops its own application saving it (RL-21).
  const handle = await open(resolved.path, "r");
  let bytes: Uint8Array;
  let size: number;
  let mtimeMs: number;
  try {
    const facts = await handle.stat();
    size = facts.size;
    mtimeMs = facts.mtimeMs;
    const wanted = Math.min(size, MAX_EDIT_BYTES);
    const buffer = new Uint8Array(wanted);
    const { bytesRead } = await handle.read(buffer, 0, wanted, 0);
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  const truncated = size > bytes.length;
  const decoded = decodeText(bytes, !truncated);
  if (decoded === undefined) return { kind: "binary" };
  return {
    kind: "text",
    text: decoded.text,
    encoding: decoded.encoding,
    crlf: decoded.crlf,
    truncated,
    editable: !truncated && isWritableEncoding(decoded.encoding),
    size,
    mtimeMs,
  };
}

/** What {@link saveText} is told about the file it read and the text to write. */
export interface TextSave {
  readonly text: string;
  /** The `size` and `mtimeMs` {@link readText} answered with, or the last save. */
  readonly size: number;
  readonly mtimeMs: number;
  /** Put back what the file was read with. */
  readonly bom: boolean;
  readonly crlf: boolean;
  /** Save although the file changed on disk: the window's *Save anyway*. */
  readonly force?: boolean;
}

/**
 * Writes edited text over the file, as UTF-8 (ADR-0070 §3.4), through
 * {@link saveEdit}: nothing is journalled, what was derived is forgotten, and
 * the derive is queued.
 *
 * Refused with {@link ChangedOnDiskError} when the file is no longer what was
 * read — another application saved it meanwhile, and writing now would undo
 * that save without anybody seeing it.
 */
export async function saveText(library: Library, id: AssetId, save: TextSave): Promise<TextSaved> {
  const detail = library.db.repo.assetDetail(id);
  if (detail === undefined) throw new UnknownAssetError(id);
  const resolved = await resolveFile(library, id);
  if (resolved.kind !== "found") throw new NotEditableError(id, "its file is missing");

  if (save.force !== true) {
    const now = await stat(resolved.path);
    if (now.size !== save.size || now.mtimeMs !== save.mtimeMs) throw new ChangedOnDiskError(id);
  }

  await saveEdit(library, id, encodeText(save.text, { bom: save.bom, crlf: save.crlf }));

  // `saveEdit` writes under the extension the index holds.
  const after = await stat(library.storage.locate(id, detail.ext));
  return { size: after.size, mtimeMs: after.mtimeMs };
}
