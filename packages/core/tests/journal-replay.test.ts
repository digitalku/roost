import { fileURLToPath } from "node:url";
import { Db, IndexSink, type ReplayReport, replay, type Stats, withoutDerived } from "@roost/core";
import { describe, expect, it } from "vitest";

/**
 * The journal of the conformance library (RL-52), at the repository root.
 *
 * Fifty-two records across two months, written by hand, carrying the cases
 * nobody writes on purpose — an operation from a later revision, one from
 * another platform, a dangling membership, and a final line a crash cut short.
 */
const CONFORMANCE_JOURNAL = fileURLToPath(
  new URL("../../../conformance/library.roost/journal", import.meta.url),
);

async function fold(db: Db): Promise<ReplayReport> {
  return replay(CONFORMANCE_JOURNAL, new IndexSink(db));
}

describe("folding the conformance journal", () => {
  it("lands the state its operations describe", async () => {
    const db = Db.openInMemory();
    try {
      const report = await fold(db);

      // Six assets: seven were added and one — `draft` — was added, filed,
      // trashed and then removed, which leaves nothing behind.
      const stats: Stats = db.repo.stats();
      expect(stats.assets).toBe(6);
      expect(stats.trashed).toBe(1);
      expect(stats.folders).toBe(2);
      expect(stats.smartFolders).toBe(1);
      expect(stats.watchedRoots).toBe(1);
      expect(stats.comments).toBe(1);

      // Nothing about the bytes, because the journal says nothing about them
      // (RL-23): every asset is waiting for a derive that has not run.
      expect(stats.underived).toBe(6);
      expect(stats.totalBytes).toBe(0);

      // The dangling `folder_add` was skipped, counted, and **not** repaired:
      // creating folder 99 to accept the record is what RL-38 forbids.
      expect(report.dangling).toHaveLength(1);
      expect(db.repo.folder(99)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("names a folder that was deleted and never hands its id out again", async () => {
    const db = Db.openInMemory();
    try {
      await fold(db);
      // Three folders were created — 7, 8 and 9 — and 9 was deleted, so two
      // survive. `Icons` sorts before `References` because the pane lists by
      // name.
      expect(db.repo.folders().map((folder) => folder.id)).toEqual([8, 7]);

      // **10, not 9.** The table's maximum is 8 and the journal's is 9, and an
      // id is never handed out twice (RL-17): a second folder 9 would silently
      // adopt the memberships of the one another build may still be holding.
      expect(db.repo.nextFolderId()).toBe(10);
    } finally {
      db.close();
    }
  });
});

describe("rebuild equivalence", () => {
  it("produces the same index as the one it replaces, derived data aside", async () => {
    // RL-53, and the property invariant 1 rests on: everything in `index.db`
    // other than what a derive put there comes from the journal, so replaying
    // it into an empty database has to land in the same place.
    //
    // In version 2 the exception is wider than version 1's. Thumbnails were
    // always derived; now the size, the dimensions and the content hash are
    // too (RL-22), so a correct rebuild comes back without any of them and
    // comparing every field would report that as a failure.
    const live = Db.openInMemory();
    const rebuilt = Db.openInMemory();
    try {
      await fold(live);
      const [first] = live.repo.allIds();
      if (first === undefined) throw new Error("the fixture replayed to nothing");

      live.repo.putThumbnail(first, 256, 256, 171, Buffer.from([0x00, 0x01]));
      live.repo.putDerived(first, { size: 4096, width: 800, height: 600 }, 1_700_000_000);
      expect(live.repo.stats().thumbnails).toBe(1);

      await fold(rebuilt);

      expect(withoutDerived(rebuilt.repo.stats())).toEqual(withoutDerived(live.repo.stats()));
      expect(rebuilt.repo.allIds()).toEqual(live.repo.allIds());
      for (const id of live.repo.allIds()) {
        // Compared without the derived columns, for the reason above: the same
        // journal is the same library, and what a derive found is not in it.
        expect(journalled(rebuilt, id)).toEqual(journalled(live, id));
      }
      expect(rebuilt.repo.stats().thumbnails).toBe(0);
    } finally {
      live.close();
      rebuilt.close();
    }
  });
});

/** One asset's detail with everything a derive fills taken out. */
function journalled(db: Db, id: ReturnType<Db["repo"]["allIds"]>[number]): unknown {
  const detail = db.repo.assetDetail(id);
  if (detail === undefined) return undefined;
  const { size, width, height, durationMs, pageCount, contentHash, derivedAt, ...said } = detail;
  return said;
}
