import { logDir } from "@roost/core";
import { Library, queueStatus } from "@roost/library";
import { bytes, row } from "../format.js";

export async function stats(root: string, out: (line: string) => void): Promise<void> {
  const library = await Library.open(root);
  try {
    const counts = library.stats();
    out(library.name);
    out(row("path", library.root));
    out(row("assets", counts.assets));
    // Only when there are any: an asset nothing has read is an ordinary state
    // in version 2 (RL-22) and a library that has caught up should not carry a
    // line saying zero.
    if (counts.underived > 0) out(row("unread", counts.underived, 2));
    out(row("total size", bytes(counts.totalBytes)));
    out(row("tags", counts.tags));
    if (counts.tagGroups > 0) out(row("tag groups", counts.tagGroups));
    out(row("folders", counts.folders));
    if (counts.smartFolders > 0) out(row("smart", counts.smartFolders));
    if (counts.watchedRoots > 0) out(row("watched", counts.watchedRoots));
    out(row("rated", counts.rated));
    // Retired, so the line appears only where history left one (ADR-0029).
    if (counts.favorites > 0) out(row("favourites", counts.favorites));
    out(row("notes", counts.notes));
    out(row("comments", counts.comments));
    // Only when there is one. An empty trash is the normal state and does not
    // need a line saying so — the same rule the queue below follows.
    if (counts.trashed > 0) out(row("trashed", counts.trashed));
    out(row("thumbnails", counts.thumbnails));

    // What is still owed, and only when something is: a library whose queue is
    // empty should not carry three lines saying so.
    const queue = queueStatus(library);
    if (queue.ready + queue.running + queue.blocked + queue.failed > 0) {
      out(row("derive queue", queue.ready + queue.running));
      if (queue.blocked > 0) out(row("parked", queue.blocked, 2));
      if (queue.failed > 0) out(row("failed", queue.failed, 2));
    }
    out(row("schema", library.db.schemaVersion()));
    out(row("logs", logDir()));
  } finally {
    await library.close();
  }
}
