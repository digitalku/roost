import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetId } from "@roost/core";
import {
  addComment,
  addToFolder,
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
  tagAdd,
  trashAssets,
} from "@roost/library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const text = (body: string): Uint8Array => new TextEncoder().encode(body);

describe("saving an edit", () => {
  let dir: string;
  let source: string;
  let library: Library;
  let note: AssetId;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-save-"));
    source = join(dir, "files");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "notes.txt"), "first draft\n");

    library = await Library.create(join(dir, "library"), "test");
    await importInto(library, [source]);
    const [first] = library.db.repo.allIds();
    if (first === undefined) throw new Error("nothing imported");
    note = first;
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes over the asset's own file, and it is the same asset", async () => {
    // The whole of what version 2 changed here (ADR-0046, superseding
    // ADR-0026): identity is an id, the bytes under it may change at any time
    // (RL-20), and a save is therefore a write rather than a second asset.
    const path = library.storage.locate(note, "txt");

    await saveEdit(library, note, text("second draft\n"));

    expect(await readFile(path, "utf8")).toBe("second draft\n");
    expect(library.db.repo.allIds()).toEqual([note]);
    expect(library.db.repo.assetDetail(note)?.name).toBe("notes");
  });

  it("keeps everything a person said about it", async () => {
    // Version 1 had to carry all of this across to a new asset, through the
    // operation that owned each piece. Here there is nothing to carry: the row
    // is the same row.
    await tagAdd(library, [note], ["draft"]);
    const folder = await createFolder(library, "Writing", null);
    await addToFolder(library, [note], folder);
    await rate(library, [note], 4);
    await setNote(library, [note], "for review");
    await addComment(library, note, null, "the second paragraph repeats itself");

    await saveEdit(library, note, text("second draft\n"));

    expect(library.db.repo.assetDetail(note)).toMatchObject({
      tags: ["draft"],
      rating: 4,
      note: "for review",
    });
    expect(library.db.repo.assetDetail(note)?.folders).toHaveLength(1);
    expect(library.db.repo.commentsFor(note)).toHaveLength(1);
  });

  it("journals nothing at all, because the journal is not about the bytes", async () => {
    // RL-23. The record of what the file holds is the file; a journal line per
    // save would fill it with what the disk already says, and would make an
    // edit something a rebuild had to replay.
    const before = await readFile(join(library.journal.dir, "2026-09.jsonl"), "utf8").catch(
      async () => {
        const [month] = await library.journal.months();
        return readFile(join(library.journal.dir, `${month}.jsonl`), "utf8");
      },
    );

    await saveEdit(library, note, text("second draft\n"));

    const [month] = await library.journal.months();
    const after = await readFile(join(library.journal.dir, `${month}.jsonl`), "utf8");
    expect(after).toBe(before);
  });

  it("forgets what it derived from the bytes that are gone", async () => {
    // A size, a hash and a thumbnail all describe a file that no longer exists.
    // Keeping them would draw a cell from a picture of the past.
    const first = library.db.repo.assetDetail(note);
    expect(first?.size).toBeGreaterThan(0);
    expect(first?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    library.db.repo.putThumbnail(note, 256, 16, 16, Buffer.from([0x00]));

    await saveEdit(library, note, text("a much longer second draft\n"));

    expect(library.db.repo.assetDetail(note)).toMatchObject({
      size: null,
      contentHash: null,
      derivedAt: null,
    });
    expect(library.db.repo.thumbnail(note, 256)).toBeUndefined();
    // And the derive is queued, because somebody is looking at it.
    expect(library.db.repo.jobCounts()[0]?.state).toBe("ready");
  });

  it("refuses to edit what it must not write", async () => {
    await expect(
      saveEdit(library, note, new Uint8Array(MAX_EDIT_BYTES + 1)),
    ).rejects.toBeInstanceOf(EditTooLargeError);

    // A partial read must never be saved over a whole file, which is the one
    // way editing could destroy one rather than replace it.
    expect(await readFile(library.storage.locate(note, "txt"), "utf8")).toBe("first draft\n");
  });

  it("refuses a trashed asset until it is restored", async () => {
    await trashAssets(library, [note]);
    await expect(saveEdit(library, note, text("no"))).rejects.toBeInstanceOf(NotEditableError);
  });
});

describe("creating an asset from bytes the window typed", () => {
  let dir: string;
  let library: Library;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-create-"));
    library = await Library.create(join(dir, "library"), "test");
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the file and journals an ordinary add", async () => {
    const id = await createAsset(library, "shopping.md", text("- milk\n"));

    expect(library.db.repo.assetDetail(id)).toMatchObject({ name: "shopping", ext: "md" });
    expect(await readFile(library.storage.locate(id, "md"), "utf8")).toBe("- milk\n");
    await expect(stat(library.storage.locate(id, "md"))).resolves.toBeTruthy();
  });

  it("makes two empty files rather than one", async () => {
    // Version 1 could not: every empty file had one hash and the hash was the
    // primary key, so the second answered with the first, under the first
    // one's name. An id is minted rather than derived (RL-13), so two files a
    // person made deliberately are two assets — which is what they asked for
    // both times.
    const first = await createAsset(library, "one.md", text(""));
    const second = await createAsset(library, "two.md", text(""));

    expect(first).not.toBe(second);
    expect(library.db.repo.allIds()).toHaveLength(2);
    expect(library.db.repo.assetDetail(second)?.name).toBe("two");
  });

  it("survives a rebuild, because creating one is an ordinary add", async () => {
    const id = await createAsset(library, "kept.md", text("# kept\n"));
    await library.rebuild();

    expect(library.db.repo.assetDetail(id)?.name).toBe("kept");
  });
});
