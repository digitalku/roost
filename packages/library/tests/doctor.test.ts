import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AssetId, shardOf } from "@roost/core";
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

  /** Where the store put an asset's bytes. */
  const filePath = (id: AssetId): string => {
    const detail = library.db.repo.assetDetail(id);
    return library.storage.locate(id, detail?.ext ?? "");
  };

  it("finds nothing wrong with a library it just built", async () => {
    const report = await check(library);

    expect(isClean(report)).toBe(true);
    expect(report.assets).toBe(3);
    expect(report.files).toBe(3);
    expect(report.deep).toBe(false);
  });

  it("counts bytes nothing references as waste, not as damage", async () => {
    // An orphan is made by hand, because a removal no longer leaves one behind
    // (ADR-0031): the row and its object go together now. What is left for
    // reclaiming is wreckage — an import interrupted between the file and the
    // row, or a library carried over from a build that kept the bytes.
    const stray = join(dir, "stray.bin");
    await writeFile(stray, "orphaned payload");
    // Named for an asset the library does not hold, which is what makes it an
    // orphan rather than a file RL-11 covers.
    const { path } = await library.storage.put(stray, "0RPHAN000001" as never, "bin", "copy");

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

  it("refuses to reclaim while the index and the disk disagree", async () => {
    const id = library.db.repo.allIds()[0] as AssetId;
    // Bytes gone, row still there: every other file now looks unreferenced for
    // all this check can prove, because the index may be the broken part.
    await rm(filePath(id));

    const report = await check(library);

    expect(report.missingFiles.map((missing) => missing.id)).toEqual([id]);
    expect(hasDamage(report)).toBe(true);
    expect(unsoundForReclaim(report)).toContain("point at bytes that are not there");
    await expect(reclaim(library, report)).rejects.toBeInstanceOf(UnsoundReclaimError);

    // `--force` exists for bytes a rebuild cannot bring back, and it is the
    // only way past the refusal.
    await expect(reclaim(library, report, "even-if-damaged")).resolves.toBe(0);
  });

  it("neither adopts nor deletes a file whose name is not an id (RL-11)", async () => {
    // Word leaves `~$…` beside the document it opened. Adopting it would
    // invent an asset nobody imported; deleting it would put Roost in the
    // business of guessing which of somebody's files are rubbish.
    const id = library.db.repo.allIds()[0] as AssetId;
    const lock = join(dirname(filePath(id)), "~$QM4X2AJH9F.docx");
    await writeFile(lock, "lock");

    const report = await check(library);

    expect(report.unrecognised.map((entry) => entry.path)).toEqual([lock]);
    expect(report.orphans).toEqual([]);
    // Not damage, and not reclaimable either: the file is somebody else's.
    expect(hasDamage(report)).toBe(false);
    await reclaim(library, report);
    await expect(stat(lock)).resolves.toBeTruthy();
  });

  it("reports an id with two files, and chooses neither (RL-12)", async () => {
    const id = library.db.repo.allIds()[0] as AssetId;
    await writeFile(`${filePath(id).replace(/\.[^.]+$/, "")}.pdf`, "a second file");

    const report = await check(library);

    expect(report.ambiguous.map((entry) => entry.id)).toEqual([id]);
    expect(report.ambiguous[0]?.paths).toHaveLength(2);
    expect(hasDamage(report)).toBe(true);
    expect(unsoundForReclaim(report)).toContain("more than one file");
  });

  it("reports bytes that changed as changed, never as damage", async () => {
    // What version 2 gave up, said out loud: an edit and bit rot are
    // indistinguishable here (`SPEC.md` §5), so a build that called this
    // corruption would be crying wolf at the product's main feature.
    const id = library.db.repo.allIds()[0] as AssetId;
    await writeFile(filePath(id), "the user saved something else");

    // A shallow run sees a file where a file should be, and that is all it
    // claims to check.
    expect((await check(library)).changed).toEqual([]);

    const deep = await check(library, { deep: true });

    expect(deep.changed).toHaveLength(1);
    expect(deep.changed[0]?.id).toBe(id);
    expect(deep.changed[0]?.actualHash).not.toBe(deep.changed[0]?.derivedHash);
    expect(hasDamage(deep)).toBe(false);
    expect(unsoundForReclaim(deep)).toBeUndefined();
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

  it("looks in the one place the shard rule puts a file", async () => {
    // Not an assertion about doctor so much as about what it is checking: if
    // the store ever sharded differently, the walk and the lookup would still
    // agree with each other and both be wrong.
    const id = library.db.repo.allIds()[0] as AssetId;
    expect(filePath(id)).toContain(join("files", shardOf(id), id));
  });
});
