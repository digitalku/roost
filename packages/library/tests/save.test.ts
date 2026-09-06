import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentHash } from "@roost/core";
import {
  addComment,
  addToFolder,
  apply,
  createAsset,
  createFolder,
  EditTooLargeError,
  importInto,
  Library,
  MAX_EDIT_BYTES,
  NotEditableError,
  rate,
  saveEdit,
  setNote,
  setSource,
  supersedeAsset,
  tagAdd,
  trashAssets,
} from "@roost/library";
import { buildQuery, parse } from "@roost/search";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const text = (body: string): Uint8Array => new TextEncoder().encode(body);

describe("saving an edit", () => {
  let dir: string;
  let source: string;
  let library: Library;
  let note: ContentHash;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-save-"));
    source = join(dir, "files");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "notes.txt"), "first draft\n");

    library = await Library.create(join(dir, "library"), "test");
    await importInto(library, [source]);
    const [first] = library.db.repo.search({ sql: "1", params: [] }, { limit: 10 });
    if (first === undefined) throw new Error("nothing imported");
    note = first.hash;
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a new asset and leaves the old one whole", async () => {
    const after = await saveEdit(library, note, text("second draft\n"));

    expect(after).not.toBe(note);
    // The old bytes are still at the old address. A save is not a write
    // (ADR-0026), and invariant 6 does not bend for our own files either.
    const managed = library.storageFor("managed");
    expect(await readFile(managed.locate(note, "txt"), "utf8")).toBe("first draft\n");
    expect(await readFile(managed.locate(after, "txt"), "utf8")).toBe("second draft\n");

    const before = library.db.repo.assetDetail(note);
    expect(before?.supersededBy).toBe(after);
    expect(library.db.repo.assetDetail(after)?.supersededBy).toBeNull();
    // The name travels: the file is still the user's `notes.txt`.
    expect(library.db.repo.assetDetail(after)?.origName).toBe("notes.txt");
  });

  it("carries everything a person authored to the new version", async () => {
    await tagAdd(library, [note], ["draft", "writing"]);
    const folder = await createFolder(library, "Notes", null);
    await addToFolder(library, [note], folder);
    await rate(library, [note], 4);
    await setNote(library, note, "for the talk");
    await setSource(library, note, "https://example.com/brief");
    // Journalled directly: nothing authors a favourite any more (ADR-0029),
    // and the carry-over exists precisely for the assets that already have one.
    await apply(library, [{ op: "favorite_set", hash: note, favorite: true }]);
    await addComment(library, note, null, "check the second paragraph");

    const after = await saveEdit(library, note, text("second draft\n"));
    const detail = library.db.repo.assetDetail(after);

    expect(detail?.tags).toEqual(["draft", "writing"]);
    expect(detail?.folders.map((folder) => folder.path)).toEqual(["Notes"]);
    expect(detail?.rating).toBe(4);
    expect(detail?.note).toBe("for the talk");
    // Replacing an asset's bytes does not change where they came from.
    expect(detail?.sourceUrl).toBe("https://example.com/brief");
    expect(detail?.isFavorite).toBe(true);
    expect(library.db.repo.commentsFor(after).map((row) => row.body)).toEqual([
      "check the second paragraph",
    ]);
    // Copied, not moved: the old version is still a row somebody can open, and
    // it keeps its own remark.
    expect(library.db.repo.commentsFor(note)).toHaveLength(1);
  });

  it("survives a rebuild, because every carry-over is a journal line", async () => {
    await tagAdd(library, [note], ["draft"]);
    await rate(library, [note], 3);
    const after = await saveEdit(library, note, text("second draft\n"));

    await library.rebuild();

    const detail = library.db.repo.assetDetail(after);
    expect(detail?.tags).toEqual(["draft"]);
    expect(detail?.rating).toBe(3);
    expect(library.db.repo.assetDetail(note)?.supersededBy).toBe(after);
  });

  it("takes the superseded version out of every search but its own", async () => {
    const after = await saveEdit(library, note, text("second draft\n"));

    const live = library.db.repo.search(buildQuery("notes"), { limit: 10 });
    expect(live.map((hit) => hit.hash)).toEqual([after]);

    const old = library.db.repo.search(buildQuery("is:superseded"), { limit: 10 });
    expect(old.map((hit) => hit.hash)).toEqual([note]);
    // Parsing it is what makes the flag real rather than a string that compiles.
    expect(() => parse("is:superseded")).not.toThrow();
  });

  it("writes nothing when the bytes did not change", async () => {
    // An append-only journal is read by people, and `supersede` pointing an
    // asset at itself would be both a lie and a cycle.
    expect(await saveEdit(library, note, text("first draft\n"))).toBe(note);
    expect(library.db.repo.assetDetail(note)?.supersededBy).toBeNull();
    expect(library.db.repo.search({ sql: "1", params: [] }, { limit: 10 })).toHaveLength(1);
  });

  it("deduplicates into an asset that already exists", async () => {
    await writeFile(join(source, "other.txt"), "second draft\n");
    await importInto(library, [join(source, "other.txt")]);
    const other = library.db.repo
      .search({ sql: "1", params: [] }, { limit: 10 })
      .map((hit) => hit.hash)
      .filter((hash) => hash !== note);

    const after = await saveEdit(library, note, text("second draft\n"));

    // Identical bytes are one asset by invariant 1. Editing one file into
    // another's contents is dedupe, not a collision.
    expect(other).toContain(after);
    expect(library.db.repo.assetDetail(note)?.supersededBy).toBe(after);
  });

  it("refuses to edit what it must not write", async () => {
    await expect(
      saveEdit(library, note, new Uint8Array(MAX_EDIT_BYTES + 1)),
    ).rejects.toBeInstanceOf(EditTooLargeError);

    await trashAssets(library, [note]);
    // Superseding a trashed asset would produce a live replacement, which makes
    // editing a way of undeleting.
    await expect(saveEdit(library, note, text("second draft\n"))).rejects.toBeInstanceOf(
      NotEditableError,
    );
  });

  it("refuses a referenced asset, because its bytes are the user's own", async () => {
    await writeFile(join(source, "kept.txt"), "not ours\n");
    await importInto(library, [join(source, "kept.txt")], { mode: "referenced" });
    const referenced = library.db.repo
      .search({ sql: "1", params: [] }, { limit: 10 })
      .map((hit) => hit.hash)
      .find((hash) => library.db.repo.assetDetail(hash)?.storageMode === "referenced");
    if (referenced === undefined) throw new Error("nothing referenced");

    await expect(saveEdit(library, referenced, text("ours now\n"))).rejects.toBeInstanceOf(
      NotEditableError,
    );
    // And the user's file is untouched, which is the point of refusing.
    expect(await readFile(join(source, "kept.txt"), "utf8")).toBe("not ours\n");
  });

  it("creates a file from bytes the window typed", async () => {
    const made = await createAsset(library, "todo.md", text("- write it down\n"));
    expect(made.created).toBe(true);

    const detail = library.db.repo.assetDetail(made.hash);
    expect(detail?.origName).toBe("todo.md");
    // The importer's rule, so one asset cannot reach two addresses depending on
    // which door it came in by: the last component, lowercased, no dot.
    expect(detail?.ext).toBe("md");
    expect(detail?.storageMode).toBe("managed");
    expect(await readFile(library.storageFor("managed").locate(made.hash, "md"), "utf8")).toBe(
      "- write it down\n",
    );
  });

  it("holds one empty file however many are made", async () => {
    // Every empty file has the same BLAKE3 hash and `assets.hash` is the
    // primary key, so the second answers with the first — under the first
    // one's name, because that is the one somebody has been using. Refusing
    // instead was tried on 2026-09-03 and withdrawn on 2026-09-05.
    const first = await createAsset(library, "empty.txt", new Uint8Array(0));
    expect(first.created).toBe(true);

    const second = await createAsset(library, "another.md", new Uint8Array(0));
    expect(second).toEqual({ hash: first.hash, created: false });
    expect(library.db.repo.assetDetail(first.hash)?.origName).toBe("empty.txt");
    // And it is a real asset: bytes on disk, at the address its hash names.
    expect(await readFile(library.storageFor("managed").locate(first.hash, "txt"), "utf8")).toBe(
      "",
    );
  });

  it("answers with the asset that already holds those bytes", async () => {
    const first = await createAsset(library, "one.txt", text("the same words\n"));
    const again = await createAsset(library, "two.txt", text("the same words\n"));

    expect(again).toEqual({ hash: first.hash, created: false });
    // The name of the one already there wins, because it is the one somebody
    // has been using.
    expect(library.db.repo.assetDetail(first.hash)?.origName).toBe("one.txt");
  });

  it("survives a rebuild, because creating one is an ordinary add", async () => {
    const made = await createAsset(library, "todo.md", text("- write it down\n"));
    await library.rebuild();
    expect(library.db.repo.assetDetail(made.hash)?.origName).toBe("todo.md");
  });

  it("clears a supersession with the same op and no target", async () => {
    const after = await saveEdit(library, note, text("second draft\n"));
    await supersedeAsset(library, note, null);

    expect(library.db.repo.assetDetail(note)?.supersededBy).toBeNull();
    // Both are current now, which is what "this is current again" has to mean.
    const live = library.db.repo.search(buildQuery("notes"), { limit: 10 });
    expect(live.map((hit) => hit.hash).sort()).toEqual([note, after].sort());
  });
});
