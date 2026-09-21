import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monthKey, shardOf, withoutDerived } from "@roost/core";
import {
  count,
  createFolder,
  generateMissing,
  importInto,
  Library,
  queueStatus,
  retryFailed,
  subtitles,
  tagAdd,
  trashAssets,
  UnknownFolderError,
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
    await tagAdd(library, library.db.repo.allIds(), ["kept"]);
    await trashAssets(library, library.db.repo.allIds());
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

  it("indexes what it walked, and puts the bytes where the id says", async () => {
    await picture("one.png", 1);
    await picture("two.png", 2);
    await picture("nested/three.jpg", 3, "jpeg");

    const report = await importInto(library, [source]);

    expect(report.scanned).toBe(3);
    expect(report.imported).toBe(3);
    expect(report.failed).toEqual([]);
    expect(library.stats().assets).toBe(3);
    // Copied by default, and the report says so because RL-26 requires it.
    expect(report.copied).toBe(3);
    expect(report.moved).toBe(0);

    // Every asset's bytes are at the one path the store derives from its id,
    // under a single shard level (RL-8, RL-9).
    for (const id of library.db.repo.allIds()) {
      const detail = library.db.repo.assetDetail(id);
      const path = library.storage.locate(id, detail?.ext ?? "");
      expect(path).toContain(join("files", shardOf(id)));
      await expect(stat(path)).resolves.toBeTruthy();
    }
  });

  it("records the source date in the journal and the rest in the index", async () => {
    const path = await picture("portrait.png", 7);
    await importInto(library, [path]);

    const [id] = library.db.repo.allIds();
    expect(id).toBeDefined();
    if (id === undefined) return;

    const detail = library.db.repo.assetDetail(id);
    // The name carries no extension (RL-33): what a window shows is this name
    // joined to the extension it finds on disk.
    expect(detail).toMatchObject({ name: "portrait", ext: "png", width: 120, height: 80 });

    // Everything about the bytes is derived and was written by the import's own
    // measurement rather than by a journal line (RL-22, RL-23).
    expect(detail?.size).toBeGreaterThan(0);
    expect(detail?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(detail?.derivedAt).toBeGreaterThan(0);

    // The source file's own date, which nothing can recover once the file is
    // here: the stored copy's date becomes the date of the last edit the moment
    // anybody saves it. That is why it is the one fact the journal carries.
    expect(detail?.createdAt).toBeGreaterThan(0);

    // And the journal says only what a person said.
    const line = (
      await readFile(
        join(library.journal.dir, `${monthKey(detail?.importedAt ?? 0)}.jsonl`),
        "utf8",
      )
    ).split("\n")[0];
    expect(line).not.toContain("size");
    expect(line).not.toContain("width");
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
    // RL-9 and RL-9a: `b.tar.gz` is stored as `<id>.gz` and a file with no
    // extension as a bare `<id>` with **no trailing dot**. Getting the second
    // one wrong produces a library other systems cannot read while passing
    // every test a Windows build could write, because Windows strips a
    // trailing dot before the path reaches the filesystem.
    await writeFile(join(source, "archive.tar.gz"), "not really gzipped");
    await writeFile(join(source, "PHOTO.PNG"), await gradient(32, 32, 5, "png"));
    await writeFile(join(source, "README"), "no extension at all");

    await importInto(library, [source]);

    const extensions = library.db.repo
      .allIds()
      .map((hash) => library.db.repo.assetDetail(hash)?.ext)
      .sort();
    expect(extensions).toEqual(["", "gz", "png"]);

    // And the filename on disk follows: no trailing dot for the bare one.
    const shards = await readdir(join(library.root, "files"));
    const names: string[] = [];
    for (const shard of shards) names.push(...(await readdir(join(library.root, "files", shard))));
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
      .allIds()
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

    for (const hash of library.db.repo.allIds()) {
      expect(library.db.repo.assetDetail(hash)?.tags).toEqual(["blue", "reference"]);
    }
    expect(library.stats().tags).toBe(2);
  });

  it("puts everything it imported in the folder the run names", async () => {
    // ADR-0037: an import lands where the window was looking.
    const folder = await createFolder(library, "Design", null);
    await picture("one.png", 1);
    await picture("two.png", 2);

    const report = await importInto(library, [source], { folder });

    expect(report.imported).toBe(2);
    expect(count(library, "folder:Design")).toBe(2);
  });

  it("leaves a duplicate out of the folder, and names it in the report", async () => {
    // The offer to file it is the dialog's, not the importer's: a file the
    // library already holds is not this run's asset to put anywhere.
    const folder = await createFolder(library, "Design", null);
    const path = await picture("already.png", 9);
    await importInto(library, [path]);

    const again = await importInto(library, [path], { folder });

    expect(again.duplicates).toBe(1);
    expect(count(library, "folder:Design")).toBe(0);
    expect(again.duplicateNames).toEqual(["already.png"]);
    expect(again.duplicateIds).toEqual(library.db.repo.allIds());
  });

  it("refuses a folder that is not there before it hashes anything", async () => {
    // Checked at the start rather than where the record is written: a run that
    // failed halfway would have journalled some of itself already.
    await picture("one.png", 1);

    await expect(importInto(library, [source], { folder: 404 })).rejects.toBeInstanceOf(
      UnknownFolderError,
    );
    expect(library.stats().assets).toBe(0);
  });

  it("moves the source when asked, and says which it did (RL-26)", async () => {
    const path = await picture("goes.png", 4);
    const report = await importInto(library, [path], { take: "move" });

    expect(report).toMatchObject({ imported: 1, moved: 1, copied: 0 });
    // The half that cannot be undone by looking at the library, which is why
    // the report has to carry it.
    await expect(stat(path)).rejects.toThrow();

    const [id] = library.db.repo.allIds();
    expect(id).toBeDefined();
    if (id === undefined) return;
    await expect(stat(library.storage.locate(id, "png"))).resolves.toBeTruthy();
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
    const ids = library.db.repo.allIds();
    const details = ids.map((id) => library.db.repo.assetDetail(id));

    const report = await library.rebuild();

    expect(report.malformed).toEqual([]);
    // One `add` and one `tag_add` per asset: the tag is applied per file, not
    // once for the run, because each asset needs its own membership record.
    expect(report.applied).toBe(before.assets * 2);
    // Compared with what a derive put there taken out, which is what a
    // rebuild is *supposed* to drop: in version 2 that is the size, the
    // dimensions and the content hash as well as the thumbnails (RL-22).
    expect(withoutDerived(library.stats())).toEqual(withoutDerived(before));
    expect(library.db.repo.allIds()).toEqual(ids);
    for (const [index, id] of ids.entries()) {
      const now = library.db.repo.assetDetail(id);
      const then = details[index];
      expect(now?.name).toBe(then?.name);
      expect(now?.tags).toEqual(then?.tags);
      expect(now?.createdAt).toBe(then?.createdAt);
      // And what a derive had found is gone, which is the other half of it.
      expect(now?.size).toBeNull();
      expect(then?.size).toBeGreaterThan(0);
    }
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

describe("subtitles found beside a film", () => {
  let dir: string;
  let library: Library;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-subs-"));
    library = await Library.create(join(dir, "library"), "test");
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
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
      .allIds()
      .find((id) => library.db.repo.assetDetail(id)?.ext === "mp4");
    expect(film).toBeDefined();
    expect(subtitles(library, film ?? ("ZZZZZZZZZZZZ" as never))).toHaveLength(1);
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
