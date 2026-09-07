import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileNameFor, STAGING_DIR, stageFile, sweepStaging } from "./handoff.js";

/**
 * Handing a file to another application (ADR-0034).
 *
 * What is under test is the *name*, which is the whole reason this exists: the
 * store names a file by its hash, and no other application can read that.
 */
describe("staging a file for another application", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "roost-handoff-"));
    await mkdir(join(root, "originals"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const original = async (name: string, contents = "bytes"): Promise<string> => {
    const path = join(root, "originals", name);
    await writeFile(path, contents);
    return path;
  };

  it("puts the file under the name the library shows", async () => {
    const source = await original("a3f2c9d1.jpg", "a picture");
    const { path } = await stageFile(root, source, "Holiday in Bali.jpg");

    expect(path).toBe(join(root, STAGING_DIR, "Holiday in Bali.jpg"));
    expect(await readFile(path, "utf8")).toBe("a picture");
  });

  it("leaves the original alone, whatever happens to the copy", async () => {
    // The reason a hardlink is not on this ladder even though the importer's
    // is: an application given the file may write to it, and a shared inode
    // would put those bytes in the library's own original (invariant 6).
    const source = await original("a3f2c9d1.jpg", "as imported");
    const { path } = await stageFile(root, source, "picture.jpg");

    await writeFile(path, "edited by somebody else");
    expect(await readFile(source, "utf8")).toBe("as imported");
  });

  it("suffixes rather than overwriting a name already staged", async () => {
    // Two assets can carry one name, and the first copy may still be being read
    // by whoever it was handed to.
    const first = await original("aa.jpg", "one");
    const second = await original("bb.jpg", "two");
    await stageFile(root, first, "shot.jpg");
    const { path } = await stageFile(root, second, "shot.jpg");

    expect(path).toBe(join(root, STAGING_DIR, "shot (1).jpg"));
    expect(await readFile(join(root, STAGING_DIR, "shot.jpg"), "utf8")).toBe("one");
    expect(await readFile(path, "utf8")).toBe("two");
  });

  it("empties the staging directory, and does not mind an absent one", async () => {
    expect(await sweepStaging(root)).toBe(0);

    await stageFile(root, await original("aa.jpg"), "one.jpg");
    await stageFile(root, await original("bb.jpg"), "two.jpg");
    expect(await sweepStaging(root)).toBe(2);
    expect(await readdir(join(root, STAGING_DIR))).toEqual([]);
  });
});

describe("the name a file is handed over under", () => {
  it("keeps the name the library shows", () => {
    expect(fileNameFor("Holiday in Bali.jpg", "jpg")).toBe("Holiday in Bali.jpg");
  });

  it("restores an extension a rename dropped", () => {
    // A file the desktop cannot open is not a file anybody can use.
    expect(fileNameFor("Holiday in Bali", "jpg")).toBe("Holiday in Bali.jpg");
  });

  it("refuses to let a name reach outside the directory", () => {
    // The name is user-authored. Without `basename`, handing a file over would
    // be a way to write anywhere the process can reach.
    expect(fileNameFor("../../.bashrc", "jpg")).toBe(".bashrc.jpg");
    expect(fileNameFor("..", "jpg")).toBe("asset.jpg");
    expect(fileNameFor("   ", "")).toBe("asset");
  });
});
