import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssetId, JOB_PRIORITY } from "@roost/core";
import {
  deriveFailures,
  importInto,
  Library,
  queueStatus,
  releaseNowSupported,
  retryBlocked,
  runDerives,
  Wanted,
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

  it("starts nothing once it is told to stop", async () => {
    await importInto(library, [source]);
    const controller = new AbortController();
    controller.abort();

    const report = await runDerives(library, { sizes: [GRID_SIZE], signal: controller.signal });

    expect(report.derived).toBe(0);
    expect(queueStatus(library).ready).toBe(4);
  });

  it("parks an asset whose file has gone, and picks it up when it returns", async () => {
    await importInto(library, [source]);
    // RL-25: the row carries everything the person wrote about it, and a
    // missing file is a fact about today rather than a reason to drop it.
    const id = library.db.repo.allIds()[0] as never;
    const ext = library.db.repo.assetDetail(id)?.ext ?? "";
    await rename(library.storage.locate(id, ext), join(dir, "moved.png"));

    const report = await runDerives(library, { sizes: [GRID_SIZE] });

    expect(report.derived).toBe(3);
    expect(report.missing).toBe(1);
    expect(queueStatus(library).reasons).toEqual([{ reason: "missing:file", count: 1 }]);

    // Parked rather than failed, because the fix is the file coming back — to
    // the place the id names, which is the only place it can be (RL-19).
    await rename(join(dir, "moved.png"), library.storage.locate(id, ext));
    expect(retryBlocked(library, "missing:file")).toBe(1);

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
    await importInto(library, [source]);

    const report = await runDerives(library, { sizes: [GRID_SIZE] });
    expect(report.failed).toBe(2);

    const failures = deriveFailures(library);
    expect(failures.total).toBe(2);
    // The blocked half is read the same way and is empty here, which is the
    // check that `total` follows the state it was asked for rather than always
    // counting failures.
    expect(deriveFailures(library, { state: "blocked" })).toMatchObject({
      total: 0,
      groups: [],
    });
    expect(failures.hidden).toBe(0);
    // One row, not two: both files broke the same way, and a list that
    // repeated the message per file would be the count again in longer form.
    expect(failures.groups).toHaveLength(1);
    expect(failures.groups[0]?.count).toBe(2);
    expect(failures.groups[0]?.attempts).toBe(1);
    // The names a person reads, extension excluded (RL-33): a dialog joins
    // them back to the extension it is shown beside.
    expect(failures.groups[0]?.samples.map((sample) => sample.name).sort()).toEqual([
      "image-1",
      "image-2",
    ]);
    // The message is the backend's own, with nothing from this test in it: no
    // temporary directory, which is what would otherwise split the group.
    expect(failures.groups[0]?.reason).not.toContain(dir);
  });

  it("releases work parked on a format this build has since learned to draw", async () => {
    // The state every library with an iPhone photograph in it was in the day
    // HEIC gained a backend (ADR-0040 §6): parked behind a reason that had
    // stopped being true, with nothing in the window able to release it.
    await importInto(library, [source]);
    await runDerives(library, { sizes: [GRID_SIZE] });
    const hash = library.db.repo.allIds()[0];
    if (hash === undefined) throw new Error("nothing was imported");
    library.db.repo.enqueueJob("derive", hash, 10, 1_700_000_000);
    const [claim] = library.db.repo.claimJobs("derive", 1);
    if (claim === undefined) throw new Error("nothing was claimed");
    library.db.repo.blockJob(claim.id, "unsupported:heic");

    // `heic` is drawn by this build, so it goes back in the queue…
    expect(releaseNowSupported(library)).toBe(1);
    expect(queueStatus(library)).toMatchObject({ ready: 1, blocked: 0 });

    // …while a format nothing here draws stays parked, which is what keeps the
    // sweep convergent rather than retrying a zip on every open.
    const [again] = library.db.repo.claimJobs("derive", 1);
    library.db.repo.blockJob(again?.id ?? 0, "unsupported:zip");
    expect(releaseNowSupported(library)).toBe(0);
    expect(queueStatus(library).blocked).toBe(1);
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

  it("commits every job when workers finish across a commit", async () => {
    // Regression: `finished.push(await deriveOne(...))` read the array before
    // the await, so a worker whose derive was in flight while another worker
    // committed pushed into the batch that had just been written — and its job
    // stayed `running`, derived and forgotten. Two workers and twenty files
    // make a commit land between one worker's claim and its result.
    for (let n = 5; n <= 20; n += 1) {
      await writeFile(join(source, `image-${n}.png`), await gradient(120, 90, n, "png"));
    }
    await importInto(library, [source]);

    const report = await runDerives(library, { sizes: [GRID_SIZE], concurrency: 2 });

    expect(report.derived).toBe(20);
    expect(queueStatus(library)).toMatchObject({ ready: 0, running: 0 });
  });

  it("works what is on screen first, the latest asked for first", async () => {
    await importInto(library, [source]);
    const [a, b, c, d] = library.db.repo.allIds() as AssetId[];
    const wanted = new Wanted();
    wanted.add([c as AssetId, a as AssetId]);
    const order: string[] = [];

    await runDerives(library, {
      sizes: [GRID_SIZE],
      concurrency: 1,
      wanted,
      onDerived: (assets) => order.push(...assets.map((asset) => asset.id)),
    });

    // `a` was asked for last, so it is what the window is showing now; the
    // rest follow in the queue's own order once nothing is waiting on screen.
    expect(order.slice(0, 2)).toEqual([a, c]);
    expect(new Set(order.slice(2))).toEqual(new Set([b, d]));
    expect(wanted.size).toBe(0);
  });

  it("still puts a picture somebody changed ahead of one nobody has seen", async () => {
    await importInto(library, [source]);
    const [a, b] = library.db.repo.allIds() as AssetId[];
    library.db.repo.enqueueJob("derive", b as AssetId, JOB_PRIORITY.interactive, 1);
    const wanted = new Wanted();
    wanted.add([a as AssetId]);
    const order: string[] = [];

    await runDerives(library, {
      sizes: [GRID_SIZE],
      concurrency: 1,
      wanted,
      onDerived: (assets) => order.push(...assets.map((asset) => asset.id)),
    });

    expect(order.slice(0, 2)).toEqual([b, a]);
  });

  it("drops an asked-for id with nothing waiting, rather than deriving it again", async () => {
    await importInto(library, [source]);
    await runDerives(library, { sizes: [GRID_SIZE] });
    const [a] = library.db.repo.allIds() as AssetId[];
    const wanted = new Wanted();
    wanted.add([a as AssetId]);

    const report = await runDerives(library, { sizes: [GRID_SIZE], wanted });

    // A cell with no picture asks for one whatever the reason — parked, broken,
    // or drawn a moment ago — and asking is not a reason to do the work twice.
    expect(report.derived).toBe(0);
    expect(wanted.size).toBe(0);
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
