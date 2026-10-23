import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssetId,
  DEFAULT_PAGE_LIMIT,
  IndexSink,
  lastCursor,
  withoutDerived,
} from "@roost/core";
import {
  AmbiguousFolderNameError,
  addComment,
  addToFolder,
  apply,
  comments,
  count,
  createFolder,
  createSmartFolder,
  createTag,
  createTagGroup,
  DuplicateFolderNameError,
  DuplicateTagError,
  DuplicateTagGroupNameError,
  deleteFolder,
  deleteTags,
  EmptyCommentError,
  EmptyNameError,
  emptyTrash,
  FolderCycleError,
  findFolders,
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
  readFacetVocabulary,
  readSidebar,
  removeAssets,
  removeComment,
  renameAsset,
  renameFolder,
  renameTagGroup,
  resolveAsset,
  resolveFolder,
  resolveTagGroup,
  restoreAssets,
  search,
  sectionedPage,
  setComment,
  setNote,
  setPoster,
  setSource,
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
  let ids: AssetId[];

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
    ids = library.db.repo.allIds();
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  const names = (hits: readonly { name: string }[]): string[] => hits.map((hit) => hit.name).sort();

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
    await tagAdd(library, [ids[0] as AssetId], ["wood"]);
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
    await tagAdd(library, ids, ["shared"]);
    await tagAdd(library, [ids[0] as AssetId], ["only-one"]);

    expect(count(library, "tag:shared")).toBe(3);
    expect(count(library, "tag:only-one")).toBe(1);
    expect(count(library, "tag:shared -tag:only-one")).toBe(2);

    await tagRemove(library, [ids[0] as AssetId], ["only-one"]);
    expect(count(library, "tag:only-one")).toBe(0);
  });

  it("deletes a tag from every asset and from the library (ADR-0061)", async () => {
    await tagAdd(library, ids, ["draft"]);
    await tagAdd(library, [ids[0] as AssetId], ["keep"]);
    expect(count(library, "draft")).toBe(3);

    // In another case, because a tag's name compares that way.
    await deleteTags(library, ["DRAFT"]);
    expect(count(library, "tag:draft")).toBe(0);
    expect(library.db.repo.hasTag("draft")).toBe(false);
    // The words a search finds go with it: a tag is part of an asset's text.
    expect(count(library, "draft")).toBe(0);
    expect(count(library, "tag:keep")).toBe(1);
    // One line, however many assets carried it.
    const lines = (await journalLines()).filter((line) => line.op === "tag_delete");
    expect(lines.map((line) => line.tag)).toEqual(["DRAFT"]);
    // A name nobody has is nothing to delete, not a fault.
    await deleteTags(library, ["never-was"]);
  });

  it("makes a tag nothing carries yet, and refuses one the library has", async () => {
    const group = await createTagGroup(library, "Material");
    await createTag(library, "linen", group);
    await createTag(library, "loose", null);
    expect(library.db.repo.tags().map((tag) => [tag.name, tag.count, tag.group])).toEqual([
      ["linen", 0, "Material"],
      ["loose", 0, null],
    ]);
    await expect(createTag(library, "LINEN", null)).rejects.toBeInstanceOf(DuplicateTagError);
  });

  it("refuses a tag group name another group has, before it is journalled (ADR-0061)", async () => {
    // Found on 2026-10-24: the line was journalled, the index refused it on its
    // UNIQUE name, and the next group was handed the refused group's id.
    const material = await createTagGroup(library, "Material");
    await expect(createTagGroup(library, "material")).rejects.toBeInstanceOf(
      DuplicateTagGroupNameError,
    );
    const other = await createTagGroup(library, "Other");
    await expect(renameTagGroup(library, other, "MATERIAL")).rejects.toBeInstanceOf(
      DuplicateTagGroupNameError,
    );
    // Its own name in another case is a rename, not a clash.
    await renameTagGroup(library, material, "MATERIAL");
    expect(other).toBe(material + 1);
    const created = (await journalLines()).filter((line) => line.op === "tag_group_create");
    expect(created.map((line) => line.id)).toEqual([material, other]);
  });

  it("rebuilds a journal that already holds two groups of one name (ADR-0061)", async () => {
    // What the bug above left behind, written straight into the journal: the
    // index has to take it, or every rebuild of that library stops here.
    await apply(library, [
      { op: "tag_group_create", id: 1, name: "Material" },
      { op: "tag_group_create", id: 2, name: "material" },
      { op: "tag_group_set", tag: "wood", group: 2 },
    ]);
    await library.rebuild();
    expect(library.db.repo.tagGroups().map((group) => [group.id, group.name])).toEqual([
      [1, "Material"],
      [2, "material"],
    ]);
    expect(library.db.repo.tags()).toEqual([{ name: "wood", count: 0, group: "material" }]);
  });

  it("merges a rename onto an existing tag rather than failing", async () => {
    await tagAdd(library, [ids[0] as AssetId], ["draft"]);
    await tagAdd(library, [ids[1] as AssetId], ["wip"]);

    await tagRename(library, "draft", "wip");

    expect(count(library, "tag:wip")).toBe(2);
    expect(count(library, "tag:draft")).toBe(0);
  });

  it("matches a folder and everything beneath it", async () => {
    const design = await createFolder(library, "Design", null);
    const icons = await createFolder(library, "Icons", design);

    await addToFolder(library, [ids[0] as AssetId], design);
    await addToFolder(library, [ids[1] as AssetId], icons);

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

  it("refuses a name a sibling already has", async () => {
    // Reported from a real pane on 2026-09-08: a subfolder made twice under one
    // folder, and the tree drew both. `findFolderByPath` walks a path one
    // segment at a time and takes the first row each segment matches, so the
    // second one was unreachable by `folder:` from the moment it existed.
    const archive = await createFolder(library, "Archive", null);
    await createFolder(library, "logos", archive);

    await expect(createFolder(library, "logos", archive)).rejects.toBeInstanceOf(
      DuplicateFolderNameError,
    );
    // Named, because the message reaches a dialog: a sentence about rowids is
    // one nobody can act on.
    await expect(createFolder(library, "logos", archive)).rejects.toThrow(
      'A folder called "logos" is already in "Archive"',
    );

    // Without regard to case, which is the house rule for every user-authored
    // name here — the Eagle importer reuses a folder by a lowercased key and
    // tags merge the same way. Two rows a pane cannot tell apart are refused
    // even where both would be addressable.
    await expect(createFolder(library, "LOGOS", archive)).rejects.toBeInstanceOf(
      DuplicateFolderNameError,
    );

    // The top level is a place like any other, and says so in its own words.
    await createFolder(library, "Clients", null);
    await expect(createFolder(library, "clients", null)).rejects.toThrow(
      'A folder called "clients" is already at the top level',
    );

    // Siblings only. The same name under two parents is what a tree is for.
    const clients = library.db.repo.folders().find((row) => row.name === "Clients")?.id ?? 0;
    await expect(createFolder(library, "logos", clients)).resolves.toBeTypeOf("number");
  });

  it("refuses a rename and a move onto a name a sibling already has", async () => {
    const archive = await createFolder(library, "Archive", null);
    const logos = await createFolder(library, "logos", archive);
    const drafts = await createFolder(library, "drafts", archive);
    const clients = await createFolder(library, "Clients", null);
    const stray = await createFolder(library, "logos", clients);

    await expect(renameFolder(library, drafts, "Logos")).rejects.toBeInstanceOf(
      DuplicateFolderNameError,
    );
    // A folder is not its own sibling: renaming one to the case it already has
    // has to stay a thing that works.
    await expect(renameFolder(library, logos, "Logos")).resolves.toBeUndefined();

    // A move carries the name into a place that may already hold it, and is
    // refused rather than quietly renamed.
    await expect(moveFolder(library, stray, archive)).rejects.toBeInstanceOf(
      DuplicateFolderNameError,
    );
    expect(library.db.repo.folder(stray)?.parentId).toBe(clients);
  });

  it("still replays a folder name an older library recorded", async () => {
    // The rule binds names as they are authored, not as they are read. A
    // library written before it — or by the Rust implementation — must still
    // rebuild, so the sink and replay do not check.
    const sink = new IndexSink(library.db);
    library.db.transaction(() => {
      sink.apply({ ts: 1, op: "folder_create", id: 900, parent: null, name: "Design/Icons" });
      // And a sibling pair the authoring rule would now refuse. A library that
      // already holds one — this one did, before 2026-09-08 — must still
      // rebuild, or the rule would have destroyed the thing it protects.
      sink.apply({ ts: 2, op: "folder_create", id: 901, parent: null, name: "Twice" });
      sink.apply({ ts: 3, op: "folder_create", id: 902, parent: null, name: "Twice" });
    });
    expect(library.db.repo.folders().some((row) => row.name === "Design/Icons")).toBe(true);
    expect(library.db.repo.folders().filter((row) => row.name === "Twice").length).toBe(2);
  });

  it("refuses to move a folder into its own subtree", async () => {
    const design = await createFolder(library, "Design", null);
    const icons = await createFolder(library, "Icons", design);

    await expect(moveFolder(library, design, icons)).rejects.toBeInstanceOf(FolderCycleError);
    // Named rather than numbered: the message reaches a window now, and a
    // sentence about rowids is one nobody can act on (ADR-0033 §5).
    await expect(moveFolder(library, design, icons)).rejects.toThrow(
      "Design cannot be moved into Icons",
    );
    expect(library.db.repo.folder(design)?.parentId).toBe(null);
  });

  it("keeps the assets when a folder is deleted", async () => {
    const folder = await createFolder(library, "Temporary", null);
    await addToFolder(library, ids, folder);
    expect(count(library, "folder:Temporary")).toBe(3);

    await deleteFolder(library, folder);

    expect(library.stats().assets).toBe(3);
    expect(() => resolveFolder(library, "Temporary")).toThrow(UnknownFolderPathError);
  });

  /**
   * Where a file came from (ADR-0030).
   *
   * The note's rules, and one it deliberately does not have: **nothing is
   * validated**. A bare hostname is as good an answer to "where did this come
   * from" as a full address, and refusing it would be the library arguing with
   * the user about what provenance is. Whether a value is offered as a link is
   * decided from its scheme where it is shown, not here.
   */
  it("stores a source as typed, and clears it on a blank", async () => {
    const asset = ids[0] as AssetId;

    await setSource(library, [asset], "  instagram.com/p/xyz  ");
    expect(library.db.repo.assetDetail(asset)?.sourceUrl).toBe("instagram.com/p/xyz");

    await setSource(library, [asset], "   ");
    expect(library.db.repo.assetDetail(asset)?.sourceUrl).toBe(null);

    // And it survives losing the index, because it is a journal line first
    // (invariant 9) — the whole reason it is an op rather than a column write.
    await setSource(library, [asset], "https://example.com/a");
    await library.rebuild();
    expect(library.db.repo.assetDetail(asset)?.sourceUrl).toBe("https://example.com/a");
  });

  it("rates, notes, and still finds a favourite, and refuses a rating the schema has no room for", async () => {
    await rate(library, [ids[0] as AssetId], 4);
    // Journalled directly: nothing authors a favourite any more (ADR-0029), but
    // `is:favorite` stays in the grammar, because a smart folder that says it
    // must still parse — so what a library already holds is still findable.
    await apply(library, [{ op: "favorite_set", asset: ids[1] as AssetId, favorite: true }]);
    await setNote(library, [ids[2] as AssetId], "  needs a crop  ");

    expect(count(library, "rating:>=4")).toBe(1);
    expect(count(library, "is:favorite")).toBe(1);
    expect(count(library, "is:unrated")).toBe(2);
    expect(library.db.repo.assetDetail(ids[2] as AssetId)?.note).toBe("needs a crop");

    await expect(rate(library, [ids[0] as AssetId], 9)).rejects.toBeInstanceOf(InvalidRatingError);
    // A note of nothing but whitespace clears the note rather than storing one,
    // which would show as an empty badge on the asset forever.
    await setNote(library, [ids[2] as AssetId], "   ");
    expect(library.db.repo.assetDetail(ids[2] as AssetId)?.note).toBe(null);
  });

  it("writes one note and one source across several assets, a line each (ADR-0048)", async () => {
    const three = ids.slice(0, 3) as AssetId[];
    await setNote(library, three, "  for the client  ");
    await setSource(library, three, "https://example.com/post");

    for (const id of three) {
      expect(library.db.repo.assetDetail(id)).toMatchObject({
        note: "for the client",
        sourceUrl: "https://example.com/post",
      });
    }
    // No new operation: the registry's own `note_set` and `source_set`, one per
    // asset, so another implementation reads them already (ADR-0045).
    const lines = await journalLines();
    expect(lines.filter((line) => line.op === "note_set")).toHaveLength(3);
    expect(lines.filter((line) => line.op === "source_set")).toHaveLength(3);
  });

  it("renames what the library shows, and the full-text index with it", async () => {
    // Found by name rather than by position: `allIds()` is ordered by id,
    // which says nothing about which file it came from.
    const alpha = search(library, "alpha", PAGE)[0]?.id as AssetId;
    const id = resolveAsset(library, alpha.slice(0, 8));
    await renameAsset(library, id, "renamed-on-purpose");

    // The name carries no extension (RL-33), and renaming touches no file: the
    // one on disk is named by the id and cannot need to move.
    expect(names(search(library, "renamed-on-purpose", PAGE))).toEqual(["renamed-on-purpose"]);
    expect(search(library, "alpha", PAGE)).toHaveLength(0);
    expect(library.db.repo.assetDetail(id)?.ext).toBe("png");
  });

  it("resolves a prefix, and refuses one that names nothing", () => {
    expect(resolveAsset(library, (ids[0] as string).slice(0, 10))).toBe(ids[0]);
    // A prefix of the right shape that matches nothing, and one that is not an
    // id at all, are the same mistake reported the same way.
    expect(() => resolveAsset(library, "ZZZZZZZZZZ")).toThrow(UnknownAssetError);
    expect(() => resolveAsset(library, "not-an-id")).toThrow(UnknownAssetError);
  });

  it("removes the row and deletes the bytes it owned", async () => {
    const asset = ids[0] as AssetId;
    const detail = library.db.repo.assetDetail(asset);
    const path = library.storage.locate(asset, detail?.ext ?? "");

    const removal = await removeAssets(library, [asset]);

    expect(library.stats().assets).toBe(2);
    expect(library.db.repo.orphanSearchRows()).toBe(0);
    // ADR-0031. Until 2026-09-06 the object stayed here until somebody ran
    // `doctor --reclaim`, so "Delete permanently" left the disk exactly as full
    // as it found it.
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(removal).toEqual({ assets: 1, bytes: detail?.size });
  });

  it("leaves the file it copied from where the person left it", async () => {
    // Version 1 had a second storage mode and a rule about never writing into
    // a user's directory; version 2 has one mode (RL-19) and the rule it keeps
    // is RL-26's — a copy leaves the source alone, and the report says which.
    const outside = join(dir, "outside");
    await mkdir(outside, { recursive: true });
    const path = join(outside, "kept.bin");
    await writeFile(path, "payload");

    const report = await importInto(library, [outside], { take: "copy" });
    expect(report).toMatchObject({ imported: 1, copied: 1, moved: 0 });

    const id = library.db.repo.allIds().find((one) => !ids.includes(one)) as AssetId;
    await removeAssets(library, [id]);
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
    await addToFolder(library, [ids[0] as AssetId], icons);

    const group = await createTagGroup(library, "Material");
    await tagAdd(library, [ids[1] as AssetId], ["oak wood"]);
    await setTagGroup(library, ["oak wood"], group);

    const sidebar = readSidebar(library);

    const nested = sidebar.folders.find((folder) => folder.id === icons);
    expect(nested?.path).toBe("Design/Icons");

    // *Show subfolder contents* decides the term a row asks with (ADR-0036).
    // Off by default: `Design` asks with `infolder:` and holds nothing
    // directly — and **its count is still its subtree's**, which is what a
    // folder holds rather than what its query draws (§3.3, amended 2026-10-01).
    const shallow = sidebar.folders.find((folder) => folder.id === design);
    expect(shallow?.query).toBe("infolder:Design");
    expect(count(library, shallow?.query ?? "")).toBe(0);
    expect(shallow?.count).toBe(1);

    await library.updateSettings({ showSubfolderContents: true });
    const deep = readSidebar(library).folders.find((folder) => folder.id === design);
    expect(deep?.query).toBe("folder:Design");
    expect(deep?.count).toBe(1);
    expect(count(library, deep?.query ?? "")).toBe(1);

    const tag = sidebar.tags.find((entry) => entry.name === "oak wood");
    expect(tag?.group).toBe("Material");
    // Quoted by the grammar's own quoter, never by concatenation: the name has
    // a space in it, and a frontend spelling this itself would get it wrong.
    expect(tag?.query).toBe('tag:"oak wood"');
    expect(count(library, tag?.query ?? "")).toBe(1);
    expect(resolveTagGroup(library, "material")).toBe(group);
  });

  it("orders the folders as a tree, not as one alphabetical run", async () => {
    // `repo.folders()` sorts by name, and nothing sets `sort_order` — so a
    // plain listing puts `Archive` between `Design` and its own `Icons`, which
    // indented reads as a tree while being none. The sidebar drew exactly that
    // until 2026-09-06.
    const design = await createFolder(library, "Design", null);
    await createFolder(library, "Icons", design);
    await createFolder(library, "Archive", null);

    expect(readSidebar(library).folders.map((folder) => folder.path)).toEqual([
      "Archive",
      "Design",
      "Design/Icons",
    ]);
  });

  it("deletes a folder without touching its assets, and with them when asked", async () => {
    // ADR-0033. The default is the shelf, not what was on it.
    const keep = await createFolder(library, "Keep", null);
    const inner = await createFolder(library, "Inner", keep);
    await addToFolder(library, [ids[0] as AssetId], inner);

    expect(await deleteFolder(library, keep)).toEqual({ trashed: 0 });
    expect(library.db.repo.assetDetail(ids[0] as AssetId)?.trashedAt).toBeNull();
    expect(library.db.repo.assetDetail(ids[0] as AssetId)?.folders).toEqual([]);

    const gone = await createFolder(library, "Gone", null);
    const under = await createFolder(library, "Under", gone);
    // One asset in the folder and one in its child, and one of them in both:
    // the subtree goes, and nothing is journalled twice.
    await addToFolder(library, [ids[0] as AssetId], gone);
    await addToFolder(library, [ids[0] as AssetId, ids[1] as AssetId], under);

    expect(await deleteFolder(library, gone, { trashContents: true })).toEqual({ trashed: 2 });
    expect(library.db.repo.assetDetail(ids[0] as AssetId)?.trashedAt).not.toBeNull();
    expect(library.db.repo.assetDetail(ids[1] as AssetId)?.trashedAt).not.toBeNull();
    // Trashed, not removed: the rows are still there to be restored.
    expect(library.db.repo.stats().assets).toBe(ids.length);
  });

  it("pages without an offset, and stops at the last short page", async () => {
    const collected: string[] = [];
    for (const page of pages(library, "", 2)) collected.push(...page.map((hit) => hit.id));

    expect(collected).toHaveLength(3);
    expect(new Set(collected).size).toBe(3);
  });

  it("hides a trashed asset from every query but the one that asks for it", async () => {
    const [first] = ids as [AssetId, AssetId, AssetId];
    await tagAdd(library, ids, ["shared"]);
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
    const [first] = ids as [AssetId, AssetId, AssetId];
    const folder = await createFolder(library, "Moodboards", null);
    await addToFolder(library, [first], folder);
    await tagAdd(library, [first], ["timber"]);
    await rate(library, [first], 4);
    await setNote(library, [first], "client approved");

    await trashAssets(library, [first]);
    await restoreAssets(library, [first]);

    expect(library.db.repo.assetDetail(first)).toMatchObject({
      tags: ["timber"],
      folders: [{ id: 1, path: "Moodboards" }],
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
    const [first] = ids as [AssetId, AssetId, AssetId];
    const folder = await createFolder(library, "Moodboards", null);
    await addToFolder(library, ids, folder);
    await tagAdd(library, ids, ["shared"]);
    await tagAdd(library, [first], ["solo"]);

    await trashAssets(library, [first]);

    const sidebar = readSidebar(library);
    expect(sidebar.folders.find((row) => row.name === "Moodboards")?.count).toBe(2);
    expect(sidebar.tags.find((row) => row.name === "shared")?.count).toBe(2);
    // Every asset it is on is in the trash, and the tag is still a tag.
    expect(sidebar.tags.find((row) => row.name === "solo")?.count).toBe(0);
    expect(sidebar.places.find((place) => place.id === "trash")?.count).toBe(1);
  });

  it("counts an asset in two folders of one subtree once", async () => {
    // `folder:Design` finds it once, so the row beside it says one. The counts
    // were summed per folder until 2026-10-01, and said two.
    const [first, second, third] = ids as [AssetId, AssetId, AssetId];
    const design = await createFolder(library, "Design", null);
    const icons = await createFolder(library, "Icons", design);
    const logos = await createFolder(library, "Logos", design);
    await addToFolder(library, [first, second], design);
    await addToFolder(library, [first], icons);
    await addToFolder(library, [first, third], logos);
    await trashAssets(library, [second]);

    const counts = new Map(readSidebar(library).folders.map((row) => [row.name, row.count]));
    expect(counts.get("Design")).toBe(2);
    expect(count(library, "folder:Design")).toBe(2);
    expect(counts.get("Icons")).toBe(1);
    expect(counts.get("Logos")).toBe(2);

    // Trashed, it leaves every row it was counted in, however many that is.
    await trashAssets(library, [first]);
    const after = new Map(readSidebar(library).folders.map((row) => [row.name, row.count]));
    expect([after.get("Design"), after.get("Icons"), after.get("Logos")]).toEqual([1, 0, 1]);
  });

  it("lists what a folder holds in the filter bar's menus, counted there (ADR-0035 §8)", async () => {
    // By name: `allIds()` is ordered by id, which says nothing about the file.
    const named = (name: string) => search(library, name, PAGE)[0]?.id as AssetId;
    const [alpha, beta, gamma] = [named("alpha"), named("beta"), named("gamma")];
    const design = await createFolder(library, "Design", null);
    const icons = await createFolder(library, "Icons", design);
    await addToFolder(library, [alpha, beta], design);
    await addToFolder(library, [alpha, gamma], icons);
    await tagAdd(library, [alpha, beta], ["wood"]);
    await tagAdd(library, [gamma], ["glass"]);
    await trashAssets(library, [beta]);

    const vocabulary = (place: string) => {
      const read = readFacetVocabulary(library, place);
      return read === null
        ? null
        : {
            tags: read.tags?.map((tag) => [tag.name, tag.count]),
            types: read.types?.map((type) => [type.ext, type.count]),
          };
    };

    // The folder alone: beta is in the trash, so wood is alpha's alone, and a
    // tag none of its assets carries is not offered.
    expect(vocabulary("infolder:Design")).toEqual({ tags: [["wood", 1]], types: [["png", 1]] });
    // With its subfolder, alpha counted once although it is in both.
    expect(vocabulary("folder:Design")).toEqual({
      tags: [
        ["glass", 1],
        ["wood", 1],
      ],
      types: [
        ["jpg", 1],
        ["png", 1],
      ],
    });
    expect(vocabulary("infolder:Design/Icons")).toEqual(vocabulary("infolder:Icons"));

    // Any other place keeps the library's vocabulary, which the sidebar carries.
    for (const place of ["", "tag:wood", "folder:Design tag:wood", "is:trashed"]) {
      expect(vocabulary(place), place).toBeNull();
    }
    // A folder nobody made holds nothing, which is an answer rather than a fault.
    expect(vocabulary("folder:Nowhere")).toEqual({ tags: [], types: [] });
  });

  it("counts the tags among what passes every filter under the All rule (ADR-0035 §9)", async () => {
    const named = (name: string) => search(library, name, PAGE)[0]?.id as AssetId;
    const [alpha, beta, gamma] = [named("alpha"), named("beta"), named("gamma")];
    await tagAdd(library, [alpha, beta, gamma], ["wood"]);
    await tagAdd(library, [alpha, gamma], ["glass"]);
    await tagAdd(library, [beta], ["metal"]);
    await rate(library, [alpha], 5);
    const design = await createFolder(library, "Design", null);
    await addToFolder(library, [alpha, beta], design);

    const all = { tags: [], tagRule: "all", stars: [], unrated: false, exts: [] } as const;
    const tags = (place: string, facets: Parameters<typeof readFacetVocabulary>[2]) =>
      readFacetVocabulary(library, place, facets)?.tags?.map((tag) => [tag.name, tag.count]);

    // Each count is what the grid would hold with that tag ticked as well, and
    // a tag none of them carries is not offered.
    expect(tags("", { ...all, tags: ["glass"] })).toEqual([
      ["glass", 2],
      ["wood", 2],
    ]);
    expect(count(library, "tag:glass tag:wood")).toBe(2);
    expect(tags("", { ...all, tags: ["wood"] })).toEqual([
      ["glass", 2],
      ["metal", 1],
      ["wood", 3],
    ]);
    // The rating and the type ticked beside it narrow the count too.
    expect(tags("", { ...all, tags: ["glass"], exts: ["png"] })).toEqual([
      ["glass", 1],
      ["wood", 1],
    ]);
    expect(tags("", { ...all, stars: [5] })).toEqual([
      ["glass", 1],
      ["wood", 1],
    ]);
    // Inside a folder, among its assets; its types are not narrowed by tags.
    const inFolder = readFacetVocabulary(library, "infolder:Design", { ...all, tags: ["metal"] });
    expect(inFolder?.tags?.map((tag) => [tag.name, tag.count])).toEqual([
      ["metal", 1],
      ["wood", 1],
    ]);
    expect(inFolder?.types?.map((type) => [type.ext, type.count])).toEqual([["png", 2]]);

    // Any widens with every tag, so its counts stay the place's own: the
    // library's lists, which the sidebar carries.
    expect(
      readFacetVocabulary(library, "", { ...all, tagRule: "any", tags: ["glass"] }),
    ).toBeNull();
    // Nothing ticked narrows nothing.
    expect(readFacetVocabulary(library, "", all)).toBeNull();

    // The trash leaves every count.
    await trashAssets(library, [gamma]);
    expect(tags("", { ...all, tags: ["glass"] })).toEqual([
      ["glass", 1],
      ["wood", 1],
    ]);
  });

  it("finds folders by whole words of their names (ADR-0057)", async () => {
    const design = await createFolder(library, "Design", null);
    const inside = await createFolder(library, "Highlights 2024", design);
    const archive = await createFolder(library, "Archive", null);
    const elsewhere = await createFolder(library, "highlights", archive);
    await createFolder(library, "Highlighted", null);

    const found = (query: string) => findFolders(library, query)?.sort();
    expect(found("highlights")).toEqual([inside, elsewhere].sort());
    // Whole words, as an asset's name is matched: a prefix finds nothing.
    expect(found("highl")).toEqual([]);
    expect(found("2024 highlights")).toEqual([inside]);

    // Inside a folder, everything beneath it and not the folder itself, at
    // either depth.
    expect(found("infolder:Design highlights")).toEqual([inside]);
    expect(found("folder:Design highlights")).toEqual([inside]);
    expect(found("infolder:Design design")).toEqual([]);

    // Not a search a folder can answer.
    expect(findFolders(library, "highlights rating:5")).toBeNull();
    expect(findFolders(library, "infolder:Design")).toBeNull();
  });

  it("splits a folder's name into words as the full-text index splits an asset's", async () => {
    // The rule is written twice — once by FTS5's `unicode61`, once for the
    // folders in memory — so this holds the two to one answer.
    const [first] = ids as [AssetId, AssetId, AssetId];
    const folder = await createFolder(library, "placeholder", null);
    const cases: [string, string[]][] = [
      ["Café Mood", ["cafe", "café", "CAFE", "mood", "caf"]],
      ["IMG_2024 trip", ["img", "2024", "img_2024", "trip", "IMG_2024"]],
      ["oak-wood", ['"oak wood"', "oak-wood", "wood", '"wood oak"']],
      ["naïve ÉCOLE", ["naive", "ecole", "école", "naïve"]],
    ];
    for (const [name, words] of cases) {
      await renameAsset(library, first, name);
      await renameFolder(library, folder, name);
      for (const word of words) {
        const asset = count(library, word) > 0;
        const named = (findFolders(library, word) ?? []).includes(folder);
        expect(named, `${name} / ${word}`).toBe(asset);
      }
    }
  });

  it("pages a folder's own assets before its subfolders' (ADR-0059)", async () => {
    const [first, second, third] = ids as [AssetId, AssetId, AssetId];
    const design = await createFolder(library, "Design", null);
    const icons = await createFolder(library, "Icons", design);
    await addToFolder(library, [first, second], design);
    // In both: it belongs to the folder's own part, and only there.
    await addToFolder(library, [first, third], icons);

    // One page holds both parts, and says where the second begins.
    const whole = sectionedPage(library, "folder:Design", { limit: 10 });
    expect(
      whole.hits
        .map((hit) => hit.id)
        .slice(0, 2)
        .sort(),
    ).toEqual([first, second].sort());
    expect(whole.hits.map((hit) => hit.id)).toEqual(expect.arrayContaining([third]));
    expect(whole.hits).toHaveLength(3);
    expect(whole.beneath).toEqual({ at: 2, count: 1 });
    expect(whole.section).toBe("beneath");

    // A page that ends exactly where the folder's own do: the next one begins
    // the second part from its own first row.
    const head = sectionedPage(library, "folder:Design", { limit: 2 });
    expect(head).toMatchObject({ section: "own", beneath: null });
    expect(head.hits).toHaveLength(2);
    const after = lastCursor(head.hits);
    if (after === undefined) throw new Error("a full page has a cursor");
    const tail = sectionedPage(library, "folder:Design", { limit: 2, after }, head.section);
    expect(tail.hits.map((hit) => hit.id)).toEqual([third]);
    expect(tail.beneath).toEqual({ at: 0, count: 1 });

    // Any other query is one part.
    expect(sectionedPage(library, "infolder:Design", { limit: 10 }).beneath).toBeNull();
  });

  it("empties the trash by removing exactly what is in it", async () => {
    const [first, second] = ids as [AssetId, AssetId, AssetId];
    await trashAssets(library, [first, second]);
    await restoreAssets(library, [second]);

    expect((await emptyTrash(library)).assets).toBe(1);
    expect(library.stats().assets).toBe(2);
    expect(count(library, "is:trashed")).toBe(0);
    // Restoring did not merely hide the second one from Trash: it is still a
    // row, and emptying must not have taken it.
    expect(library.db.repo.assetDetail(second)).toBeDefined();
    expect(library.db.repo.orphanSearchRows()).toBe(0);
  });

  it("re-stamps rather than refusing when something is trashed twice", async () => {
    const [first] = ids as [AssetId, AssetId, AssetId];
    await trashAssets(library, [first]);
    const firstTime = library.db.repo.trashedAt(first);
    expect(typeof firstTime).toBe("number");

    await restoreAssets(library, [first]);
    expect(library.db.repo.trashedAt(first)).toBeNull();

    await trashAssets(library, [first]);
    expect(typeof library.db.repo.trashedAt(first)).toBe("number");
  });

  it("keeps a comment at the moment it was left at", async () => {
    const asset = ids[0] as AssetId;
    const id = await addComment(library, asset, 91_500, "the cut lands early");
    expect(comments(library, asset)).toEqual([
      {
        id,
        assetId: asset,
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
    const asset = ids[0] as AssetId;
    await addComment(library, asset, null, "no timeline here");
    expect(comments(library, asset)[0]?.atMs).toBeNull();
  });

  it("lists timed comments in timeline order and untimed ones last", async () => {
    const asset = ids[0] as AssetId;
    await addComment(library, asset, null, "about the whole thing");
    await addComment(library, asset, 5_000, "later");
    await addComment(library, asset, 1_000, "earlier");
    expect(comments(library, asset).map((c) => c.body)).toEqual([
      "earlier",
      "later",
      "about the whole thing",
    ]);
  });

  it("edits a comment in place, keeping its id and its place in the list", async () => {
    // Remove-and-re-add would move it to the end of a list ordered by creation,
    // and somebody who fixed a typo did not ask for that.
    const asset = ids[0] as AssetId;
    const first = await addComment(library, asset, 1_000, "first");
    await addComment(library, asset, 2_000, "second");

    await setComment(library, first, 1_000, "first, corrected");
    const listed = comments(library, asset);
    expect(listed.map((c) => c.body)).toEqual(["first, corrected", "second"]);
    expect(listed[0]?.id).toBe(first);
    expect(listed[0]?.updatedAt).toEqual(expect.any(Number));
  });

  it("moves a comment to another moment without losing it", async () => {
    const asset = ids[0] as AssetId;
    const id = await addComment(library, asset, 1_000, "here");
    await setComment(library, id, 9_000, "here");
    expect(comments(library, asset)[0]?.atMs).toBe(9_000);
  });

  it("removes a comment, and refuses to touch one that is gone", async () => {
    const asset = ids[0] as AssetId;
    const id = await addComment(library, asset, 1_000, "temporary");
    await removeComment(library, id);
    expect(comments(library, asset)).toEqual([]);
    await expect(removeComment(library, id)).rejects.toBeInstanceOf(UnknownCommentError);
    await expect(setComment(library, id, null, "back")).rejects.toBeInstanceOf(UnknownCommentError);
  });

  it("refuses an empty body rather than deleting the comment", async () => {
    // Emptying the box and removing the comment are different intentions, and
    // only one of them can be undone by typing again.
    const asset = ids[0] as AssetId;
    await expect(addComment(library, asset, 0, "   ")).rejects.toBeInstanceOf(EmptyCommentError);
    const id = await addComment(library, asset, 0, "real");
    await expect(setComment(library, id, 0, "")).rejects.toBeInstanceOf(EmptyCommentError);
    expect(comments(library, asset)).toHaveLength(1);
  });

  it("refuses a moment that is not one", async () => {
    const asset = ids[0] as AssetId;
    await expect(addComment(library, asset, -1, "before the start")).rejects.toBeInstanceOf(
      InvalidMomentError,
    );
    await expect(addComment(library, asset, 1.5, "half a millisecond")).rejects.toBeInstanceOf(
      InvalidMomentError,
    );
  });

  it("refuses a comment on an asset the library does not hold", async () => {
    await expect(addComment(library, "f".repeat(64) as AssetId, 0, "ghost")).rejects.toBeInstanceOf(
      UnknownAssetError,
    );
  });

  it("journals every comment before indexing it", async () => {
    // Invariant 9, stated the way this suite states it above: a row with no
    // journal line is data loss the next rebuild would reveal.
    const asset = ids[0] as AssetId;
    const id = await addComment(library, asset, 91_500, "the cut lands early");
    await setComment(library, id, 91_000, "two frames early");
    await removeComment(library, id);

    const ours = (await journalLines()).filter((line) => String(line.op).startsWith("comment_"));
    expect(ours.map((line) => line.op)).toEqual(["comment_add", "comment_set", "comment_remove"]);
    // Milliseconds in `at`, seconds in `ts`: two different clocks, kept apart
    // by name so neither can be read as the other (ADR-0023).
    expect(ours[0]).toMatchObject({ id, asset, at: 91_500, body: "the cut lands early" });
    expect(ours[1]).toMatchObject({ id, at: 91_000 });
    expect(ours[2]).toEqual({ ts: expect.any(Number), op: "comment_remove", id });
  });

  it("keeps comments through the trash and takes them on a remove", async () => {
    const kept = ids[0] as AssetId;
    const doomed = ids[1] as AssetId;
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
  const importVideo = async (name = "clip.mp4"): Promise<AssetId> => {
    const source = join(dir, "video");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, name), `not really a video: ${name}`);
    await importInto(library, [join(source, name)]);
    // Matched on the name **and** the extension: a name carries none (RL-33),
    // so `clip.mp4` is the name `clip` and the extension `mp4`.
    const stem = name.slice(0, name.lastIndexOf("."));
    const ext = name.slice(name.lastIndexOf(".") + 1);
    const found = library.db.repo.allIds().find((id) => {
      const summary = library.db.repo.findAsset(id);
      return summary?.name === stem && summary.ext === ext;
    });
    if (found === undefined) throw new Error("the video did not import");
    return found;
  };

  it("pins a thumbnail to a moment, and journals where to look rather than the picture", async () => {
    const asset = await importVideo();
    expect(await setPoster(library, asset, 91_500)).toBe(true);
    expect(poster(library, asset)).toBe(91_500);

    const ours = (await journalLines()).filter((line) => line.op === "poster_set");
    expect(ours).toEqual([{ ts: expect.any(Number), op: "poster_set", asset, at: 91_500 }]);
    // The instruction, never the pixels: a journal carrying an image would be
    // base64 in a text file, which the forbidden-patterns list refuses twice.
    expect(JSON.stringify(ours[0])).not.toMatch(/data:|base64/);
  });

  it("clears back to the default frame with the same op", async () => {
    const asset = await importVideo();
    await setPoster(library, asset, 91_500);
    expect(await setPoster(library, asset, null)).toBe(true);
    expect(poster(library, asset)).toBeNull();

    const ours = (await journalLines()).filter((line) => line.op === "poster_set");
    expect(ours.map((line) => line.at)).toEqual([91_500, null]);
  });

  it("writes nothing when the thumbnail is already where it is being put", async () => {
    // An append-only file is read by people, and a line that changes nothing is
    // a line they have to rule out.
    const asset = await importVideo();
    await setPoster(library, asset, 91_500);
    expect(await setPoster(library, asset, 91_500)).toBe(false);

    const ours = (await journalLines()).filter((line) => line.op === "poster_set");
    expect(ours).toHaveLength(1);
  });

  it("clears nothing when the thumbnail is already on the default frame", async () => {
    const asset = await importVideo();
    expect(await setPoster(library, asset, null)).toBe(false);
    expect((await journalLines()).filter((line) => line.op === "poster_set")).toEqual([]);
  });

  it("drops the preview it can no longer draw, and queues what it could not redraw", async () => {
    const asset = await importVideo();
    library.db.repo.putThumbnail(asset, GRID_SIZE, 8, 8, Buffer.from("grid"));
    library.db.repo.putThumbnail(asset, PREVIEW_SIZE, 8, 8, Buffer.from("preview"));

    await setPoster(library, asset, 91_500);

    // The bytes here are not a video, so the immediate redraw fails — which is
    // also what a machine without ffmpeg looks like. The preview size is made
    // on first use and never revisited, so leaving one behind would let it
    // outlive the frame it was drawn from; the grid size stays until something
    // replaces it, because a cell that goes blank is worse than one that is a
    // quarter of a second stale.
    expect(library.db.repo.thumbnail(asset, PREVIEW_SIZE)).toBeUndefined();
    expect(library.db.repo.thumbnail(asset, GRID_SIZE)).toBeDefined();
    // Queued, so the picture arrives whenever it can rather than not at all.
    expect(queueStatus(library).ready).toBeGreaterThan(0);
  });

  it("refuses a thumbnail moment on something with no frames", async () => {
    // Audio has no picture to take and a document already has a page. A
    // journal line that means nothing is one a later build has to keep
    // understanding.
    await expect(setPoster(library, ids[0] as AssetId, 1_000)).rejects.toBeInstanceOf(
      NotAVideoError,
    );
    expect((await journalLines()).filter((line) => line.op === "poster_set")).toEqual([]);
  });

  it("refuses a negative moment, as a comment's does", async () => {
    const asset = await importVideo();
    await expect(setPoster(library, asset, -1)).rejects.toBeInstanceOf(InvalidMomentError);
  });

  it("rebuilds to the same library after every kind of edit", async () => {
    // The strongest statement this suite makes: if any edit above reached the
    // index without reaching the journal, the rebuilt index would differ here.
    const design = await createFolder(library, "Design", null);
    const icons = await createFolder(library, "Icons", design);
    await addToFolder(library, [ids[0] as AssetId], icons);
    await moveFolder(library, icons, null);

    const group = await createTagGroup(library, "Material");
    await tagAdd(library, ids, ["wood"]);
    await setTagGroup(library, ["wood"], group);
    await tagRename(library, "wood", "timber");
    await tagAdd(library, ids, ["doomed"]);
    await deleteTags(library, ["doomed"]);
    await createTag(library, "waiting", group);
    await rate(library, [ids[0] as AssetId], 5);
    await apply(library, [{ op: "favorite_set", asset: ids[1] as AssetId, favorite: true }]);
    await setNote(library, [ids[2] as AssetId], "a note");
    const comment = await addComment(library, ids[0] as AssetId, 91_500, "a comment");
    await setComment(library, comment, 91_000, "an edited comment");
    await addComment(library, ids[0] as AssetId, null, "and one about the asset");
    const doomedComment = await addComment(library, ids[0] as AssetId, 1, "removed again");
    await removeComment(library, doomedComment);
    await renameAsset(library, ids[2] as AssetId, "renamed.jpg");
    const clip = await importVideo("pinned.mp4");
    await setPoster(library, clip, 91_500);
    await createSmartFolder(library, "Five stars", "rating:5", null);
    await removeAssets(library, [ids[1] as AssetId]);
    await trashAssets(library, [ids[2] as AssetId]);
    await trashAssets(library, [ids[0] as AssetId]);
    await restoreAssets(library, [ids[0] as AssetId]);

    const before = withoutDerived(library.stats());
    const found = names(search(library, "tag:timber", PAGE));

    await library.rebuild();

    expect(withoutDerived(library.stats())).toEqual(before);
    expect(names(search(library, "tag:timber", PAGE))).toEqual(found);
    expect(count(library, "rating:5")).toBe(1);
    // A deleted tag stays deleted, and a tag made with nothing on it stays made.
    expect(library.db.repo.hasTag("doomed")).toBe(false);
    expect(library.db.repo.tags().find((tag) => tag.name === "waiting")).toEqual({
      name: "waiting",
      count: 0,
      group: "Material",
    });
    // `renamed.jpg` is the asset that was trashed, so the query that found it
    // before the rebuild must still find nothing after one — a `trash` that
    // replayed as a no-op would pass every other assertion here.
    expect(count(library, "renamed")).toBe(0);
    expect(count(library, "is:trashed")).toBe(1);
    // Comments come back with their moments, their edits, and their absences:
    // the removed one must not reappear, and the edited one must not revert.
    expect(comments(library, ids[0] as AssetId).map((c) => [c.atMs, c.body])).toEqual([
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
      await setNote(library, [ids[0] as AssetId], "needs a reshoot before the deadline");

      expect(count(library, "reshoot")).toBe(1);
      // Typed, not composed: bare words are already free-text terms, so the
      // whole feature is reached without syntax (ADR-0027 §2).
      expect(count(library, "needs a reshoot")).toBe(1);
    });

    it("finds an asset by a word in a comment, and stops when the comment goes", async () => {
      const id = await addComment(library, ids[1] as AssetId, 4200, "the grade is too warm");

      expect(count(library, "grade")).toBe(1);

      await removeComment(library, id);
      expect(count(library, "grade")).toBe(0);
    });

    it("follows an edit rather than keeping what was written first", async () => {
      await setNote(library, [ids[0] as AssetId], "provisional");
      const id = await addComment(library, ids[0] as AssetId, null, "ask marketing");

      await setNote(library, [ids[0] as AssetId], "approved");
      await setComment(library, id, null, "marketing approved it");

      expect(count(library, "provisional")).toBe(0);
      expect(count(library, "ask")).toBe(0);
      expect(count(library, "approved")).toBe(1);
    });

    it("keeps the name and the tags searchable beside them", async () => {
      // The table was dropped and rebuilt by the migration, so the two columns
      // that were already there are worth asserting are still there.
      await tagAdd(library, [ids[2] as AssetId], ["mahogany"]);

      expect(count(library, "gamma")).toBe(1);
      expect(count(library, "mahogany")).toBe(1);
    });

    it("clears the note from the index when the note is cleared", async () => {
      await setNote(library, [ids[0] as AssetId], "temporary");
      await setNote(library, [ids[0] as AssetId], null);

      expect(count(library, "temporary")).toBe(0);
    });
  });
});
