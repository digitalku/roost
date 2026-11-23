import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChangedOnDiskError,
  createAsset,
  Library,
  MAX_EDIT_BYTES,
  readText,
  saveText,
} from "@roost/library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Text read in the window and saved over the file (ADR-0070 §3.4). */
describe("reading and saving a text asset", () => {
  let dir: string;
  let library: Library;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-text-"));
    library = await Library.create(join(dir, "library"), "test");
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  const read = async (id: string) => {
    const answer = await readText(library, id as never);
    if (answer.kind !== "text") throw new Error(`expected text, got ${answer.kind}`);
    return answer;
  };

  it("reads a file, and saves an edit over it with nothing journalled", async () => {
    const id = await createAsset(library, "notes.md", bytes("# Notes\n"));
    const before = await read(id);
    expect(before).toMatchObject({ text: "# Notes\n", encoding: "utf-8", editable: true });

    const saved = await saveText(library, id, { ...before, text: "# Notes\n\nmore\n", bom: false });

    const path = library.storage.locate(id, "md");
    expect(await readFile(path, "utf8")).toBe("# Notes\n\nmore\n");
    expect(saved.size).toBe(14);
    // The answer is what the next save checks against, so a second save in a
    // row is not mistaken for somebody else's.
    await saveText(library, id, { ...saved, text: "again\n", bom: false, crlf: false });
    expect(await readFile(path, "utf8")).toBe("again\n");
  });

  it("keeps the byte-order mark and the line endings it read", async () => {
    const id = await createAsset(
      library,
      "win.txt",
      new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("a\r\nb")]),
    );
    const before = await read(id);
    expect(before).toMatchObject({ text: "a\r\nb", encoding: "utf-8-bom", crlf: true });

    await saveText(library, id, { ...before, text: "a\nb\nc", bom: true });

    const written = await readFile(library.storage.locate(id, "txt"));
    expect([...written.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(written.subarray(3).toString("utf8")).toBe("a\r\nb\r\nc");
  });

  it("refuses to undo a save another application made meanwhile, unless told to", async () => {
    const id = await createAsset(library, "shared.md", bytes("one\n"));
    const before = await read(id);

    // Another editor saves: same length, a later time.
    const path = library.storage.locate(id, "md");
    await writeFile(path, "two\n");
    const later = new Date(before.mtimeMs + 5_000);
    await utimes(path, later, later);

    await expect(
      saveText(library, id, { ...before, text: "mine\n", bom: false }),
    ).rejects.toBeInstanceOf(ChangedOnDiskError);
    expect(await readFile(path, "utf8")).toBe("two\n");

    await saveText(library, id, { ...before, text: "mine\n", bom: false, force: true });
    expect(await readFile(path, "utf8")).toBe("mine\n");
  });

  it("offers no edit for what it could not read whole, or read as UTF-8", async () => {
    const big = await createAsset(library, "big.txt", new Uint8Array(MAX_EDIT_BYTES).fill(0x61));
    await writeFile(library.storage.locate(big, "txt"), Buffer.alloc(MAX_EDIT_BYTES + 10, 0x61));
    expect(await read(big)).toMatchObject({ truncated: true, editable: false });

    const latin = await createAsset(library, "latin.txt", new Uint8Array([0x43, 0x61, 0x66, 0xe9]));
    expect(await read(latin)).toMatchObject({
      text: "Café",
      encoding: "windows-1252",
      editable: false,
    });
  });

  it("says when a text extension holds something that is not text", async () => {
    const id = await createAsset(library, "dump.txt", new Uint8Array([0x41, 0x00, 0x42]));
    expect(await readText(library, id)).toEqual({ kind: "binary" });
  });
});
