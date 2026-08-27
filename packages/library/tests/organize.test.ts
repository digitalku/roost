import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContentHash, DEFAULT_PAGE_LIMIT, IndexSink, withoutDerived } from "@roost/core";
import {
  AmbiguousFolderNameError,
  addToFolder,
  count,
  createFolder,
  createSmartFolder,
  createTagGroup,
  deleteFolder,
  EmptyNameError,
  FolderCycleError,
  InvalidRatingError,
  importInto,
  Library,
  moveFolder,
  pages,
  rate,
  readSidebar,
  removeAssets,
  renameAsset,
  renameFolder,
  resolveAsset,
  resolveFolder,
  resolveTagGroup,
  search,
  setFavorite,
  setNote,
  setTagGroup,
  tagAdd,
  tagRemove,
  tagRename,
  UnknownAssetError,
  UnknownFolderPathError,
} from "@roost/library";
import { gradient } from "@roost/media";
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

  it("rates, notes, and favourites, and refuses a rating the schema has no room for", async () => {
    await rate(library, [hashes[0] as ContentHash], 4);
    await setFavorite(library, [hashes[1] as ContentHash], true);
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
    await setFavorite(library, [hashes[1] as ContentHash], true);
    await setNote(library, hashes[2] as ContentHash, "a note");
    await renameAsset(library, hashes[2] as ContentHash, "renamed.jpg");
    await createSmartFolder(library, "Five stars", "rating:5", null);
    await removeAssets(library, [hashes[1] as ContentHash]);

    const before = withoutDerived(library.stats());
    const found = names(search(library, "tag:timber", PAGE));

    await library.rebuild();

    expect(withoutDerived(library.stats())).toEqual(before);
    expect(names(search(library, "tag:timber", PAGE))).toEqual(found);
    expect(count(library, "rating:5")).toBe(1);
    expect(count(library, "renamed")).toBe(1);
    expect(library.db.repo.orphanSearchRows()).toBe(0);
  });
});
