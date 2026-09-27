import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "@roost/core";
import { check, type ImportBytes, importInto, LARGE_FILE, Library, measure } from "@roost/library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** An import that counts bytes and can be stopped (ADR-0055). */
describe("an import's progress, and stopping it", () => {
  let dir: string;
  let source: string;
  let library: Library;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-import-progress-"));
    source = join(dir, "incoming");
    await mkdir(source, { recursive: true });
    library = await Library.create(join(dir, "library"), "test");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** A file of `size` random bytes, so no two are duplicates. */
  const file = async (name: string, size: number): Promise<string> => {
    const path = join(source, name);
    await writeFile(path, randomBytes(size));
    return path;
  };

  /** Every file in `files/`, shards included, whatever it is called. */
  const stored = async (): Promise<string[]> => {
    const root = join(library.root, "files");
    const shards = await readdir(root).catch(() => []);
    const names: string[] = [];
    for (const shard of shards) names.push(...(await readdir(join(root, shard))));
    return names;
  };

  it("counts the sources before reading them, and ends at the total", async () => {
    await file("a.bin", 1_000);
    await file("b.bin", 2_000);
    await mkdir(join(source, "deeper"));
    await writeFile(join(source, "deeper", "c.bin"), randomBytes(3_000));

    const seen: ImportBytes[] = [];
    const report = await importInto(library, [source], { onBytes: (bytes) => seen.push(bytes) });

    expect(report.imported).toBe(3);
    expect(report.cancelled).toBe(false);
    // Counting comes first, and reads nothing.
    const counting = seen.filter((bytes) => bytes.counting);
    expect(counting.length).toBeGreaterThan(0);
    expect(counting.every((bytes) => bytes.bytesDone === 0)).toBe(true);
    expect(seen.findIndex((bytes) => !bytes.counting)).toBeGreaterThan(
      seen.findLastIndex((bytes) => bytes.counting),
    );
    // Then the total is known from the first byte, and never moves.
    const importing = seen.filter((bytes) => !bytes.counting);
    expect(importing.every((bytes) => bytes.files === 3 && bytes.bytesTotal === 6_000)).toBe(true);
    expect(importing.at(-1)?.bytesDone).toBe(6_000);
    // And it only ever goes forward.
    const done = importing.map((bytes) => bytes.bytesDone);
    expect(done).toEqual([...done].sort((a, b) => a - b));
  });

  it("measures what the walk would find, and nothing else", async () => {
    await file("a.bin", 10);
    await file(".hidden", 20);
    const measured = await measure([source], library.root, false);
    expect(measured).toEqual({ files: 1, bytes: 10 });
    expect(await measure([source], library.root, true)).toEqual({ files: 2, bytes: 30 });
  });

  it("keeps what arrived when stopped, and a second run brings the rest", async () => {
    for (let index = 0; index < 40; index += 1) await file(`f${index}.bin`, 4_096);
    const controller = new AbortController();

    const report = await importInto(library, [source], {
      signal: controller.signal,
      // After the first file is placed: some are in flight, most not started.
      onAsset: () => controller.abort(),
    });

    expect(report.cancelled).toBe(true);
    expect(report.imported).toBeGreaterThan(0);
    expect(report.imported).toBeLessThan(40);
    // A stop is not a failure.
    expect(report.failed).toEqual([]);
    // Every file placed was committed: nothing in `files/` without a row, and
    // nothing the doctor would call an orphan.
    expect(await stored()).toHaveLength(report.imported);
    expect(library.db.repo.stats().assets).toBe(report.imported);
    expect((await check(library)).orphans).toEqual([]);
    // Copied, so every source is still there.
    expect(await readdir(source)).toHaveLength(40);

    const again = await importInto(library, [source]);
    expect(again.cancelled).toBe(false);
    expect(again.duplicates).toBe(report.imported);
    expect(again.imported).toBe(40 - report.imported);
  });

  it("stops while counting, having written nothing", async () => {
    await file("a.bin", 100);
    const controller = new AbortController();

    const report = await importInto(library, [source], {
      signal: controller.signal,
      onBytes: (bytes) => {
        if (bytes.counting) controller.abort();
      },
    });

    expect(report.cancelled).toBe(true);
    expect(report.scanned).toBe(0);
    expect(await stored()).toEqual([]);
    expect(library.db.repo.stats().assets).toBe(0);
  });

  it("abandons a large file half copied, and leaves its source alone", async () => {
    const big = await file("big.bin", LARGE_FILE + 1_024);
    const controller = new AbortController();

    const report = await importInto(library, [big], {
      signal: controller.signal,
      onBytes: (bytes) => {
        // Past the hash, which counts the first half: this is the copy.
        if (!bytes.counting && bytes.bytesDone > bytes.bytesTotal * 0.6) controller.abort();
      },
    });

    expect(report.cancelled).toBe(true);
    expect(report.imported).toBe(0);
    expect(report.failed).toEqual([]);
    // No partial copy, under its own name or a temporary one.
    expect(await stored()).toEqual([]);
    expect((await stat(big)).size).toBe(LARGE_FILE + 1_024);
  });

  it("keeps a moved file's own date", async () => {
    // Regression (ADR-0055 §3.5): the date was read from the source path after
    // the file had been placed, and a move had renamed it away by then, so a
    // moved file arrived with no date at all.
    const path = await file("old.bin", 64);
    await utimes(path, 1_600_000_000, 1_600_000_000);

    await importInto(library, [path], { take: "move" });

    const [id] = library.db.repo.allIds();
    expect(id).toBeDefined();
    if (id === undefined) return;
    expect(library.db.repo.assetDetail(id)?.createdAt).toBe(1_600_000_000);
  });

  it("does not report a duplicate of a file that failed to arrive", async () => {
    // Regression (ADR-0055 §3.5): a hash was claimed before its file was placed
    // and kept when placing failed, so an identical file later in the batch was
    // counted as a duplicate of an asset nothing added.
    const bytes = randomBytes(512);
    const first = join(source, "first.bin");
    const second = join(source, "second.bin");
    await writeFile(first, bytes);
    await writeFile(second, bytes);
    // Seven others between them, slowed down, so that the worker that fails the
    // first is the one free to take the second, after the failure.
    const others: string[] = [];
    for (let index = 0; index < 7; index += 1) others.push(await file(`o${index}.bin`, 256));

    const put = FileStore.prototype.put;
    vi.spyOn(FileStore.prototype, "put").mockImplementation(async function (
      this: FileStore,
      ...args: Parameters<FileStore["put"]>
    ) {
      if (args[0] === first) throw new Error("disk full");
      if (args[0] !== second) await new Promise((resolve) => setTimeout(resolve, 50));
      return put.apply(this, args);
    });

    const report = await importInto(library, [first, ...others, second]);

    expect(report.failed.map((failure) => failure.path)).toEqual([first]);
    expect(report.duplicates).toBe(0);
    expect(report.duplicateIds).toEqual([]);
    expect(report.imported).toBe(8);
  });
});
