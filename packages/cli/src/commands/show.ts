import { resolveAsset } from "@roost/library";
import { row } from "../format.js";
import { withLibrary } from "../open.js";

/** Everything the library knows about one asset. */
export async function show(
  root: string,
  needle: string,
  out: (line: string) => void,
): Promise<void> {
  await withLibrary(root, async (library) => {
    const hash = resolveAsset(library, needle);
    const detail = library.db.repo.assetDetail(hash);
    // `resolveAsset` matched a row, and nothing between there and here can
    // delete one — a missing detail would be a bug, not a state to render.
    if (detail === undefined) throw new Error(`no detail for ${hash}`);

    out(detail.origName);
    out(row("hash", detail.hash));
    out(row("type", detail.ext === "" ? "—" : detail.ext));
    out(row("size", `${detail.size} bytes`));
    if (detail.width !== null && detail.height !== null) {
      out(row("dimensions", `${detail.width}x${detail.height}`));
    }
    out(row("storage", detail.storageMode));
    if (detail.refPath !== null) out(row("references", detail.refPath));
    if (detail.isPartialHash) out(row("hashing", "partial (large file)"));
    out(row("rating", detail.rating === null ? "—" : String(detail.rating)));
    // Only when there is one. Nothing sets a favourite any more (ADR-0029), so
    // a "no" on every asset forever is a word about a feature that is gone —
    // while a library that still holds one is owed the truth.
    if (detail.isFavorite) out(row("favourite", "yes"));
    if (detail.note !== null) out(row("note", detail.note));
    if (detail.tags.length > 0) out(row("tags", detail.tags.join(", ")));
    if (detail.folders.length > 0) out(row("folders", detail.folders.join(", ")));
  });
}
