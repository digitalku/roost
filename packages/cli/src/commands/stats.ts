import { logDir } from "@roost/core";
import { Library } from "@roost/library";
import { bytes, row } from "../format.js";

export async function stats(root: string, out: (line: string) => void): Promise<void> {
  const library = await Library.open(root);
  try {
    const counts = library.stats();
    out(library.manifest.name);
    out(row("path", library.root));
    out(row("assets", counts.assets));
    out(row("managed", counts.managed, 2));
    out(row("referenced", counts.referenced, 2));
    if (counts.partialHashes > 0) out(row("partial", counts.partialHashes, 2));
    out(row("total size", bytes(counts.totalBytes)));
    out(row("tags", counts.tags));
    if (counts.tagGroups > 0) out(row("tag groups", counts.tagGroups));
    out(row("folders", counts.folders));
    if (counts.smartFolders > 0) out(row("smart", counts.smartFolders));
    out(row("rated", counts.rated));
    out(row("favourites", counts.favorites));
    out(row("notes", counts.notes));
    out(row("thumbnails", counts.thumbnails));
    out(row("schema", library.db.schemaVersion()));
    out(row("logs", logDir()));
  } finally {
    await library.close();
  }
}
