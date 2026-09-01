import { fileURLToPath } from "node:url";
import {
  CollectingSink,
  Db,
  IndexSink,
  isClean,
  parseContentHash,
  replay,
  type Stats,
  withoutDerived,
} from "@roost/core";
import { describe, expect, it } from "vitest";

/**
 * A journal written by the Rust implementation, driven through its CLI: 27
 * lines covering all 22 operations. Committed so that "a library written by
 * `roost-old` opens here" is a test rather than a claim (`CONCEPT.md` §7).
 */
const RUST_JOURNAL = fileURLToPath(
  new URL("../src/journal/__fixtures__/rust-written-journal", import.meta.url),
);

const ALPHA = parseContentHash("e683cfdda42a354a1148b1d436f66d20074afbc207ff70efa7971d31e557bcc5");
const GAMMA = parseContentHash("a3fa38211707b91160abba1a06dc65306a14aeb2d5aea1b782580c25eee96cc8");

async function foldRustJournal(db: Db): Promise<void> {
  const report = await replay(RUST_JOURNAL, new IndexSink(db));
  expect(isClean(report)).toBe(true);
  expect(report.unknownOps.size).toBe(0);
}

describe("folding a journal the Rust implementation wrote", () => {
  it("lands the state its operations describe", async () => {
    const db = Db.openInMemory();
    try {
      await foldRustJournal(db);

      expect(db.repo.stats()).toEqual({
        // Four assets were added and `gamma` was removed.
        assets: 3,
        managed: 2,
        referenced: 1,
        partialHashes: 0,
        totalBytes: 13 + 12 + 3,
        // `blue` was taken off the asset but the tag itself survives, and
        // `timber` was created by the `tag_add` — the earlier `tag_rename`
        // from `wood` found nothing to rename and correctly did nothing.
        tags: 2,
        // The group was created, renamed, and deleted.
        tagGroups: 0,
        // `Icons` was deleted; `Moodboards` remains.
        folders: 1,
        smartFolders: 0,
        // Rated 4, then rated null — which the schema distinguishes from 1.
        rated: 0,
        favorites: 1,
        notes: 1,
        trashed: 0,
        // Derived, and therefore deliberately absent from the journal.
        thumbnails: 0,
      } satisfies Stats);

      expect(db.repo.assetDetail(ALPHA)).toMatchObject({
        origName: "alpha at dusk.png",
        note: "client approved",
        rating: null,
        isFavorite: true,
        tags: ["timber"],
        folders: [],
      });

      expect(db.repo.assetDetail(GAMMA)).toBeUndefined();
      expect(db.repo.orphanSearchRows()).toBe(0);
    } finally {
      db.close();
    }
  });

  it("reads every line the Rust implementation wrote", async () => {
    const sink = new CollectingSink();
    const report = await replay(RUST_JOURNAL, sink);
    expect(report.applied).toBe(27);
    expect(new Set(sink.records.map((r) => r.op)).size).toBe(22);
  });
});

describe("rebuild equivalence", () => {
  it("produces the same index as the one it replaces, derived data aside", async () => {
    // The property invariant 1 rests on: everything in `index.db` other than
    // the derived caches comes from the journal, so replaying it into an empty
    // database has to land in the same place. Thumbnails are the exception the
    // comparison has to make room for — a correct rebuild comes back without
    // them, and comparing every field would report that as a failure.
    const live = Db.openInMemory();
    const rebuilt = Db.openInMemory();
    try {
      await foldRustJournal(live);
      live.repo.putThumbnail(ALPHA, 256, 256, 171, Buffer.from([0x00, 0x01]));
      expect(live.repo.stats().thumbnails).toBe(1);

      await foldRustJournal(rebuilt);

      expect(withoutDerived(rebuilt.repo.stats())).toEqual(withoutDerived(live.repo.stats()));
      expect(rebuilt.repo.allHashes()).toEqual(live.repo.allHashes());
      for (const hash of live.repo.allHashes()) {
        expect(rebuilt.repo.assetDetail(hash)).toEqual(live.repo.assetDetail(hash));
      }
      expect(rebuilt.repo.stats().thumbnails).toBe(0);
    } finally {
      live.close();
      rebuilt.close();
    }
  });
});
