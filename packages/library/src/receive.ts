import type { AssetId } from "@roost/core";
import { ReceiveFailedError } from "./error.js";
import { importInto } from "./import.js";
import type { Library } from "./library.js";

/** What one received file became: a new asset, or the one that held its bytes. */
export interface Received {
  readonly id: AssetId | null;
  readonly duplicateOf: AssetId | null;
}

/**
 * Imports one file a phone sent (ADR-0073 §3.5), from where it was staged.
 *
 * The ordinary importer, for one path, moved rather than copied: the staged
 * file is the caller's own, inside the library's `staging/`, so the move is a
 * rename and the bytes are written once. Hidden names are taken, because the
 * person chose this file; a walk skips them only because nobody chose those.
 *
 * A duplicate is skipped, as at every import (ADR-0046 §5), and answered with
 * the asset that already held the bytes, so the phone can offer to file it.
 *
 * @throws {UnknownFolderError} when `folder` no longer exists.
 * @throws {ReceiveFailedError} when the file could not be imported.
 */
export async function receiveFile(
  library: Library,
  path: string,
  folder: number | null,
): Promise<Received> {
  const report = await importInto(library, [path], {
    take: "move",
    includeHidden: true,
    ...(folder === null ? {} : { folder }),
  });
  const failure = report.failed[0];
  if (failure !== undefined) throw new ReceiveFailedError(failure.reason);
  const id = report.importedIds[0];
  if (id !== undefined) return { id, duplicateOf: null };
  const duplicateOf = report.duplicateIds[0];
  if (duplicateOf !== undefined) return { id: null, duplicateOf };
  throw new ReceiveFailedError("nothing was imported");
}
