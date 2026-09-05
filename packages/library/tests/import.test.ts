import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContentHash, shardOf } from "@roost/core";
import {
  count,
  generateMissing,
  importInto,
  Library,
  PartialHashCollisionError,
  queueStatus,
  retryFailed,
  subtitles,
  tagAdd,
  trashAssets,
} from "@roost/library";
import { GRID_SIZE, gradient } from "@roost/media";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("importing", () => {
  let dir: string;
  let source: string;
  let library: Library;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-import-"));
    source = join(dir, "pictures");
    await mkdir(source, { recursive: true });
    library = await Library.create(join(dir, "library"), "test");
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  const picture = async (name: string, seed: number, format: "png" | "jpeg" = "png") => {
    const path = join(source, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, await gradient(120, 80, seed, format));
    return path;
  };

  it("brings a trashed asset back when the same file is imported again", async () => {
    // Otherwise the import reports a duplicate and the asset stays invisible,
    // which reads as the import having silently done nothing. Deliberately
    // adding a file is the clearest statement there is that it is wanted
    // (ADR-0022).
    const path = await picture("returning.png", 7);
    await importInto(library, [path]);
    await tagAdd(library, library.db.repo.allHashes(), ["kept"]);
    await trashAssets(library, library.db.repo.allHashes());
    expect(count(library, "is:trashed")).toBe(1);

    const again = await importInto(library, [path]);

    // Still a duplicate — nothing was added — and the row is live again with
    // everything it carried. `imported_at` is not rewritten, so it does not
    // jump to the top of a grid it has been in for months.
    expect(again.duplicates).toBe(1);
    expect(again.imported).toBe(0);
    expect(count(library, "is:trashed")).toBe(0);
    expect(count(library, "tag:kept")).toBe(1);
  });

  it("indexes what it walked, and puts the bytes where the hash says", async () => {
    await picture("one.png", 1);
    await picture("two.png", 2);
    await picture("nested/three.jpg", 3, "jpeg");

    const report = await importInto(library, [source]);

    expect(report.scanned).toBe(3);
    expect(report.imported).toBe(3);
    expect(report.failed).toEqual([]);
    expect(library.stats().assets).toBe(3);
    expect(library.stats().managed).toBe(3);

    // Every asset's bytes are at the one path the store derives from its hash,
    // under a single shard level.
    for (const hash of library.db.repo.allHashes()) {
      const detail = library.db.repo.assetDetail(hash);
      const path = library.storageFor("managed").locate(hash, detail?.ext ?? "");
      expect(path).toContain(join("originals", shardOf(hash)));
      await expect(stat(path)).resolves.toBeTruthy();
    }
  });

  it("records dimensions, the source mtime, and the display name", async () => {
    const path = await picture("portrait.png", 7);
    await importInto(library, [path]);

    const [hash] = library.db.repo.allHashes();
    expect(hash).toBeDefined();
    if (hash === undefined) return;

    const detail = library.db.repo.assetDetail(hash);
    expect(detail).toMatchObject({ origName: "portrait.png", ext: "png", width: 120, height: 80 });
    // The library's own copy is stamped with the import time, so the source
    // mtime is unrecoverable once it is placed — which is why it is journalled.
    expect(detail?.createdAt).toBeGreaterThan(0);
  });

  it("re-importing the same folder is a no-op", async () => {
    await picture("one.png", 1);
    await picture("two.png", 2);
    await importInto(library, [source]);

    const again = await importInto(library, [source]);
    expect(again.scanned).toBe(2);
    expect(again.imported).toBe(0);
    expect(again.duplicates).toBe(2);
    expect(library.stats().assets).toBe(2);
  });

  it("deduplicates two identical files inside one batch", async () => {
    // Without a record of what the current batch has already journalled, both
    // look new and the second silently overwrites the first's row.
    const bytes = await gradient(64, 64, 11, "png");
    await writeFile(join(source, "a.png"), bytes);
    await writeFile(join(source, "copy-of-a.png"), bytes);

    const report = await importInto(library, [source]);
    expect(report.scanned).toBe(2);
    expect(report.imported).toBe(1);
    expect(report.duplicates).toBe(1);
    expect(library.stats().assets).toBe(1);
  });

  it("stores the last extension component, lowercased, with no dot", async () => {
    // Verified against the Rust implementation, which stores `b.tar.gz` as
    // `<hash>.gz` and a file with no extension as a bare `<hash>` with no
    // trailing dot. Getting this wrong puts one asset at two addresses across
    // the two builds, and the object store cannot catch it — storage is handed
    // the extension, it does not choose it.
    await writeFile(join(source, "archive.tar.gz"), "not really gzipped");
    await writeFile(join(source, "PHOTO.PNG"), await gradient(32, 32, 5, "png"));
    await writeFile(join(source, "README"), "no extension at all");

    await importInto(library, [source]);

    const extensions = library.db.repo
      .allHashes()
      .map((hash) => library.db.repo.assetDetail(hash)?.ext)
      .sort();
    expect(extensions).toEqual(["", "gz", "png"]);

    // And the filename on disk follows: no trailing dot for the bare one.
    const shards = await readdir(join(library.root, "originals"));
    const names: string[] = [];
    for (const shard of shards)
      names.push(...(await readdir(join(library.root, "originals", shard))));
    expect(names.some((n) => n.endsWith("."))).toBe(false);
    expect(names.filter((n) => !n.includes(".")).length).toBe(1);
  });

  it("stores a file it knows nothing about, rather than refusing it", async () => {
    // A Roost library is not only a media collection. Anything imports, carries
    // tags, and is searchable by name; what a format decides is whether there
    // is a thumbnail and whether the preview can draw it, and neither is a
    // condition of being in the library (`CONCEPT.md` §5).
    const files = ["notes.txt", "model.blend", "archive.zip", "Makefile"];
    for (const [index, name] of files.entries()) {
      await writeFile(join(source, name), `contents ${index}`);
    }

    const report = await importInto(library, [source], { tags: ["assorted"] });

    expect(report.imported).toBe(files.length);
    expect(report.failed).toEqual([]);
    expect(count(library, "tag:assorted")).toBe(files.length);

    // The extension is recorded as it was found, and a file without one gets
    // an empty extension rather than being skipped.
    const extensions = library.db.repo
      .allHashes()
      .map((hash) => library.db.repo.assetDetail(hash)?.ext)
      .sort();
    expect(extensions).toEqual(["", "blend", "txt", "zip"]);

    // Findable by name, which is the whole point of it being in the library.
    for (const name of files) {
      expect(count(library, name.split(".")[0] ?? name)).toBe(1);
    }

    // Nothing drawable, and that is reported as unsupported rather than as a
    // failure: a file Roost cannot draw is one the desktop's own handler opens.
    const thumbnails = await generateMissing(library, [GRID_SIZE]);
    expect(thumbnails).toMatchObject({ generated: 0, unsupported: files.length, failed: [] });
    expect(library.stats().assets).toBe(files.length);
  });

  it("applies the run's tags to everything it imported", async () => {
    await picture("one.png", 1);
    await picture("two.png", 2);
    await importInto(library, [source], { tags: ["reference", "blue"] });

    for (const hash of library.db.repo.allHashes()) {
      expect(library.db.repo.assetDetail(hash)?.tags).toEqual(["blue", "reference"]);
    }
    expect(library.stats().tags).toBe(2);
  });

  it("keeps referenced originals where the user put them", async () => {
    const path = await picture("stays.png", 4);
    await importInto(library, [path], { mode: "referenced" });

    expect(library.stats().referenced).toBe(1);
    // Nothing was written into the object store, and the source is untouched.
    // `originals/` does not even exist: shards are created lazily, and a
    // referenced import places nothing, so there was never an occasion to make
    // one. Asserting its absence is stronger than asserting it is empty.
    await expect(stat(path)).resolves.toBeTruthy();
    await expect(stat(join(library.root, "originals"))).rejects.toThrow();

    const [hash] = library.db.repo.allHashes();
    expect(library.db.repo.assetDetail(hash ?? parseContentHash("0".repeat(64)))?.refPath).toBe(
      path,
    );
  });

  it("skips hidden files unless asked, and never imports the library into itself", async () => {
    await picture("visible.png", 1);
    await writeFile(join(source, ".hidden.png"), await gradient(32, 32, 2, "png"));
    await mkdir(join(source, ".cache"), { recursive: true });
    await writeFile(join(source, ".cache", "buried.png"), await gradient(32, 32, 3, "png"));

    const quiet = await importInto(library, [source]);
    expect(quiet.scanned).toBe(1);

    const everything = await importInto(library, [source], { includeHidden: true });
    expect(everything.scanned).toBe(3);

    // Pointing an import at the library itself must not walk `originals/` and
    // re-import every object under a new name. Asserted on `scanned`, not on
    // `imported`: the objects are byte-identical to what produced them, so they
    // would deduplicate and `imported` would read zero either way.
    const recursive = await importInto(library, [library.root]);
    expect(recursive.scanned).toBe(0);
  });

  it("writes the journal before the index, so no row can outlive its line", async () => {
    // Invariant 9. Ordering is invisible until something fails between the two,
    // so the failure is what the test supplies: with the journal first, a
    // refused append leaves the index untouched and nothing is lost. The other
    // way round it would leave rows the next rebuild cannot reconstruct.
    await picture("one.png", 1);

    const journal = library.journal as unknown as { appendAll: unknown };
    const original = journal.appendAll;
    journal.appendAll = (): Promise<void> => Promise.reject(new Error("no space left on device"));

    try {
      await expect(importInto(library, [source])).rejects.toThrow("no space left on device");
      expect(library.stats().assets).toBe(0);
    } finally {
      journal.appendAll = original;
    }
  });

  it("keeps one unreadable file from ending the run", async () => {
    await picture("good.png", 1);
    const report = await importInto(library, [source, join(dir, "does-not-exist")]);
    expect(report.imported).toBe(1);
  });
});

describe("rebuilding", () => {
  let dir: string;
  let library: Library;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-rebuild-"));
    const source = join(dir, "pictures");
    await mkdir(source, { recursive: true });
    for (let n = 0; n < 5; n += 1) {
      await writeFile(join(source, `p${n}.png`), await gradient(80, 60, n, "png"));
    }
    library = await Library.create(join(dir, "library"), "test");
    await importInto(library, [source], { tags: ["imported"] });
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("reconstructs the index from the journal alone", async () => {
    // Invariant 1, made executable: anything that exists only in `index.db` is
    // a bug, so throwing it away has to be survivable.
    const before = library.stats();
    const hashes = library.db.repo.allHashes();
    const details = hashes.map((hash) => library.db.repo.assetDetail(hash));

    const report = await library.rebuild();

    expect(report.malformed).toEqual([]);
    // One `add` and one `tag_add` per asset: the tag is applied per file, not
    // once for the run, because each asset needs its own membership record.
    expect(report.applied).toBe(before.assets * 2);
    expect(library.stats()).toEqual(before);
    expect(library.db.repo.allHashes()).toEqual(hashes);
    expect(hashes.map((hash) => library.db.repo.assetDetail(hash))).toEqual(details);
  });

  it("loses thumbnails, because they are derived and not journalled", async () => {
    await generateMissing(library, [GRID_SIZE]);
    expect(library.stats().thumbnails).toBe(5);

    await library.rebuild();

    // A correct rebuild comes back without them. `roost thumb` is what restores
    // them, and it can be run at any time.
    expect(library.stats().thumbnails).toBe(0);
    await generateMissing(library, [GRID_SIZE]);
    expect(library.stats().thumbnails).toBe(5);
  });
});

describe("generating thumbnails", () => {
  let dir: string;
  let library: Library;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-thumbs-"));
    const source = join(dir, "pictures");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "wide.png"), await gradient(600, 400, 1, "png"));
    // Two ways to have no thumbnail, which M4 made different things: a format
    // with no backend at all, and a document whose backend exists and cannot
    // read it.
    await writeFile(join(source, "bundle.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
    await writeFile(join(source, "torn.pdf"), Buffer.from("%PDF-1.7\n"));
    library = await Library.create(join(dir, "library"), "test");
    await importInto(library, [source]);
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("draws what it can, parks what nothing draws, and fails what broke", async () => {
    const report = await generateMissing(library, [GRID_SIZE]);

    expect(report.generated).toBe(1);
    // A zip has no picture and never will; the queue parks it.
    expect(report.unsupported).toBe(1);
    // A truncated PDF is a different thing: the backend is here and the file is
    // wrong, so it is a failure worth retrying rather than a capability that is
    // missing.
    expect(report.failed).toHaveLength(1);
    expect(library.stats().thumbnails).toBe(1);
  });

  it("converges: a second run offers only what is worth trying again", async () => {
    await generateMissing(library, [GRID_SIZE]);
    const again = await generateMissing(library, [GRID_SIZE]);

    // The parked zip is not offered again — that is what stops every sweep from
    // re-deriving every undrawable asset in the library — and neither is the
    // failure, until something asks for a retry.
    expect(again.generated).toBe(0);
    expect(again.unsupported).toBe(0);
    expect(again.failed).toEqual([]);
    expect(library.stats().thumbnails).toBe(1);

    const status = queueStatus(library);
    expect(status.blocked).toBe(1);
    expect(status.failed).toBe(1);
    expect(status.reasons).toEqual([{ reason: "unsupported:zip", count: 1 }]);
  });

  it("retries a failure when asked, and leaves the parked work parked", async () => {
    await generateMissing(library, [GRID_SIZE]);

    expect(retryFailed(library)).toBe(1);
    expect(queueStatus(library)).toMatchObject({ ready: 1, blocked: 1 });

    const again = await generateMissing(library, [GRID_SIZE]);
    // Still torn, so still a failure — but it was tried, which is the
    // difference between "retryable" and "parked".
    expect(again.failed).toHaveLength(1);
  });
});

describe("the one blind spot in partial hashing", () => {
  let dir: string;
  let source: string;
  let library: Library;

  /**
   * Two files over the 50 MiB threshold that share a size, a first 64 KiB, and
   * a last 64 KiB, and differ only in between.
   *
   * That is the entire input to a partial hash, so the two hash identically —
   * and it is the one case the scheme cannot see. Sizes are no help: the size
   * is hashed as the prefix, so equal partial hashes already imply equal sizes.
   */
  const twin = async (name: string, marker: number): Promise<string> => {
    const bytes = Buffer.alloc(51 * 1024 * 1024, 0x41);
    bytes[bytes.length >> 1] = marker;
    const path = join(source, name);
    await writeFile(path, bytes);
    return path;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-partial-"));
    source = join(dir, "big");
    await mkdir(source, { recursive: true });
    library = await Library.create(join(dir, "library"), "test");
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses the second file rather than merging two different ones", async () => {
    await twin("first.bin", 0x01);
    await twin("second.bin", 0x02);

    const report = await importInto(library, [source]);

    expect(report.imported).toBe(1);
    expect(report.partialCollisions).toBe(1);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.reason).toContain("refusing to merge");
    // One of the two is in the library and the other is not. Merging them would
    // have lost one permanently, which is why the import declines instead.
    expect(library.stats().assets).toBe(1);
  });

  it("still deduplicates the same large file imported twice", async () => {
    // The byte comparison has to say "same" as readily as it says "different",
    // or every large file would be refused on its second import.
    const path = await twin("once.bin", 0x01);
    await importInto(library, [path]);
    const again = await importInto(library, [path]);

    expect(again.duplicates).toBe(1);
    expect(again.partialCollisions).toBe(0);
    expect(again.partialDuplicates).toBe(0);
    expect(library.stats().assets).toBe(1);
    expect(library.stats().partialHashes).toBe(1);
  });

  it("verifies a referenced original against its recorded path", async () => {
    // The Rust build could not: it located through the *incoming* import's
    // store, so a referenced asset was always out of reach and every large
    // duplicate was merged on probability. `ref_path` sits in the same row as
    // the storage mode, so the comparison is available and the merge is
    // certain rather than probable.
    const path = await twin("referenced.bin", 0x03);
    await importInto(library, [path], { mode: "referenced" });
    const again = await importInto(library, [path], { mode: "referenced" });

    expect(again.duplicates).toBe(1);
    expect(again.partialDuplicates).toBe(0);
  });

  it("refuses a collision against a referenced original too", async () => {
    // The protection managed mode already had, now reaching the mode that did
    // not have it. Merging these would lose one of two distinct files.
    await importInto(library, [await twin("first.bin", 0x01)], { mode: "referenced" });
    const report = await importInto(library, [await twin("second.bin", 0x02)], {
      mode: "referenced",
    });

    expect(report.partialCollisions).toBe(1);
    expect(library.stats().assets).toBe(1);
  });

  it("falls back to a probable merge when the referenced original has moved", async () => {
    // This is what `partialDuplicates` is actually for: the user moved their
    // own file, so nothing can be compared and the match is merged on the
    // strength of the partial hash alone. Counted separately so the number is
    // visible instead of implied.
    const path = await twin("wanders.bin", 0x04);
    await importInto(library, [path], { mode: "referenced" });
    // Gone from where the index says it is — the user moved their own file,
    // which referenced mode explicitly permits.
    await rm(path);

    const elsewhere = join(dir, "moved");
    await mkdir(elsewhere, { recursive: true });
    const bytes = Buffer.alloc(51 * 1024 * 1024, 0x41);
    bytes[bytes.length >> 1] = 0x04;
    const copy = join(elsewhere, "wanders.bin");
    await writeFile(copy, bytes);

    const again = await importInto(library, [copy], { mode: "referenced" });

    expect(again.duplicates).toBe(1);
    expect(again.partialDuplicates).toBe(1);
  });

  it("finds a managed original when the import is running in referenced mode", async () => {
    // The other direction of the same fix: the bytes are in the object store,
    // and asking the referenced store for them would have been refused.
    await importInto(library, [await twin("managed.bin", 0x05)]);
    const source = join(dir, "elsewhere");
    await mkdir(source, { recursive: true });
    const bytes = Buffer.alloc(51 * 1024 * 1024, 0x41);
    bytes[bytes.length >> 1] = 0x05;
    await writeFile(join(source, "managed.bin"), bytes);

    const again = await importInto(library, [join(source, "managed.bin")], { mode: "referenced" });
    expect(again.duplicates).toBe(1);
    expect(again.partialDuplicates).toBe(0);
  });
  const CUE = "1\n00:00:01,000 --> 00:00:02,000\nHello.\n";

  it("attaches a subtitle to the film beside it whatever the case of its name", async () => {
    // `Holiday.MP4` and `holiday.srt` are one pair to everybody except a
    // case-sensitive filesystem, which is the only filesystem this runs on.
    const folder = join(dir, "films");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "Holiday.MP4"), Buffer.alloc(2048, 0x21));
    await writeFile(join(folder, "holiday.srt"), CUE);

    const report = await importInto(library, [folder]);

    expect(report.subtitles).toBe(1);
    expect(report.subtitlesUnattached).toBe(0);

    const film = library.db.repo
      .allHashes()
      .find((hash) => library.db.repo.assetDetail(hash)?.ext === "mp4");
    expect(film).toBeDefined();
    expect(subtitles(library, film ?? parseContentHash("0".repeat(64)))).toHaveLength(1);
  });

  it("counts a subtitle that found no film beside it", async () => {
    // Otherwise the run is silent about the one outcome that needs the user:
    // the track imported, attached to nothing, and sitting loose in the grid.
    const folder = join(dir, "loose");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "orphan.srt"), CUE);

    const report = await importInto(library, [folder]);

    expect(report.subtitles).toBe(0);
    expect(report.subtitlesUnattached).toBe(1);
  });
});
