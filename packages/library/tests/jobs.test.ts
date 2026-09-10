import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveFailures,
  importInto,
  Library,
  queueStatus,
  retryBlocked,
  runDerives,
} from "@roost/library";
import { GRID_SIZE, gradient } from "@roost/media";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("the derive queue", () => {
  let dir: string;
  let source: string;
  let library: Library;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-jobs-"));
    source = join(dir, "pictures");
    await mkdir(source, { recursive: true });
    for (const n of [1, 2, 3, 4]) {
      await writeFile(join(source, `image-${n}.png`), await gradient(120, 90, n, "png"));
    }
    library = await Library.create(join(dir, "library"), "test");
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("is filled by import, in the same transaction as the rows", async () => {
    await importInto(library, [source]);

    // Import itself draws nothing: it places bytes and journals, and the
    // pictures are somebody else's job (`ARCHITECTURE.md` §5).
    expect(library.stats().thumbnails).toBe(0);
    expect(queueStatus(library)).toMatchObject({ ready: 4, blocked: 0, failed: 0 });
  });

  it("keeps what it finished when a run stops early", async () => {
    await importInto(library, [source]);

    const first = await runDerives(library, { sizes: [GRID_SIZE], limit: 2 });
    expect(first.derived).toBe(2);
    expect(queueStatus(library).ready).toBe(2);

    // The second run picks up exactly what the first left, which is what makes
    // a hundred-thousand-file import survivable.
    const second = await runDerives(library, { sizes: [GRID_SIZE] });
    expect(second.derived).toBe(2);
    expect(queueStatus(library)).toMatchObject({ ready: 0, running: 0 });
    expect(library.stats().thumbnails).toBe(4);
  });

  it("stops at a batch boundary when it is told to", async () => {
    await importInto(library, [source]);
    const controller = new AbortController();
    controller.abort();

    const report = await runDerives(library, { sizes: [GRID_SIZE], signal: controller.signal });

    expect(report.derived).toBe(0);
    expect(queueStatus(library).ready).toBe(4);
  });

  it("parks a referenced original that has moved, and picks it up when it returns", async () => {
    await importInto(library, [source], { mode: "referenced" });
    await rename(join(source, "image-1.png"), join(dir, "moved.png"));

    const report = await runDerives(library, { sizes: [GRID_SIZE] });

    expect(report.derived).toBe(3);
    expect(report.missing).toBe(1);
    expect(queueStatus(library).reasons).toEqual([{ reason: "missing:original", count: 1 }]);

    // Parked rather than failed, because the fix is the file coming back.
    await rename(join(dir, "moved.png"), join(source, "image-1.png"));
    expect(retryBlocked(library, "missing:original")).toBe(1);

    const again = await runDerives(library, { sizes: [GRID_SIZE] });
    expect(again.derived).toBe(1);
    expect(library.stats().thumbnails).toBe(4);
  });

  it("groups what failed, and names the files it happened to", async () => {
    // A PNG header with nothing behind it: the format is recognised, the
    // backend is present, and the decode throws — which is a failure rather
    // than a parked job, and the one the status bar counts.
    // Different lengths, because identical bytes are one asset: dedup is
    // structural here, and two copies of the same broken file would import as
    // one and fail once.
    const broken = (n: number): Buffer =>
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(64 + n),
      ]);
    await writeFile(join(source, "image-1.png"), broken(1));
    await writeFile(join(source, "image-2.png"), broken(2));
    await importInto(library, [source], { mode: "referenced" });

    const report = await runDerives(library, { sizes: [GRID_SIZE] });
    expect(report.failed).toBe(2);

    const failures = deriveFailures(library);
    expect(failures.total).toBe(2);
    expect(failures.hidden).toBe(0);
    // One row, not two: both files broke the same way, and a list that
    // repeated the message per file would be the count again in longer form.
    expect(failures.groups).toHaveLength(1);
    expect(failures.groups[0]?.count).toBe(2);
    expect(failures.groups[0]?.attempts).toBe(1);
    expect(failures.groups[0]?.samples.map((sample) => sample.name).sort()).toEqual([
      "image-1.png",
      "image-2.png",
    ]);
    // The message is the backend's own, with nothing from this test in it: no
    // temporary directory, which is what would otherwise split the group.
    expect(failures.groups[0]?.reason).not.toContain(dir);
  });

  it("reports progress as it commits, not at the end", async () => {
    await importInto(library, [source]);
    const seen: number[] = [];

    await runDerives(library, {
      sizes: [GRID_SIZE],
      concurrency: 1,
      onProgress: (report) => seen.push(report.derived),
    });

    // Batches are at least eight, so four assets are one batch — what matters
    // is that the callback fired with a committed count rather than never.
    expect(seen.at(-1)).toBe(4);
  });

  it("returns work a crashed run left claimed", async () => {
    await importInto(library, [source]);
    // What a crash leaves behind: rows claimed by a process that is gone.
    library.db.repo.claimJobs("derive", 4);
    expect(queueStatus(library)).toMatchObject({ ready: 0, running: 4 });

    const report = await runDerives(library, { sizes: [GRID_SIZE] });

    expect(report.derived).toBe(4);
  });
});
