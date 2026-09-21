import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetId } from "@roost/core";
import { exportAssets, importInto, Library, renameAsset } from "@roost/library";
import { gradient } from "@roost/media";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("exporting originals out of a library", () => {
  let dir: string;
  let out: string;
  let library: Library;
  let ids: AssetId[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-export-"));
    out = join(dir, "out");
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

  /**
   * The id of the asset the library shows under `name`. `allIds` is not ordered.
   *
   * The name carries no extension (RL-33), so `alpha` finds `alpha.png`: the
   * filename an export writes is the name joined to the extension on disk.
   */
  const idOf = (name: string): AssetId =>
    ids.find((id) => library.db.repo.findAsset(id)?.name === name) as AssetId;

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the library's names, not the store's", async () => {
    // The store's filename is the asset's id (RL-9). A folder of ids is not
    // an export anybody wanted.
    const report = await exportAssets(library, ids, out);

    expect(report).toEqual({ exported: 3, renamed: 0, missing: 0, failed: 0 });
    expect((await readdir(out)).sort()).toEqual(["alpha.png", "beta.png", "gamma.jpg"]);
  });

  it("copies the bytes, and leaves the originals where they were", async () => {
    const alpha = idOf("alpha");
    await exportAssets(library, [alpha], out);

    const written = (await readdir(out))[0] as string;
    const record = library.db.repo.findFile(alpha);
    const stored = library.storage.locate(alpha, record?.ext ?? "");

    expect(await readFile(join(out, written))).toEqual(await readFile(stored));
    // Invariant 6 is about the other direction, and an export must not become
    // a move: the store still holds what it held.
    expect(await readFile(stored)).toBeDefined();
  });

  it("suffixes a name the destination already holds, and says how often", async () => {
    await exportAssets(library, ids, out);
    const again = await exportAssets(library, ids, out);

    expect(again.exported).toBe(3);
    expect(again.renamed).toBe(3);
    expect((await readdir(out)).sort()).toEqual([
      "alpha (2).png",
      "alpha.png",
      "beta (2).png",
      "beta.png",
      "gamma (2).jpg",
      "gamma.jpg",
    ]);
  });

  it("refuses to let a name escape the directory the user chose", async () => {
    // The name is user-authored — `roost rename` will take anything the
    // library's own rules allow — so it is not trusted as a path.
    const alpha = idOf("alpha");
    await renameAsset(library, alpha, "../escaped");
    await exportAssets(library, [alpha], out);

    expect(await readdir(out)).toEqual(["escaped.png"]);
    expect(await readdir(dir)).not.toContain("escaped.png");
  });

  it("keeps the extension when a rename dropped or contradicted it", async () => {
    // A file the desktop cannot open is not an export, and the library allows a
    // name with no extension at all — or with the wrong one, which is why the
    // real extension is appended rather than substituted: `photo.png.jpg` says
    // what happened, and silently rewriting the name the user chose does not.
    const alpha = idOf("alpha");
    await renameAsset(library, alpha, "no extension here");
    await exportAssets(library, [alpha], out);

    expect(await readdir(out)).toEqual(["no extension here.png"]);

    const beta = idOf("beta");
    await renameAsset(library, beta, "lying.jpg");
    await exportAssets(library, [beta], out);
    expect(await readdir(out)).toContain("lying.jpg.png");
  });

  it("counts an asset it cannot find rather than failing the run", async () => {
    const missing = "ZZZZZZZZZZZZ" as AssetId;
    const report = await exportAssets(library, [missing, ...ids], out);

    expect(report).toEqual({ exported: 3, renamed: 0, missing: 1, failed: 0 });
    expect(await readdir(out)).toHaveLength(3);
  });

  it("creates the destination when it is not there yet", async () => {
    const nested = join(out, "one", "two");
    const report = await exportAssets(library, [idOf("alpha")], nested);

    expect(report.exported).toBe(1);
    expect(await readdir(nested)).toHaveLength(1);
  });
});
