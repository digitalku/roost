import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotInObjectStoreError, parseContentHash } from "../model/index.js";
import { ManagedStorage } from "./managed.js";
import { ReferencedStorage } from "./referenced.js";
import { normalizeExt } from "./types.js";

const HASH = parseContentHash(`3f${"a".repeat(62)}`);
const OTHER = parseContentHash(`b7${"c".repeat(62)}`);

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

describe("ManagedStorage.locate", () => {
  const store = new ManagedStorage("/lib");

  it("shards on the first two characters, one level only", () => {
    expect(store.locate(HASH, "jpg")).toBe(`/lib/originals/3f/${HASH}.jpg`);
  });

  it("normalises the extension into the filename", () => {
    expect(store.locate(HASH, ".JPG")).toBe(`/lib/originals/3f/${HASH}.jpg`);
  });

  it("uses the bare hash when there is no extension, with no trailing dot", () => {
    // A trailing dot would round-trip through iterAll as an empty extension on
    // a differently-named file, which is a different address for one asset.
    expect(store.locate(HASH, "")).toBe(`/lib/originals/3f/${HASH}`);
  });
});

describe("ManagedStorage, on a real filesystem", () => {
  let lib: string;
  let src: string;
  let store: ManagedStorage;
  let reflinkable: boolean;

  beforeAll(async () => {
    await mkdir(REPO_FS_ROOT, { recursive: true });
    lib = await mkdtemp(join(REPO_FS_ROOT, "lib-"));
    src = await mkdtemp(join(REPO_FS_ROOT, "src-"));
    store = new ManagedStorage(lib);
    reflinkable = await supportsReflink(lib);
  });

  afterAll(async () => {
    await rm(lib, { recursive: true, force: true });
    await rm(src, { recursive: true, force: true });
  });

  it("creates the shard directory lazily, and only the one it needs", async () => {
    const file = join(src, "one.bin");
    await writeFile(file, "one");
    await store.put(file, HASH, "bin");

    expect(await readdir(store.originalsDir())).toEqual(["3f"]);
  });

  it("leaves the caller's file exactly where it was, and unchanged", async () => {
    const file = join(src, "keep.bin");
    await writeFile(file, "keep");
    await store.put(file, OTHER, "bin");

    expect(await readFile(file, "utf8")).toBe("keep");
  });

  it("leaves no temp file behind", async () => {
    const entries = await readdir(join(store.originalsDir(), "3f"));
    expect(entries.filter((e) => e.startsWith("."))).toEqual([]);
  });

  it("is idempotent: a second put places nothing and says so", async () => {
    const file = join(src, "again.bin");
    await writeFile(file, "again");
    const hash = parseContentHash(`11${"d".repeat(62)}`);

    const first = await store.put(file, hash, "bin");
    const second = await store.put(file, hash, "bin");

    expect(first.alreadyPresent).toBe(false);
    expect(first.linkMethod).not.toBeNull();
    expect(second.alreadyPresent).toBe(true);
    // Nothing was linked the second time, so there is no method to report.
    expect(second.linkMethod).toBeNull();
  });

  it("reports the link method the filesystem actually gave it", async () => {
    const file = join(src, "method.bin");
    await writeFile(file, "method");
    const hash = parseContentHash(`22${"e".repeat(62)}`);

    const placed = await store.put(file, hash, "bin");

    if (reflinkable) {
      // ADR-0012: COPYFILE_FICLONE_FORCE succeeded, so it genuinely cloned.
      expect(placed.linkMethod).toBe("reflink");
    } else {
      // The filesystem refused rather than silently copying — which is the
      // whole reason the FORCE flag is used. Same filesystem, so hardlink is
      // the next rung and it must not be misreported as a reflink.
      expect(placed.linkMethod).toBe("hardlink");
    }
  });

  it("falls to a plain copy across filesystems, and never calls it a reflink", async (ctx) => {
    const crossDir = await mkdtemp(join(tmpdir(), "roost-cross-"));
    try {
      if ((await stat(crossDir)).dev === (await stat(lib)).dev) {
        // Only one filesystem here, so there is nothing to cross. Skipped
        // rather than silently returning: a test that passes without asserting
        // anything reads as coverage it does not provide.
        ctx.skip();
      }

      const file = join(crossDir, "cross.bin");
      await writeFile(file, "cross");
      const hash = parseContentHash(`33${"f".repeat(62)}`);

      const placed = await store.put(file, hash, "bin");
      expect(placed.linkMethod).toBe("copy");
    } finally {
      await rm(crossDir, { recursive: true, force: true });
    }
  });

  it("removes what it placed, and removing it twice is still success", async () => {
    const file = join(src, "gone.bin");
    await writeFile(file, "gone");
    const hash = parseContentHash(`44${"a".repeat(62)}`);
    await store.put(file, hash, "bin");

    await store.remove(hash, "bin");
    await expect(store.remove(hash, "bin")).resolves.toBeUndefined();
    await expect(stat(store.locate(hash, "bin"))).rejects.toThrow();
  });
});

describe("ManagedStorage.iterAll", () => {
  let lib: string;
  let store: ManagedStorage;

  beforeAll(async () => {
    lib = await mkdtemp(join(tmpdir(), "roost-iter-"));
    store = new ManagedStorage(lib);
  });

  afterAll(async () => {
    await rm(lib, { recursive: true, force: true });
  });

  const collect = async () => {
    const found = [];
    for await (const file of store.iterAll()) found.push(file);
    return found;
  };

  it("is empty, not an error, before anything is imported", async () => {
    expect(await collect()).toEqual([]);
  });

  it("yields what it finds, with the extension parsed back off the name", async () => {
    const shard = join(store.originalsDir(), "3f");
    await mkdir(shard, { recursive: true });
    await writeFile(join(shard, `${HASH}.jpg`), "x");

    expect(await collect()).toEqual([{ hash: HASH, ext: "jpg", path: join(shard, `${HASH}.jpg`) }]);
  });

  it("reads a bare hash back as an empty extension", async () => {
    const bare = parseContentHash(`3f${"b".repeat(62)}`);
    await writeFile(join(store.originalsDir(), "3f", bare), "x");

    const found = await collect();
    expect(found.find((f) => f.hash === bare)?.ext).toBe("");
  });

  it("skips a torn temp file rather than reporting it as content", async () => {
    // A partially written object at a real address would look like valid
    // content addressed by a hash it does not have. The leading dot is what
    // keeps it out, and this is the test that says so.
    const shard = join(store.originalsDir(), "3f");
    await writeFile(join(shard, `.${HASH}.jpg.tmp-1234-0`), "torn");

    expect((await collect()).every((f) => !f.path.includes(".tmp-"))).toBe(true);
  });

  it("skips a stray file rather than failing a rebuild that would otherwise work", async () => {
    await writeFile(join(store.originalsDir(), "3f", "notes.txt"), "stray");

    expect((await collect()).every((f) => !f.path.endsWith("notes.txt"))).toBe(true);
  });

  it("ignores a file sitting directly in originals/, which is not a shard", async () => {
    await writeFile(join(store.originalsDir(), `${HASH}.jpg`), "misplaced");

    expect((await collect()).every((f) => f.path.includes("/3f/"))).toBe(true);
  });
});

describe("ReferencedStorage", () => {
  const store = new ReferencedStorage();

  it("writes nothing and reports the file where the user left it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roost-ref-"));
    const file = join(dir, "theirs.jpg");
    await writeFile(file, "theirs");

    const placed = await store.put(file, HASH, "jpg");

    expect(placed.path).toBe(file);
    expect(placed.linkMethod).toBeNull();
    expect(placed.alreadyPresent).toBe(true);
    // The only thing in the user's directory is the user's file.
    expect(await readdir(dir)).toEqual(["theirs.jpg"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses to invent a path, because it does not own these bytes", () => {
    expect(() => store.locate(HASH)).toThrow(NotInObjectStoreError);
  });

  it("carries a code a caller can act on, not just a message", () => {
    try {
      store.locate(HASH);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as NotInObjectStoreError).code).toBe("not_in_object_store");
    }
  });

  it("never deletes the user's file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roost-ref-"));
    const file = join(dir, "safe.jpg");
    await writeFile(file, "safe");

    await store.remove();

    expect(await readFile(file, "utf8")).toBe("safe");
    await rm(dir, { recursive: true, force: true });
  });

  it("walks nothing, because there is no object store to walk", async () => {
    const found = [];
    for await (const file of store.iterAll()) found.push(file);
    expect(found).toEqual([]);
  });
});

describe("against an object store written by the Rust implementation", () => {
  // A real fragment of a real library, produced by `../roost-old` importing five
  // files in managed mode. See its README for provenance.
  const store = new ManagedStorage(join(import.meta.dirname, "__fixtures__/rust-written-library"));

  const collect = async () => {
    const found = [];
    for await (const file of store.iterAll()) found.push(file);
    return found;
  };

  it("finds every object the other implementation wrote", async () => {
    expect((await collect()).length).toBe(5);
  });

  it("re-derives each path exactly, which is the compatibility promise", async () => {
    // If this ever fails, this implementation has stopped writing files where
    // the other one reads them, and a library no longer opens in both
    // (`CONCEPT.md` §7). Round-tripping through parse and locate is the whole
    // check: it exercises sharding, filename construction, and the extension.
    for (const file of await collect()) {
      expect(store.locate(file.hash, file.ext)).toBe(file.path);
    }
  });

  it("reads back the extensions the other implementation chose", async () => {
    const byExt = (await collect()).map((f) => f.ext).sort();
    // `b.tar.gz` is stored as `.gz`: the importer records the *last* component,
    // not every suffix. `noext` is stored bare and reads back as "".
    expect(byExt).toEqual(["", "gz", "jpeg", "jpg", "png"]);
  });
});
