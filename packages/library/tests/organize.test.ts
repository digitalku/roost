import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContentHash, DEFAULT_PAGE_LIMIT, IndexSink, withoutDerived } from "@roost/core";
import {
  AmbiguousFolderNameError,
  addComment,
  addToFolder,
  apply,
  comments,
  count,
  createFolder,
  createSmartFolder,
  createTagGroup,
  deleteFolder,
  EmptyCommentError,
  EmptyNameError,
  emptyTrash,
  FolderCycleError,
  InvalidMomentError,
  InvalidRatingError,
  importInto,
  Library,
  moveFolder,
  NotAVideoError,
  pageOf,
  pages,
  poster,
  queueStatus,
  rate,
  readSidebar,
  removeAssets,
  removeComment,
  renameAsset,
  renameFolder,
  resolveAsset,
  resolveFolder,
  resolveTagGroup,
  restoreAssets,
  search,
  setComment,
  setNote,
  setPoster,
  setTagGroup,
  tagAdd,
  tagRemove,
  tagRename,
  trashAssets,
  UnknownAssetError,
  UnknownCommentError,
  UnknownFolderPathError,
} from "@roost/library";
import { GRID_SIZE, gradient, PREVIEW_SIZE } from "@roost/media";
import { QueryError } from "@roost/search";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PAGE = { limit: DEFAULT_PAGE_LIMIT };

describe("organizing a library", () => {
  let dir: string;
  let library: Library;
  let hashes: ContentHash[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-organize-"));
    const source = join(dir, "pictures");
    await mkdir(source, { recursive: true });
    for (const [index, name] of ["alpha.png", "beta.png", "gamma.jpg"].entries()) {
      await writeFile(
        join(source, name),
        await gradient(60, 40, index + 1, name.endsWith(".jpg") ? "jpeg" : "png"),
      );
    }

    library = await Library.create(join(dir, "library"), "test");
    await importInto(library, [source]);
    hashes = library.db.repo.allHashes();
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  const names = (hits: readonly { origName: string }[]): string[] =>
    hits.map((hit) => hit.origName).sort();

  /** Every journal line written so far, parsed. */
  const journalLines = async (): Promise<Record<string, unknown>[]> => {
    await library.journal.sync();
    const month = (await library.journal.months())[0] as string;
    return (await readFile(library.journal.pathFor(month), "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  it("journals every edit before it indexes one", async () => {
    // Invariant 9, checked against the file rather than against the report: a
    // row with no journal line is data loss the next rebuild would reveal, and
    // the index alone cannot tell the two cases apart.
    await tagAdd(library, [hashes[0] as ContentHash], ["wood"]);
    await library.journal.sync();

    const month = (await library.journal.months())[0] as string;
    const lines = (await readFile(library.journal.pathFor(month), "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { op: string });

    expect(lines.some((record) => record.op === "tag_add")).toBe(true);
    expect(search(library, "tag:wood", PAGE)).toHaveLength(1);
  });

  it("finds by tag, and stops finding once the tag is gone", async () => {
    await tagAdd(library, hashes, ["shared"]);
    await tagAdd(library, [hashes[0] as ContentHash], ["only-one"]);

    expect(count(library, "tag:shared")).toBe(3);
    expect(count(library, "tag:only-one")).toBe(1);
    expect(count(library, "tag:shared -tag:only-one")).toBe(2);

    await tagRemove(library, [hashes[0] as ContentHash], ["only-one"]);
    expect(count(library, "tag:only-one")).toBe(0);
  });

  it("merges a rename onto an existing tag rather than failing", async () => {
    await tagAdd(library, [hashes[0] as ContentHash], ["draft"]);
    await tagAdd(library, [hashes[1] as ContentHash], ["wip"]);

    await tagRename(library, "draft", "wip");

    expect(count(library, "tag:wip")).toBe(2);
    expect(count(library, "tag:draft")).toBe(0);
  });

  it("matches a folder and everything beneath it", async () => {
    const design = await createFolder(library, "Design", null);
    const icons = await createFolder(library, "Icons", design);

    await addToFolder(library, [hashes[0] as ContentHash], design);
    await addToFolder(library, [hashes[1] as ContentHash], icons);

    expect(count(library, "folder:Design")).toBe(2);
    expect(count(library, "folder:Design/Icons")).toBe(1);
    // A bare name resolves when a path does not, so nobody has to type the
    // whole path to reach a folder they can see.
    expect(count(library, "folder:Icons")).toBe(1);
    // A folder nobody created is an empty answer, not an error.
    expect(count(library, "folder:Nonexistent")).toBe(0);
  });

  it("refuses a folder name that would make its own path ambiguous", async () => {
    // Found by driving the real window: a top-level folder literally named
    // `Design/Icons` and an `Icons` inside `Design` both compile to
    // `folder:"Design/Icons"`, so the sidebar highlighted the wrong row and
    // neither folder was reliably addressable from the CLI.
    const design = await createFolder(library, "Design", null);
    await expect(createFolder(library, "Design/Icons", null)).rejects.toBeInstanceOf(
      AmbiguousFolderNameError,
    );
    await expect(renameFolder(library, design, "a/b")).rejects.toBeInstanceOf(
      AmbiguousFolderNameError,
    );
    // The name is still trimmed and still may not be empty; only the separator
    // is new.
    await expect(createFolder(library, "  ", null)).rejects.toBeInstanceOf(EmptyNameError);
  });

  it("still replays a folder name an older library recorded", async () => {
    // The rule binds names as they are authored, not as they are read. A
    // library written before it — or by the Rust implementation — must still
    // rebuild, so the sink and replay do not check.
    const sink = new IndexSink(library.db);
    library.db.transaction(() => {
      sink.apply({ ts: 1, op: "folder_create", id: 900, parent: null, name: "Design/Icons" });
    });
    expect(library.db.repo.folders().some((row) => row.name === "Design/Icons")).toBe(true);
  });

  it("refuses to move a folder into its own subtree", async () => {
    const design = await createFolder(library, "Design", null);
    const icons = await createFolder(library, "Icons", design);

    await expect(moveFolder(library, design, icons)).rejects.toBeInstanceOf(FolderCycleError);
    expect(library.db.repo.folder(design)?.parentId).toBe(null);
  });

  it("keeps the assets when a folder is deleted", async () => {
    const folder = await createFolder(library, "Temporary", null);
    await addToFolder(library, hashes, folder);
    expect(count(library, "folder:Temporary")).toBe(3);

    await deleteFolder(library, folder);

    expect(library.stats().assets).toBe(3);
    expect(() => resolveFolder(library, "Temporary")).toThrow(UnknownFolderPathError);
  });

  it("rates, notes, and still finds a favourite, and refuses a rating the schema has no room for", async () => {
    await rate(library, [hashes[0] as ContentHash], 4);
    // Journalled directly: nothing authors a favourite any more (ADR-0029), but
    // `is:favorite` stays in the grammar, because a smart folder that says it
    // must still parse — so what a library already holds is still findable.
    await apply(library, [{ op: "favorite_set", hash: hashes[1] as ContentHash, favorite: true }]);
    await setNote(library, hashes[2] as ContentHash, "  needs a crop  ");

    expect(count(library, "rating:>=4")).toBe(1);
    expect(count(library, "is:favorite")).toBe(1);
    expect(count(library, "is:unrated")).toBe(2);
    expect(library.db.repo.assetDetail(hashes[2] as ContentHash)?.note).toBe("needs a crop");

    await expect(rate(library, [hashes[0] as ContentHash], 9)).rejects.toBeInstanceOf(
      InvalidRatingError,
    );
    // A note of nothing but whitespace clears the note rather than storing one,
    // which would show as an empty badge on the asset forever.
    await setNote(library, hashes[2] as ContentHash, "   ");
    expect(library.db.repo.assetDetail(hashes[2] as ContentHash)?.note).toBe(null);
  });

  it("renames what the library shows, and the full-text index with it", async () => {
    // Found by name rather than by position: `allHashes()` is ordered by hash,
    // which says nothing about which file it came from.
    const alpha = search(library, "alpha", PAGE)[0]?.hash as ContentHash;
    const hash = resolveAsset(library, alpha.slice(0, 8));
    await renameAsset(library, hash, "renamed-on-purpose.png");

    expect(names(search(library, "renamed-on-purpose", PAGE))).toEqual(["renamed-on-purpose.png"]);
    expect(search(library, "alpha", PAGE)).toHaveLength(0);
  });

  it("resolves a prefix, and refuses one that names nothing", () => {
    expect(resolveAsset(library, (hashes[0] as string).slice(0, 10))).toBe(hashes[0]);
    expect(() => resolveAsset(library, "ffffffffff")).toThrow(UnknownAssetError);
    // Not hex at all is the same mistake, reported the same way.
    expect(() => resolveAsset(library, "not-a-hash")).toThrow(UnknownAssetError);
  });

  it("removes index rows without touching the bytes", async () => {
    const hash = hashes[0] as ContentHash;
    const detail = library.db.repo.assetDetail(hash);
    const path = library.storageFor("managed").locate(hash, detail?.ext ?? "");

    await removeAssets(library, [hash]);

    expect(library.stats().assets).toBe(2);
    expect(library.db.repo.orphanSearchRows()).toBe(0);
    // The object store is untouched: reclaiming is a separate, reviewable step.
    await expect(readFile(path)).resolves.toBeInstanceOf(Buffer);
  });

  it("parses a smart folder's query before saving it", async () => {
    await expect(createSmartFolder(library, "Broken", "rating:>=", null)).rejects.toBeInstanceOf(
      QueryError,
    );
    await expect(createSmartFolder(library, "  ", "tag:wood", null)).rejects.toBeInstanceOf(
      EmptyNameError,
    );

    const id = await createSmartFolder(library, "Wooden", "tag:wood", null);
    expect(library.db.repo.smartFolders()).toEqual([
      { id, parentId: null, name: "Wooden", query: "tag:wood" },
    ]);
  });

  it("hands a sidebar the query that selects each row", async () => {
    const design = await createFolder(library, "Design", null);
    const icons = await createFolder(library, "Icons", design);
    await addToFolder(library, [hashes[0] as ContentHash], icons);

    const group = await createTagGroup(library, "Material");
    await tagAdd(library, [hashes[1] as ContentHash], ["oak wood"]);
    await setTagGroup(library, ["oak wood"], group);

    const sidebar = readSidebar(library);

    const nested = sidebar.folders.find((folder) => folder.id === icons);
    expect(nested?.path).toBe("Design/Icons");
    // The count is the subtree's, because `folder:` matches the subtree — the
    // number and the query beside it must not disagree.
    expect(sidebar.folders.find((folder) => folder.id === design)?.count).toBe(1);

    const tag = sidebar.tags.find((entry) => entry.name === "oak wood");
    expect(tag?.group).toBe("Material");
    // Quoted by the grammar's own quoter, never by concatenation: the name has
    // a space in it, and a frontend spelling this itself would get it wrong.
    expect(tag?.query).toBe('tag:"oak wood"');
    expect(count(library, tag?.query ?? "")).toBe(1);
    expect(resolveTagGroup(library, "material")).toBe(group);
  });

  it("pages without an offset, and stops at the last short page", async () => {
    const collected: string[] = [];
    for (const page of pages(library, "", 2)) collected.push(...page.map((hit) => hit.hash));

    expect(collected).toHaveLength(3);
    expect(new Set(collected).size).toBe(3);
  });

  it("hides a trashed asset from every query but the one that asks for it", async () => {
    const [first] = hashes as [ContentHash, ContentHash, ContentHash];
    await tagAdd(library, hashes, ["shared"]);
    await rate(library, [first], 5);

    await trashAssets(library, [first]);

    // The listing, the filter, and the rating query all lose it — three
    // different paths into `searchSql`, and the scoping has to be on all of
    // them or "deleted" means "deleted from wherever I happened to look".
    expect(pageOf(library, "", PAGE)).toHaveLength(2);
    expect(count(library, "tag:shared")).toBe(2);
    expect(count(library, "rating:5")).toBe(0);
    // And exactly one query still finds it.
    expect(count(library, "is:trashed")).toBe(1);
  });

  it("keeps everything a trashed asset carried, and gives it all back", async () => {
    // The whole reason trash is a column rather than a `remove` (ADR-0022): the
    // bytes could be imported again, and forty tags applied by hand could not.
    const [first] = hashes as [ContentHash, ContentHash, ContentHash];
    const folder = await createFolder(library, "Moodboards", null);
    await addToFolder(library, [first], folder);
    await tagAdd(library, [first], ["timber"]);
    await rate(library, [first], 4);
    await setNote(library, first, "client approved");

    await trashAssets(library, [first]);
    await restoreAssets(library, [first]);

    expect(library.db.repo.assetDetail(first)).toMatchObject({
      tags: ["timber"],
      folders: ["Moodboards"],
      rating: 4,
      note: "client approved",
      trashedAt: null,
    });
    expect(count(library, "tag:timber")).toBe(1);
  });

  it("counts a folder and a tag by what their query answers with", async () => {
    // A count beside a query has to be the count of that query. The sidebar
    // saying 3 while the grid shows 2 is the version of this that shipped in
    // every implementation that added trash to an existing schema.
    const [first] = hashes as [ContentHash, ContentHash, ContentHash];
    const folder = await createFolder(library, "Moodboards", null);
    await addToFolder(library, hashes, folder);
    await tagAdd(library, hashes, ["shared"]);

    await trashAssets(library, [first]);

    const sidebar = readSidebar(library);
    expect(sidebar.folders.find((row) => row.name === "Moodboards")?.count).toBe(2);
    expect(sidebar.tags.find((row) => row.name === "shared")?.count).toBe(2);
    expect(sidebar.places.find((place) => place.id === "trash")?.count).toBe(1);
  });

  it("empties the trash by removing exactly what is in it", async () => {
    const [first, second] = hashes as [ContentHash, ContentHash, ContentHash];
    await trashAssets(library, [first, second]);
    await restoreAssets(library, [second]);

    expect(await emptyTrash(library)).toBe(1);
    expect(library.stats().assets).toBe(2);
    expect(count(library, "is:trashed")).toBe(0);
    // Restoring did not merely hide the second one from Trash: it is still a
    // row, and emptying must not have taken it.
    expect(library.db.repo.assetDetail(second)).toBeDefined();
    // The bytes stay for a deliberate `doctor --reclaim`, as `remove` always has.
    expect(library.db.repo.orphanSearchRows()).toBe(0);
  });

  it("re-stamps rather than refusing when something is trashed twice", async () => {
    const [first] = hashes as [ContentHash, ContentHash, ContentHash];
    await trashAssets(library, [first]);
    const firstTime = library.db.repo.trashedAt(first);
    expect(typeof firstTime).toBe("number");

    await restoreAssets(library, [first]);
    expect(library.db.repo.trashedAt(first)).toBeNull();

    await trashAssets(library, [first]);
    expect(typeof library.db.repo.trashedAt(first)).toBe("number");
  });

  it("keeps a comment at the moment it was left at", async () => {
    const hash = hashes[0] as ContentHash;
    const id = await addComment(library, hash, 91_500, "the cut lands early");
    expect(comments(library, hash)).toEqual([
      {
        id,
        hash,
        atMs: 91_500,
        body: "the cut lands early",
        createdAt: expect.any(Number),
        updatedAt: null,
      },
    ]);
  });

  it("takes a comment about the asset rather than about a moment in it", async () => {
    // The null is what lets an asset with no timeline carry comments at all,
    // which is why this table is not video-only (ADR-0023).
    const hash = hashes[0] as ContentHash;
    await addComment(library, hash, null, "no timeline here");
    expect(comments(library, hash)[0]?.atMs).toBeNull();
  });

  it("lists timed comments in timeline order and untimed ones last", async () => {
    const hash = hashes[0] as ContentHash;
    await addComment(library, hash, null, "about the whole thing");
    await addComment(library, hash, 5_000, "later");
    await addComment(library, hash, 1_000, "earlier");
    expect(comments(library, hash).map((c) => c.body)).toEqual([
      "earlier",
      "later",
      "about the whole thing",
    ]);
  });

  it("edits a comment in place, keeping its id and its place in the list", async () => {
    // Remove-and-re-add would move it to the end of a list ordered by creation,
    // and somebody who fixed a typo did not ask for that.
    const hash = hashes[0] as ContentHash;
    const first = await addComment(library, hash, 1_000, "first");
    await addComment(library, hash, 2_000, "second");

    await setComment(library, first, 1_000, "first, corrected");
    const listed = comments(library, hash);
    expect(listed.map((c) => c.body)).toEqual(["first, corrected", "second"]);
    expect(listed[0]?.id).toBe(first);
    expect(listed[0]?.updatedAt).toEqual(expect.any(Number));
  });

  it("moves a comment to another moment without losing it", async () => {
    const hash = hashes[0] as ContentHash;
    const id = await addComment(library, hash, 1_000, "here");
    await setComment(library, id, 9_000, "here");
    expect(comments(library, hash)[0]?.atMs).toBe(9_000);
  });

  it("removes a comment, and refuses to touch one that is gone", async () => {
    const hash = hashes[0] as ContentHash;
    const id = await addComment(library, hash, 1_000, "temporary");
    await removeComment(library, id);
    expect(comments(library, hash)).toEqual([]);
    await expect(removeComment(library, id)).rejects.toBeInstanceOf(UnknownCommentError);
    await expect(setComment(library, id, null, "back")).rejects.toBeInstanceOf(UnknownCommentError);
  });

  it("refuses an empty body rather than deleting the comment", async () => {
    // Emptying the box and removing the comment are different intentions, and
    // only one of them can be undone by typing again.
    const hash = hashes[0] as ContentHash;
    await expect(addComment(library, hash, 0, "   ")).rejects.toBeInstanceOf(EmptyCommentError);
    const id = await addComment(library, hash, 0, "real");
    await expect(setComment(library, id, 0, "")).rejects.toBeInstanceOf(EmptyCommentError);
    expect(comments(library, hash)).toHaveLength(1);
  });

  it("refuses a moment that is not one", async () => {
    const hash = hashes[0] as ContentHash;
    await expect(addComment(library, hash, -1, "before the start")).rejects.toBeInstanceOf(
      InvalidMomentError,
    );
    await expect(addComment(library, hash, 1.5, "half a millisecond")).rejects.toBeInstanceOf(
      InvalidMomentError,
    );
  });

  it("refuses a comment on an asset the library does not hold", async () => {
    await expect(
      addComment(library, "f".repeat(64) as ContentHash, 0, "ghost"),
    ).rejects.toBeInstanceOf(UnknownAssetError);
  });

  it("journals every comment before indexing it", async () => {
    // Invariant 9, stated the way this suite states it above: a row with no
    // journal line is data loss the next rebuild would reveal.
    const hash = hashes[0] as ContentHash;
    const id = await addComment(library, hash, 91_500, "the cut lands early");
    await setComment(library, id, 91_000, "two frames early");
    await removeComment(library, id);

    const ours = (await journalLines()).filter((line) => String(line.op).startsWith("comment_"));
    expect(ours.map((line) => line.op)).toEqual(["comment_add", "comment_set", "comment_remove"]);
    // Milliseconds in `at`, seconds in `ts`: two different clocks, kept apart
    // by name so neither can be read as the other (ADR-0023).
    expect(ours[0]).toMatchObject({ id, hash, at: 91_500, body: "the cut lands early" });
    expect(ours[1]).toMatchObject({ id, at: 91_000 });
    expect(ours[2]).toEqual({ ts: expect.any(Number), op: "comment_remove", id });
  });

  it("keeps comments through the trash and takes them on a remove", async () => {
    const kept = hashes[0] as ContentHash;
    const doomed = hashes[1] as ContentHash;
    await addComment(library, kept, 1_000, "survives");
    await addComment(library, doomed, 1_000, "goes with it");

    await trashAssets(library, [kept]);
    expect(comments(library, kept)).toHaveLength(1);
    await restoreAssets(library, [kept]);
    expect(comments(library, kept)).toHaveLength(1);

    // `remove` deletes the row, and the foreign key takes the comments with it
    // — the same cascade tags and folder memberships already ride on.
    await removeAssets(library, [doomed]);
    expect(library.stats().comments).toBe(1);
  });

  /**
   * A file the format table calls a video.
   *
   * The bytes are not one, and nothing here decodes them: `setPoster` decides
   * what an asset *is* from the format table, the same table the window's
   * inspector uses, so a `.mp4` is a video whether or not ffmpeg is installed
   * on the machine running this suite.
   */
  const importVideo = async (name = "clip.mp4"): Promise<ContentHash> => {
    const source = join(dir, "video");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, name), `not really a video: ${name}`);
    await importInto(library, [join(source, name)]);
    const found = library.db.repo
      .allHashes()
      .find((hash) => library.db.repo.findAsset(hash)?.origName === name);
    if (found === undefined) throw new Error("the video did not import");
    return found;
  };

  it("pins a thumbnail to a moment, and journals where to look rather than the picture", async () => {
    const hash = await importVideo();
    expect(await setPoster(library, hash, 91_500)).toBe(true);
    expect(poster(library, hash)).toBe(91_500);

    const ours = (await journalLines()).filter((line) => line.op === "poster_set");
    expect(ours).toEqual([{ ts: expect.any(Number), op: "poster_set", hash, at: 91_500 }]);
    // The instruction, never the pixels: a journal carrying an image would be
    // base64 in a text file, which the forbidden-patterns list refuses twice.
    expect(JSON.stringify(ours[0])).not.toMatch(/data:|base64/);
  });

  it("clears back to the default frame with the same op", async () => {
    const hash = await importVideo();
    await setPoster(library, hash, 91_500);
    expect(await setPoster(library, hash, null)).toBe(true);
    expect(poster(library, hash)).toBeNull();

    const ours = (await journalLines()).filter((line) => line.op === "poster_set");
    expect(ours.map((line) => line.at)).toEqual([91_500, null]);
  });

  it("writes nothing when the thumbnail is already where it is being put", async () => {
    // An append-only file is read by people, and a line that changes nothing is
    // a line they have to rule out.
    const hash = await importVideo();
    await setPoster(library, hash, 91_500);
    expect(await setPoster(library, hash, 91_500)).toBe(false);

    const ours = (await journalLines()).filter((line) => line.op === "poster_set");
    expect(ours).toHaveLength(1);
  });

  it("clears nothing when the thumbnail is already on the default frame", async () => {
    const hash = await importVideo();
    expect(await setPoster(library, hash, null)).toBe(false);
    expect((await journalLines()).filter((line) => line.op === "poster_set")).toEqual([]);
  });

  it("drops the preview it can no longer draw, and queues what it could not redraw", async () => {
    const hash = await importVideo();
    library.db.repo.putThumbnail(hash, GRID_SIZE, 8, 8, Buffer.from("grid"));
    library.db.repo.putThumbnail(hash, PREVIEW_SIZE, 8, 8, Buffer.from("preview"));

    await setPoster(library, hash, 91_500);

    // The bytes here are not a video, so the immediate redraw fails — which is
    // also what a machine without ffmpeg looks like. The preview size is made
    // on first use and never revisited, so leaving one behind would let it
    // outlive the frame it was drawn from; the grid size stays until something
    // replaces it, because a cell that goes blank is worse than one that is a
    // quarter of a second stale.
    expect(library.db.repo.thumbnail(hash, PREVIEW_SIZE)).toBeUndefined();
    expect(library.db.repo.thumbnail(hash, GRID_SIZE)).toBeDefined();
    // Queued, so the picture arrives whenever it can rather than not at all.
    expect(queueStatus(library).ready).toBeGreaterThan(0);
  });

  it("refuses a thumbnail moment on something with no frames", async () => {
    // Audio has no picture to take and a document already has a page. A
    // journal line that means nothing is one a later build has to keep
    // understanding.
    await expect(setPoster(library, hashes[0] as ContentHash, 1_000)).rejects.toBeInstanceOf(
      NotAVideoError,
    );
    expect((await journalLines()).filter((line) => line.op === "poster_set")).toEqual([]);
  });

  it("refuses a negative moment, as a comment's does", async () => {
    const hash = await importVideo();
    await expect(setPoster(library, hash, -1)).rejects.toBeInstanceOf(InvalidMomentError);
  });

  it("rebuilds to the same library after every kind of edit", async () => {
    // The strongest statement this suite makes: if any edit above reached the
    // index without reaching the journal, the rebuilt index would differ here.
    const design = await createFolder(library, "Design", null);
    const icons = await createFolder(library, "Icons", design);
    await addToFolder(library, [hashes[0] as ContentHash], icons);
    await moveFolder(library, icons, null);

    const group = await createTagGroup(library, "Material");
    await tagAdd(library, hashes, ["wood"]);
    await setTagGroup(library, ["wood"], group);
    await tagRename(library, "wood", "timber");
    await rate(library, [hashes[0] as ContentHash], 5);
    await apply(library, [{ op: "favorite_set", hash: hashes[1] as ContentHash, favorite: true }]);
    await setNote(library, hashes[2] as ContentHash, "a note");
    const comment = await addComment(library, hashes[0] as ContentHash, 91_500, "a comment");
    await setComment(library, comment, 91_000, "an edited comment");
    await addComment(library, hashes[0] as ContentHash, null, "and one about the asset");
    const doomedComment = await addComment(library, hashes[0] as ContentHash, 1, "removed again");
    await removeComment(library, doomedComment);
    await renameAsset(library, hashes[2] as ContentHash, "renamed.jpg");
    const clip = await importVideo("pinned.mp4");
    await setPoster(library, clip, 91_500);
    await createSmartFolder(library, "Five stars", "rating:5", null);
    await removeAssets(library, [hashes[1] as ContentHash]);
    await trashAssets(library, [hashes[2] as ContentHash]);
    await trashAssets(library, [hashes[0] as ContentHash]);
    await restoreAssets(library, [hashes[0] as ContentHash]);

    const before = withoutDerived(library.stats());
    const found = names(search(library, "tag:timber", PAGE));

    await library.rebuild();

    expect(withoutDerived(library.stats())).toEqual(before);
    expect(names(search(library, "tag:timber", PAGE))).toEqual(found);
    expect(count(library, "rating:5")).toBe(1);
    // `renamed.jpg` is the asset that was trashed, so the query that found it
    // before the rebuild must still find nothing after one — a `trash` that
    // replayed as a no-op would pass every other assertion here.
    expect(count(library, "renamed")).toBe(0);
    expect(count(library, "is:trashed")).toBe(1);
    // Comments come back with their moments, their edits, and their absences:
    // the removed one must not reappear, and the edited one must not revert.
    expect(comments(library, hashes[0] as ContentHash).map((c) => [c.atMs, c.body])).toEqual([
      [91_000, "an edited comment"],
      [null, "and one about the asset"],
    ]);
    // The poster comes back as an instruction, which is the whole of stage 4:
    // the journal said where to look and the derive pass is what looks.
    expect(poster(library, clip)).toBe(91_500);
    // The prose index is derived like everything else (ADR-0027): a comment
    // that replayed into `asset_comments` but never reached `assets_fts` would
    // leave search quietly poorer than the library it describes.
    expect(count(library, "edited")).toBe(1);
    expect(count(library, "removed again")).toBe(0);
    expect(library.db.repo.orphanSearchRows()).toBe(0);
  });

  describe("searching the prose (ADR-0027)", () => {
    // The two places somebody writes a sentence rather than a label. Before
    // migration 0012 the index held only the filename and the tags, so what a
    // person actually wrote was the one thing search could not find.

    it("finds an asset by a word in its note", async () => {
      await setNote(library, hashes[0] as ContentHash, "needs a reshoot before the deadline");

      expect(count(library, "reshoot")).toBe(1);
      // Typed, not composed: bare words are already free-text terms, so the
      // whole feature is reached without syntax (ADR-0027 §2).
      expect(count(library, "needs a reshoot")).toBe(1);
    });

    it("finds an asset by a word in a comment, and stops when the comment goes", async () => {
      const id = await addComment(library, hashes[1] as ContentHash, 4200, "the grade is too warm");

      expect(count(library, "grade")).toBe(1);

      await removeComment(library, id);
      expect(count(library, "grade")).toBe(0);
    });

    it("follows an edit rather than keeping what was written first", async () => {
      await setNote(library, hashes[0] as ContentHash, "provisional");
      const id = await addComment(library, hashes[0] as ContentHash, null, "ask marketing");

      await setNote(library, hashes[0] as ContentHash, "approved");
      await setComment(library, id, null, "marketing approved it");

      expect(count(library, "provisional")).toBe(0);
      expect(count(library, "ask")).toBe(0);
      expect(count(library, "approved")).toBe(1);
    });

    it("keeps the name and the tags searchable beside them", async () => {
      // The table was dropped and rebuilt by the migration, so the two columns
      // that were already there are worth asserting are still there.
      await tagAdd(library, [hashes[2] as ContentHash], ["mahogany"]);

      expect(count(library, "gamma")).toBe(1);
      expect(count(library, "mahogany")).toBe(1);
    });

    it("clears the note from the index when the note is cleared", async () => {
      await setNote(library, hashes[0] as ContentHash, "temporary");
      await setNote(library, hashes[0] as ContentHash, null);

      expect(count(library, "temporary")).toBe(0);
    });
  });
});
