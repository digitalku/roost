import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContentHash, shardOf } from "@roost/core";
import {
  check,
  hasDamage,
  importInto,
  isClean,
  Library,
  reclaim,
  reclaimableBytes,
  UnsoundReclaimError,
  unsoundForReclaim,
} from "@roost/library";
import { hashFile } from "@roost/media";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("checking a library against itself", () => {
  let dir: string;
  let source: string;
  let library: Library;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-doctor-"));
    source = join(dir, "pictures");
    await mkdir(source, { recursive: true });
    for (const index of [1, 2, 3]) {
      await writeFile(join(source, `file-${index}.bin`), `payload ${index}`);
    }

    library = await Library.create(join(dir, "library"), "test");
    await importInto(library, [source]);
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Where the object store put an asset's bytes. */
  const objectPath = (hash: ContentHash): string => {
    const detail = library.db.repo.assetDetail(hash);
    return library.storageFor("managed").locate(hash, detail?.ext ?? "");
  };

  it("finds nothing wrong with a library it just built", async () => {
    const report = await check(library);

    expect(isClean(report)).toBe(true);
    expect(report.assets).toBe(3);
    expect(report.objects).toBe(3);
    expect(report.deep).toBe(false);
  });

  it("counts bytes nothing references as waste, not as damage", async () => {
    // An orphan is made by hand, because a removal no longer leaves one behind
    // (ADR-0031): the row and its object go together now. What is left for
    // reclaiming is wreckage — an import interrupted between the file and the
    // row, or a library carried over from a build that kept the bytes.
    const stray = join(dir, "stray.bin");
    await writeFile(stray, "orphaned payload");
    const { hash } = await hashFile(stray);
    const { path } = await library.storageFor("managed").put(stray, hash, "bin");

    const report = await check(library);

    expect(report.orphans.map((orphan) => orphan.path)).toEqual([path]);
    // Waste costs space and nothing else, so it must not make `doctor` report a
    // damaged library — a check that cries wolf is a check nobody runs.
    expect(hasDamage(report)).toBe(false);
    expect(unsoundForReclaim(report)).toBeUndefined();
    expect(reclaimableBytes(report)).toBeGreaterThan(0);

    const freed = await reclaim(library, report);

    expect(freed).toBe(reclaimableBytes(report));
    expect(isClean(await check(library))).toBe(true);
  });

  it("refuses to reclaim while the index and the object store disagree", async () => {
    const hash = library.db.repo.allHashes()[0] as ContentHash;
    // Bytes gone, row still there: every other object now looks unreferenced
    // for all this check can prove, because the index may be the broken part.
    await rm(objectPath(hash));

    const report = await check(library);

    expect(report.missingObjects.map((missing) => missing.hash)).toEqual([hash]);
    expect(hasDamage(report)).toBe(true);
    expect(unsoundForReclaim(report)).toContain("point at bytes that are not there");
    await expect(reclaim(library, report)).rejects.toBeInstanceOf(UnsoundReclaimError);

    // `--force` exists for bytes a rebuild cannot bring back, and it is the
    // only way past the refusal.
    await expect(reclaim(library, report, "even-if-damaged")).resolves.toBe(0);
  });

  it("does not let a moved referenced original block reclaiming forever", async () => {
    // A referenced original that moved says the user moved their own file. It
    // is worth reporting and it is not evidence the index is wrong — and no
    // rebuild can bring back a file someone meant to delete, so counting it
    // would block reclaiming permanently.
    const outside = join(dir, "elsewhere");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "linked.bin"), "referenced payload");
    await importInto(library, [outside], { mode: "referenced" });
    await rename(join(outside, "linked.bin"), join(outside, "moved.bin"));

    const report = await check(library);

    expect(report.missingReferences).toHaveLength(1);
    expect(report.missingObjects).toEqual([]);
    expect(hasDamage(report)).toBe(true);
    expect(unsoundForReclaim(report)).toBeUndefined();
  });

  it("catches an object whose bytes changed under it, but only when asked", async () => {
    const hash = library.db.repo.allHashes()[0] as ContentHash;
    await writeFile(objectPath(hash), "not what the filename says");

    // A shallow run sees a file where a file should be, and that is all it
    // claims to check.
    expect((await check(library)).corrupt).toEqual([]);

    const deep = await check(library, { deep: true });

    expect(deep.corrupt).toHaveLength(1);
    expect(deep.corrupt[0]?.expectedHash).toBe(hash);
    expect(deep.corrupt[0]?.actualHash).not.toBe(hash);
    expect(unsoundForReclaim(deep)).toContain("no longer match their hash");
  });

  it("reports a journal file replay will never read", async () => {
    // Renaming a month makes it invisible to replay, silently. Nothing else in
    // the system notices until a rebuild loses that month.
    const month = (await library.journal.months())[0] as string;
    await library.journal.close();
    await rename(library.journal.pathFor(month), join(library.journal.dir, "backup.jsonl.old"));

    const report = await check(library);

    expect(report.strayJournalFiles).toEqual(["backup.jsonl.old"]);
    expect(hasDamage(report)).toBe(true);
    // A month replay cannot see is a month the index does not hold, so every
    // asset in it would look like an orphan.
    expect(unsoundForReclaim(report)).toContain("journal/");
  });

  it("looks in the one place the shard rule puts an object", async () => {
    // Not an assertion about doctor so much as about what it is checking: if
    // the store ever sharded differently, the walk and the lookup would still
    // agree with each other and both be wrong.
    const hash = library.db.repo.allHashes()[0] as ContentHash;
    expect(objectPath(hash)).toContain(`/originals/${shardOf(hash)}/${hash}`);
  });
});
