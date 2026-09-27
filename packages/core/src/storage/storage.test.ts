import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAssetId } from "../model/index.js";
import { tmpfsDir } from "../testing/mounts.js";
import { FileStore } from "./files.js";
import { normalizeExt } from "./types.js";

const ID = parseAssetId("3FAAAAAAAAAA");
const OTHER = parseAssetId("B7CCCCCCCCCC");
const onLinux = process.platform === "linux";

/**
 * The repository's own filesystem. On this machine it is Btrfs, which is what
 * makes the reflink branch reachable; on a CI runner it is usually ext4, which
 * is what makes the refusal branch reachable. The tests below cover whichever
 * one they find rather than assuming either.
 */
const REPO_FS_ROOT = join(import.meta.dirname, "../../../../.tmp-test");

async function supportsReflink(dir: string): Promise<boolean> {
  const src = join(dir, ".reflink-probe-src");
  const dst = join(dir, ".reflink-probe-dst");
  await writeFile(src, "probe");
  try {
    await copyFile(src, dst, constants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch {
    return false;
  } finally {
    await rm(src, { force: true });
    await rm(dst, { force: true });
  }
}

describe("normalizeExt", () => {
  it("lowercases, so one file does not get two addresses", () => {
    expect(normalizeExt("JPG")).toBe("jpg");
    expect(normalizeExt("Jpeg")).toBe("jpeg");
  });

  it("strips every leading dot, however the caller spells it", () => {
    expect(normalizeExt(".png")).toBe("png");
    expect(normalizeExt("..png")).toBe("png");
    expect(normalizeExt("png")).toBe("png");
  });

  it("leaves an empty extension empty", () => {
    expect(normalizeExt("")).toBe("");
    expect(normalizeExt(".")).toBe("");
  });
});

describe("FileStore.locate", () => {
  const store = new FileStore("/lib");

  // The shard and the filename are the assertion; the separator between them is
  // the platform's, and `locate` builds it with `join` like everything else.
  const at = (...parts: string[]) => join("/lib", "files", ...parts);

  it("shards on the first two characters of the id, one level only (RL-8)", () => {
    expect(store.locate(ID, "jpg")).toBe(at("3F", `${ID}.jpg`));
  });

  it("normalises the extension into the filename (RL-9)", () => {
    expect(store.locate(ID, ".JPG")).toBe(at("3F", `${ID}.jpg`));
  });

  it("uses the bare id when there is no extension, with no trailing dot (RL-9a)", () => {
    // The rule a Windows implementation passes against itself and fails against
    // every other system: Windows strips a trailing dot before the path reaches
    // the filesystem, so a build that wrote one would find the file again
    // through its own API and produce a library nothing else can read.
    expect(store.locate(ID, "")).toBe(at("3F", ID));
    expect(store.locate(ID, "")).not.toMatch(/\.$/);
  });
});

describe("FileStore, on a real filesystem", () => {
  let lib: string;
  let src: string;
  let store: FileStore;
  let reflinkable: boolean;

  beforeAll(async () => {
    await mkdir(REPO_FS_ROOT, { recursive: true });
    lib = await mkdtemp(join(REPO_FS_ROOT, "lib-"));
    src = await mkdtemp(join(REPO_FS_ROOT, "src-"));
    store = new FileStore(lib);
    reflinkable = await supportsReflink(lib);
  });

  afterAll(async () => {
    await rm(lib, { recursive: true, force: true });
    await rm(src, { recursive: true, force: true });
  });

  it("creates the shard directory lazily, and only the one it needs (RL-10)", async () => {
    const file = join(src, "one.bin");
    await writeFile(file, "one");
    await store.put(file, ID, "bin", "copy");

    expect(await readdir(store.filesDir())).toEqual(["3F"]);
  });

  it("copies without touching the caller's file, and says it copied (RL-26)", async () => {
    const file = join(src, "keep.bin");
    await writeFile(file, "keep");
    const placed = await store.put(file, OTHER, "bin", "copy");

    expect(placed.take).toBe("copy");
    expect(await readFile(file, "utf8")).toBe("keep");
    expect(await readFile(placed.path, "utf8")).toBe("keep");
  });

  it("moves by taking the source with it, and says it moved (RL-26)", async () => {
    // The half of RL-26 that cannot be undone by looking at the library, which
    // is exactly why the report has to carry it.
    const file = join(src, "gone-from-here.bin");
    await writeFile(file, "moved");
    const id = parseAssetId("MV0000000001");

    const placed = await store.put(file, id, "bin", "move");

    expect(placed.take).toBe("move");
    expect(await readFile(placed.path, "utf8")).toBe("moved");
    await expect(stat(file)).rejects.toThrow();
  });

  it("leaves no temp file behind", async () => {
    const entries = await readdir(join(store.filesDir(), "3F"));
    expect(entries.filter((e) => e.startsWith("."))).toEqual([]);
  });

  it("never hardlinks, so editing the library's file cannot edit the user's", async () => {
    // RL-26 permits a copy-on-write clone and forbids a hardlink, because a
    // shared inode would make an edit inside the library an edit outside it.
    // The inode is the assertion: a reflink and a copy both give a new one.
    const file = join(src, "own.bin");
    await writeFile(file, "own");
    const id = parseAssetId("NK0000000001");

    const placed = await store.put(file, id, "bin", "copy");
    const [source, stored] = await Promise.all([stat(file), stat(placed.path)]);

    expect(stored.ino).not.toBe(source.ino);
    expect(source.nlink).toBe(1);
  });

  it("reports the placement the filesystem actually gave it", async () => {
    const file = join(src, "method.bin");
    await writeFile(file, "method");
    const id = parseAssetId("PQ0000000001");

    const placed = await store.put(file, id, "bin", "copy");

    // ADR-0012: `COPYFILE_FICLONE_FORCE` refuses rather than silently copying,
    // which is what makes the answer honest either way.
    expect(placed.placement).toBe(reflinkable ? "reflink" : "copy");
  });

  it("moves within one filesystem by renaming, which costs nothing", async () => {
    const file = join(src, "renamed.bin");
    await writeFile(file, "renamed");
    const id = parseAssetId("RN0000000001");

    expect((await store.put(file, id, "bin", "move")).placement).toBe("rename");
  });

  // Linux's, because the way it finds a second filesystem is `/proc/mounts`.
  // The rung it exercises is not Linux's — every platform falls to a plain copy
  // across a device boundary — but nothing portable can produce one on demand.
  it.runIf(onLinux)("falls to a copy across filesystems, and still moves", async (ctx) => {
    const crossDir = await tmpfsDir("roost-cross-");
    try {
      if ((await stat(crossDir)).dev === (await stat(lib)).dev) {
        // Only one filesystem here, so there is nothing to cross. Skipped
        // rather than silently returning: a test that passes without asserting
        // anything reads as coverage it does not provide.
        ctx.skip();
      }

      const file = join(crossDir, "cross.bin");
      await writeFile(file, "cross");
      const id = parseAssetId("XD0000000001");

      const placed = await store.put(file, id, "bin", "move");

      // EXDEV is an ordinary answer rather than a failure: the bytes are
      // copied and the source unlinked afterwards, so the user's file is never
      // gone before the library's file exists.
      expect(placed.placement).toBe("copy");
      expect(placed.take).toBe("move");
      await expect(stat(file)).rejects.toThrow();
    } finally {
      await rm(crossDir, { recursive: true, force: true });
    }
  });

  it("writes new bytes over the file the id names, which is an ordinary edit", async () => {
    // RL-20: the bytes may change at any time and the asset is the same asset
    // afterwards. The path is the assertion — a save that produced a second
    // address would be version 1's behaviour.
    const id = parseAssetId("ED0000000001");
    const first = await store.writeBytes(new TextEncoder().encode("before"), id, "txt");
    const second = await store.writeBytes(new TextEncoder().encode("after"), id, "txt");

    expect(second).toBe(first);
    expect(await readFile(second, "utf8")).toBe("after");
  });

  it("removes what it placed, and removing it twice is still success", async () => {
    const file = join(src, "delete.bin");
    await writeFile(file, "delete");
    const id = parseAssetId("DK0000000001");
    await store.put(file, id, "bin", "copy");

    await store.remove(id, "bin");
    await expect(store.remove(id, "bin")).resolves.toBeUndefined();
    await expect(stat(store.locate(id, "bin"))).rejects.toThrow();
  });
});

// A copy that can be counted and stopped (ADR-0054 §3.9). Across a device, so
// that the reflink rung refuses and the counted copy is the one that runs.
describe.runIf(onLinux)("a counted copy", () => {
  let lib: string;
  let src: string;
  let store: FileStore;
  const SIZE = 10 * 1024 * 1024 + 17;

  beforeAll(async () => {
    await mkdir(REPO_FS_ROOT, { recursive: true });
    src = await mkdtemp(join(REPO_FS_ROOT, "counted-src-"));
    lib = await tmpfsDir("roost-counted-");
    store = new FileStore(lib);
    await writeFile(join(src, "big.bin"), Buffer.alloc(SIZE, 7));
  });

  afterAll(async () => {
    await rm(lib, { recursive: true, force: true });
    await rm(src, { recursive: true, force: true });
  });

  it("reports every byte it writes, and makes the same file", async () => {
    let counted = 0;
    const placed = await store.put(join(src, "big.bin"), ID, "bin", "copy", {
      onBytes: (count) => {
        counted += count;
      },
    });

    expect(placed.placement).toBe("copy");
    expect(counted).toBe(SIZE);
    // `equals` rather than `toEqual`, which walks ten megabytes an element at a
    // time and took forty seconds to say yes.
    expect((await readFile(placed.path)).equals(await readFile(join(src, "big.bin")))).toBe(true);
  });

  it("stops when asked, and leaves nothing behind", async () => {
    const controller = new AbortController();
    const placing = store.put(join(src, "big.bin"), OTHER, "bin", "copy", {
      // After the first chunk, so the copy is genuinely half made.
      onBytes: () => controller.abort(),
      signal: controller.signal,
    });

    await expect(placing).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(join(store.filesDir(), "B7"))).toEqual([]);
    // The source is the caller's, and a stopped copy has no business with it.
    expect((await stat(join(src, "big.bin"))).size).toBe(SIZE);
  });
});

describe("walking the store", () => {
  let lib: string;
  let store: FileStore;

  beforeAll(async () => {
    lib = await mkdtemp(join(tmpdir(), "roost-walk-"));
    store = new FileStore(lib);
    await mkdir(join(lib, "files", "K7"), { recursive: true });
    await mkdir(join(lib, "files", "H8"), { recursive: true });
    await writeFile(join(lib, "files", "K7", "K7QM4X2AJH9F.docx"), "doc");
    // Word's lock file, left beside the document it opened.
    await writeFile(join(lib, "files", "K7", "~$QM4X2AJH9F.docx"), "lock");
    await writeFile(join(lib, "files", "H8", "H8VKC0S6ZB1P"), "licence");
    // Directly in files/, which is not a shard.
    await writeFile(join(lib, "files", "stray.txt"), "stray");
  });

  afterAll(async () => {
    await rm(lib, { recursive: true, force: true });
  });

  const collect = async () => {
    const found = [];
    for await (const file of store.iterAll()) found.push(file);
    return found.sort((a, b) => a.id.localeCompare(b.id));
  };

  it("is empty, not an error, before anything is imported", async () => {
    const empty = new FileStore(await mkdtemp(join(tmpdir(), "roost-empty-")));
    const found = [];
    for await (const file of empty.iterAll()) found.push(file);
    expect(found).toEqual([]);
  });

  it("parses the extension back off the name, and a bare id as none", async () => {
    expect(await collect()).toEqual([
      {
        id: "H8VKC0S6ZB1P",
        ext: "",
        path: join(lib, "files", "H8", "H8VKC0S6ZB1P"),
      },
      {
        id: "K7QM4X2AJH9F",
        ext: "docx",
        path: join(lib, "files", "K7", "K7QM4X2AJH9F.docx"),
      },
    ]);
  });

  it("neither adopts nor deletes a file whose name is not an id (RL-11)", async () => {
    // Applications leave things beside the file they opened, and deleting them
    // would put Roost in the business of guessing which of somebody's files
    // are rubbish. Reporting them is the whole of what RL-11 asks.
    const unrecognised = [];
    for await (const path of store.iterUnrecognised()) unrecognised.push(path);

    expect(unrecognised).toEqual([join(lib, "files", "K7", "~$QM4X2AJH9F.docx")]);
    await expect(stat(join(lib, "files", "K7", "~$QM4X2AJH9F.docx"))).resolves.toBeTruthy();
  });

  it("re-derives each path exactly, which is what makes the layout a rule", async () => {
    for (const file of await collect()) {
      expect(store.locate(file.id, file.ext)).toBe(file.path);
    }
  });

  it("finds every file an id has, which is how RL-12 is reported", async () => {
    const id = parseAssetId("K7QM4X2AJH9F");
    expect(await store.findFiles(id)).toHaveLength(1);

    // An id with two files is what RL-12 forbids and requires be reported
    // rather than chosen between.
    await writeFile(join(lib, "files", "K7", "K7QM4X2AJH9F.pdf"), "pdf");
    expect(await store.findFiles(id)).toHaveLength(2);
    await rm(join(lib, "files", "K7", "K7QM4X2AJH9F.pdf"));

    expect(await store.findFiles(parseAssetId("ZZ0000000000"))).toEqual([]);
  });
});
