import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AssetId, lockPathFor } from "@roost/core";
import {
  addComment,
  addToFolder,
  apply,
  createFolder,
  importInto,
  Library,
  LibraryBusyError,
  rate,
  resolveFile,
  SameLibraryError,
  setNote,
  setSource,
  type TransferProgress,
  tagAdd,
  transferAssets,
  transferToLibrary,
  trashAssets,
} from "@roost/library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("moving assets between libraries (ADR-0054)", () => {
  let dir: string;
  let incoming: string;
  let source: Library;
  let target: Library;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-transfer-"));
    incoming = join(dir, "incoming");
    await mkdir(incoming, { recursive: true });
    source = await Library.create(join(dir, "Source.roost"), "Source");
    target = await Library.create(join(dir, "Target.roost"), "Target");
  });

  afterEach(async () => {
    await source.close();
    await target.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Imports one file with these bytes into `library`, and answers its id. */
  async function file(library: Library, name: string, text: string): Promise<AssetId> {
    const path = join(incoming, name);
    await writeFile(path, text);
    const report = await importInto(library, [path]);
    await rm(path, { force: true });
    const id = report.importedIds[0] ?? report.duplicateIds[0];
    if (id === undefined) throw new Error(`${name} was not imported`);
    return id;
  }

  /** The target's one asset of this name. */
  function named(library: Library, name: string): AssetId {
    const found = library.db.repo
      .allIds()
      .filter((id) => library.db.repo.findAsset(id)?.name === name);
    expect(found).toHaveLength(1);
    return found[0] as AssetId;
  }

  async function bytesOf(library: Library, id: AssetId): Promise<string> {
    const found = await resolveFile(library, id);
    if (found.kind !== "found") throw new Error(`${id} has no file`);
    return readFile(found.path, "utf8");
  }

  it("takes everything a person wrote, and leaves nothing behind", async () => {
    const id = await file(source, "brief.txt", "the brief");
    const design = await createFolder(source, "Design", null);
    const icons = await createFolder(source, "Icons", design);
    await addToFolder(source, [id], icons);
    await tagAdd(source, [id], ["client", "draft"]);
    await rate(source, [id], 4);
    await setNote(source, [id], "check the margins");
    await setSource(source, [id], "https://example.com/brief");
    await addComment(source, id, null, "looks right");
    await addComment(source, id, 1_500, "at a moment");
    const sourcePath = await resolveFile(source, id);

    const report = await transferAssets(source, target, [id], { take: "move" });

    expect(report).toMatchObject({ added: 1, merged: 0, removed: 1, folders: 2, missing: 0 });
    expect(report.failed).toEqual([]);

    const moved = named(target, "brief");
    const detail = target.db.repo.assetDetail(moved);
    expect(detail).toMatchObject({
      ext: "txt",
      rating: 4,
      note: "check the margins",
      sourceUrl: "https://example.com/brief",
      tags: ["client", "draft"],
      trashedAt: null,
    });
    expect(detail?.folders.map((folder) => folder.path)).toEqual(["Design/Icons"]);
    expect(
      target.db.repo.commentsFor(moved).map((comment) => [comment.atMs, comment.body]),
    ).toEqual(
      expect.arrayContaining([
        [null, "looks right"],
        [1_500, "at a moment"],
      ]),
    );
    expect(await bytesOf(target, moved)).toBe("the brief");

    // Gone from the source, row and file (ADR-0031).
    expect(source.db.repo.hasAsset(id)).toBe(false);
    if (sourcePath.kind !== "found") throw new Error("the source file was never there");
    await expect(readFile(sourcePath.path)).rejects.toThrow();
  });

  it("gives the asset a new id in the target (RL-15, RL-16)", async () => {
    const id = await file(source, "a.txt", "a");
    await transferAssets(source, target, [id], { take: "copy" });

    // Not a requirement that it differ, but nothing may assume it matches: the
    // target minted it, and the chance of a match is 2⁻⁶⁰.
    expect(named(target, "a")).not.toBe(id);
  });

  it("leaves the source as it was when copying", async () => {
    const id = await file(source, "keep.txt", "kept");
    await tagAdd(source, [id], ["stays"]);

    const report = await transferAssets(source, target, [id], { take: "copy" });

    expect(report.removed).toBe(0);
    expect(source.db.repo.assetDetail(id)?.tags).toEqual(["stays"]);
    expect(await bytesOf(source, id)).toBe("kept");
    expect(await bytesOf(target, named(target, "keep"))).toBe("kept");
  });

  it("files into the target's folders by path, reusing them without regard to case", async () => {
    const existing = await createFolder(target, "design", null);
    const id = await file(source, "logo.txt", "logo");
    const design = await createFolder(source, "Design", null);
    await addToFolder(source, [id], await createFolder(source, "Icons", design));

    const report = await transferAssets(source, target, [id], { take: "move" });

    // `design` is the target's own and is used; only `Icons` is new.
    expect(report.folders).toBe(1);
    const folders = target.db.repo.folders();
    expect(folders.filter((folder) => folder.parentId === null)).toHaveLength(1);
    expect(folders.find((folder) => folder.name === "Icons")?.parentId).toBe(existing);
  });

  it("carries the trash state and the poster frame", async () => {
    const trashed = await file(source, "old.txt", "old");
    await trashAssets(source, [trashed]);
    const clip = await file(source, "clip.mp4", "not really a video");
    await apply(source, [{ op: "poster_set", asset: clip, at: 2_000 }]);

    await transferAssets(source, target, [trashed, clip], { take: "move" });

    expect(target.db.repo.trashedAt(named(target, "old"))).toBeTypeOf("number");
    expect(target.db.repo.posterOf(named(target, "clip"))).toBe(2_000);
  });

  it("merges onto a file the target already holds, keeping what was written there", async () => {
    const theirs = await file(target, "photo.txt", "same bytes");
    await rate(target, [theirs], 5);
    await tagAdd(target, [theirs], ["theirs"]);

    const mine = await file(source, "photo.txt", "same bytes");
    await rate(source, [mine], 2);
    await setNote(source, [mine], "from the source");
    await tagAdd(source, [mine], ["mine"]);

    const report = await transferAssets(source, target, [mine], { take: "move" });

    expect(report).toMatchObject({ added: 0, merged: 1, preserved: 1, removed: 1 });
    expect(target.db.repo.allIds()).toEqual([theirs]);
    expect(target.db.repo.assetDetail(theirs)).toMatchObject({
      rating: 5,
      note: "from the source",
      tags: ["mine", "theirs"],
    });
    expect(source.db.repo.hasAsset(mine)).toBe(false);
  });

  it("does not trash the target's asset because the incoming copy was trashed", async () => {
    const theirs = await file(target, "live.txt", "shared");
    const mine = await file(source, "live.txt", "shared");
    await trashAssets(source, [mine]);

    await transferAssets(source, target, [mine], { take: "move" });

    expect(target.db.repo.trashedAt(theirs)).toBeNull();
  });

  it("finishes an interrupted move when it is run again, without doubling anything", async () => {
    const id = await file(source, "twice.txt", "twice");
    await addComment(source, id, 500, "only once");
    await tagAdd(source, [id], ["once"]);

    // What a crash before the source's removal leaves: the target has it all,
    // and the source still does too.
    await transferAssets(source, target, [id], { take: "copy" });
    const again = await transferAssets(source, target, [id], { take: "move" });

    expect(again).toMatchObject({ added: 0, merged: 1, removed: 1 });
    const moved = named(target, "twice");
    expect(target.db.repo.commentsFor(moved)).toHaveLength(1);
    expect(target.db.repo.assetDetail(moved)?.tags).toEqual(["once"]);
    expect(source.db.repo.hasAsset(id)).toBe(false);
  });

  it("brings a video's subtitles along and attaches them again", async () => {
    await writeFile(join(incoming, "talk.mp4"), "video bytes");
    await writeFile(join(incoming, "talk.en.srt"), "1\n00:00:01,000 --> 00:00:02,000\nhi\n");
    const imported = await importInto(source, [incoming]);
    expect(imported.subtitles).toBe(1);
    const video = source.db.repo
      .allIds()
      .find((id) => source.db.repo.findAsset(id)?.ext === "mp4") as AssetId;
    const [track] = source.db.repo.subtitlesFor(video);

    // Only the video is selected: the attached track has left the grid.
    const report = await transferAssets(source, target, [video], { take: "move" });

    expect(report).toMatchObject({ added: 2, removed: 2, subtitles: 1 });
    const moved = target.db.repo
      .allIds()
      .find((id) => target.db.repo.findAsset(id)?.ext === "mp4") as AssetId;
    const tracks = target.db.repo.subtitlesFor(moved);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.lang).toBe(track?.lang);
    expect(source.db.repo.allIds()).toEqual([]);
  });

  it("copies rather than moves a track that also captions a video staying behind", async () => {
    const leaving = await file(source, "cut-a.mp4", "cut a");
    const staying = await file(source, "cut-b.mp4", "cut b");
    const track = await file(source, "shared.srt", "1\n00:00:01,000 --> 00:00:02,000\nhi\n");
    await apply(source, [
      { op: "subtitle_attach", asset: leaving, track },
      { op: "subtitle_attach", asset: staying, track },
    ]);

    const report = await transferAssets(source, target, [leaving], { take: "move" });

    expect(report.removed).toBe(1);
    expect(source.db.repo.hasAsset(track)).toBe(true);
    expect(source.db.repo.subtitlesFor(staying).map((row) => row.trackId)).toEqual([track]);
    expect(target.db.repo.subtitlesFor(named(target, "cut-a"))).toHaveLength(1);
  });

  it("leaves an asset whose file is missing where it is", async () => {
    const present = await file(source, "here.txt", "here");
    const gone = await file(source, "gone.txt", "gone");
    const found = await resolveFile(source, gone);
    if (found.kind !== "found") throw new Error("the file was never there");
    await rm(found.path);

    const report = await transferAssets(source, target, [present, gone], { take: "move" });

    expect(report).toMatchObject({ added: 1, missing: 1, removed: 1 });
    expect(source.db.repo.hasAsset(gone)).toBe(true);
    expect(source.db.repo.hasAsset(present)).toBe(false);
  });

  it("is rebuilt from the target's journal as it was written (invariant 1)", async () => {
    const id = await file(source, "durable.txt", "durable");
    await tagAdd(source, [id], ["kept"]);
    await addToFolder(source, [id], await createFolder(source, "Archive", null));
    await addComment(source, id, null, "still here");
    await transferAssets(source, target, [id], { take: "move" });

    const moved = named(target, "durable");
    const before = target.db.repo.assetDetail(moved);
    await target.rebuild();

    expect(target.db.repo.assetDetail(moved)).toMatchObject({
      name: before?.name,
      tags: before?.tags,
      folders: before?.folders,
    });
    expect(target.db.repo.commentsFor(moved)).toHaveLength(1);
  });

  it("counts every byte to the end, and every asset", async () => {
    const ids = [
      await file(source, "one.txt", "a".repeat(1_000)),
      await file(source, "two.txt", "b".repeat(2_500)),
    ];
    const seen: TransferProgress[] = [];

    await transferAssets(source, target, ids, { take: "copy" }, (progress) => seen.push(progress));

    expect(seen.at(-1)).toEqual({ done: 2, total: 2, bytesDone: 3_500, bytesTotal: 3_500 });
    // Never backwards and never past the end, which is what a bar needs.
    for (const [index, progress] of seen.entries()) {
      expect(progress.bytesDone).toBeLessThanOrEqual(progress.bytesTotal);
      expect(progress.bytesDone).toBeGreaterThanOrEqual(seen[index - 1]?.bytesDone ?? 0);
    }
  });

  it("does nothing when stopped before it starts", async () => {
    const id = await file(source, "early.txt", "early");
    const controller = new AbortController();
    controller.abort();

    const report = await transferAssets(source, target, [id], {
      take: "move",
      signal: controller.signal,
    });

    expect(report).toMatchObject({ added: 0, removed: 0, cancelled: true });
    expect(report.failed).toEqual([]);
    expect(source.db.repo.hasAsset(id)).toBe(true);
    expect(target.db.repo.allIds()).toEqual([]);
  });

  it("keeps what arrived when stopped part way, and moves exactly that (ADR-0054 §3.9)", async () => {
    const ids: AssetId[] = [];
    for (let index = 0; index < 30; index += 1) {
      ids.push(await file(source, `part-${index}.txt`, `part ${index}`));
    }
    const controller = new AbortController();

    const report = await transferAssets(
      source,
      target,
      ids,
      { take: "move", signal: controller.signal },
      (progress) => {
        if (progress.done >= 1) controller.abort();
      },
    );

    expect(report.cancelled).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.added).toBeGreaterThan(0);
    expect(report.added).toBeLessThan(ids.length);
    // Every asset is in exactly one of the two libraries: what arrived left,
    // and what did not arrive never went anywhere.
    expect(report.removed).toBe(report.added);
    expect(target.db.repo.allIds()).toHaveLength(report.added);
    expect(source.db.repo.allIds()).toHaveLength(ids.length - report.added);
  });

  it("refuses the library the assets are already in", async () => {
    const id = await file(source, "here.txt", "here");
    await expect(transferAssets(source, source, [id], { take: "move" })).rejects.toBeInstanceOf(
      SameLibraryError,
    );
    await expect(
      transferToLibrary(source, source.root, [id], { take: "move" }),
    ).rejects.toBeInstanceOf(SameLibraryError);
  });

  it("opens and closes a target that is not open", async () => {
    const id = await file(source, "travels.txt", "travels");
    const elsewhere = join(dir, "Elsewhere.roost");
    await (await Library.create(elsewhere, "Elsewhere")).close();

    const report = await transferToLibrary(source, elsewhere, [id], { take: "move" });
    expect(report.added).toBe(1);

    const reopened = await Library.open(elsewhere, { exclusive: true });
    try {
      expect(named(reopened, "travels")).toBeDefined();
    } finally {
      await reopened.close();
    }
  });

  it("refuses a target another process has open, and writes nothing", async () => {
    const id = await file(source, "blocked.txt", "blocked");
    const elsewhere = join(dir, "Elsewhere.roost");
    await (await Library.create(elsewhere, "Elsewhere")).close();
    // The lock is this process's own when it names this pid, so another live
    // one is written in: the parent, which outlives the test.
    const lock = await lockPathFor(elsewhere);
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(lock, String(process.ppid));

    try {
      await expect(
        transferToLibrary(source, elsewhere, [id], { take: "move" }),
      ).rejects.toBeInstanceOf(LibraryBusyError);
      expect(source.db.repo.hasAsset(id)).toBe(true);
    } finally {
      await rm(lock, { force: true });
    }
  });
});
