import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssetId, JOB_PRIORITY } from "@roost/core";
import {
  deriveFailures,
  enqueueMissing,
  importInto,
  Library,
  measureUnread,
  queueStatus,
  type Redrawn,
  Requested,
  releaseNowSupported,
  retryBlocked,
  runDerives,
} from "@roost/library";
import { EAGER_SIZES, GRID_SIZE, gradient } from "@roost/media";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("tells the window why a picture is missing, as it decides", async () => {
    // A cell parked on a missing decoder said nothing until the grid
    // re-paged: `onDerived` carried only the assets that were drawn
    // (`UI_SPEC.md` §6.1).
    await writeFile(
      join(source, "image-1.png"),
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(64),
      ]),
    );
    await importInto(library, [source]);
    const ids = library.db.repo.allIds();
    // Chosen by name: ids are random (RL-15), and a pick by position was the
    // damaged PNG one run in four, which left nothing to fail.
    const gone = ids.find((id) => library.db.repo.assetDetail(id)?.name === "image-2") as AssetId;
    const ext = library.db.repo.assetDetail(gone)?.ext ?? "";
    await rename(library.storage.locate(gone, ext), join(dir, "moved.png"));

    const told: Redrawn[] = [];
    await runDerives(library, { sizes: [GRID_SIZE], onDerived: (assets) => told.push(...assets) });

    const byId = new Map(told.map((one) => [one.id, one]));
    expect(told).toHaveLength(4);
    // Parked, with nothing measured: a reason and no new cache key.
    expect(byId.get(gone)).toEqual({
      id: gone,
      derivedAt: null,
      undrawn: "missing:file",
      chosen: false,
    });
    const failed = told.filter((one) => one.undrawn !== null && one.id !== gone);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.derivedAt).toBeNull();
    // Drawn: a new key, and no reason — which is what clears a badge a retry
    // has just made obsolete.
    const drawn = told.filter((one) => one.undrawn === null);
    expect(drawn).toHaveLength(2);
    expect(drawn.every((one) => typeof one.derivedAt === "number")).toBe(true);

    // And the same answer is there to be read by a page that arrives later.
    const stalled = library.db.repo.stalledReasons("derive", ids);
    expect(stalled.get(gone)).toBe("missing:file");
    expect(stalled.size).toBe(2);
  });

  it("gives a picture drawn in the second it was imported an address of its own", async () => {
    // The import writes a derive time before anything is drawn, and the window
    // asks for the picture under it and is refused. A PNG drawn within the same
    // second came back under that address, and no `<img>` asked for it again:
    // the cell kept its placeholder with nothing left in the queue.
    const second = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(second);
    try {
      await importInto(library, [source]);
      const before = new Map(
        library.db.repo.allIds().map((id) => [id, library.db.repo.assetDetail(id)?.derivedAt]),
      );
      const told: Redrawn[] = [];
      await runDerives(library, {
        sizes: [GRID_SIZE],
        onDerived: (assets) => told.push(...assets),
      });

      expect(told).toHaveLength(4);
      for (const one of told) {
        const imported = before.get(one.id);
        expect(typeof imported).toBe("number");
        expect(one.derivedAt).toBeGreaterThan(imported as number);
        // What the window is told is what a page read later says.
        expect(library.db.repo.assetDetail(one.id)?.derivedAt).toBe(one.derivedAt);
      }
    } finally {
      clock.mockRestore();
    }
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
    expect(library.db.repo.jobReasons("blocked")).toEqual([
      { reason: "unsupported:zip", count: 1 },
    ]);
  });

  it("gives a GIMP file its name back, once, and leaves a damaged JPEG alone", async () => {
    // Reported 2026-09-24: an `.xcf` parked as "a kind of file Roost does not
    // recognise" by a build that had no `xcf` in its table.
    await rm(source, { recursive: true });
    await mkdir(source);
    await writeFile(
      join(source, "edit.xcf"),
      Buffer.concat([Buffer.from("gimp xcf v019\0"), Buffer.alloc(96, 1)]),
    );
    // Sniffs as unknown under any build: not something a table can fix.
    await writeFile(join(source, "broken.jpg"), Buffer.alloc(128, 7));
    await importInto(library, [source]);
    await runDerives(library, { sizes: [GRID_SIZE] });
    expect(library.db.repo.jobReasons("blocked")).toEqual(
      expect.arrayContaining([
        { reason: "unsupported:xcf", count: 1 },
        { reason: "unsupported:unknown", count: 1 },
      ]),
    );

    // What the older build left behind: the GIMP file parked as unknown too.
    expect(library.db.repo.requeueBlocked("derive", "unsupported:xcf")).toBe(1);
    const [claim] = library.db.repo.claimJobs("derive", 1);
    library.db.repo.blockJob(claim?.id ?? 0, "unsupported:unknown");

    // Released by extension, and only the one whose format now has a name.
    expect(releaseNowSupported(library)).toBe(1);
    await runDerives(library, { sizes: [GRID_SIZE] });
    expect(library.db.repo.jobReasons("blocked")).toEqual(
      expect.arrayContaining([
        { reason: "unsupported:xcf", count: 1 },
        { reason: "unsupported:unknown", count: 1 },
      ]),
    );

    // And convergent: the next open finds nothing to release.
    expect(releaseNowSupported(library)).toBe(0);
  });

  it("tells nobody about a file of kind other having no picture", async () => {
    // Asked for on 2026-09-24: an `.xcf`, made `other`, was still in the list
    // behind the status bar. An archive, a GIMP file and a file nothing
    // recognises have no picture by nature; a BMP nothing here draws still
    // counts, because it is a picture that cannot be shown.
    await rm(source, { recursive: true });
    await mkdir(source);
    await writeFile(join(source, "edit.xcf"), Buffer.from("gimp xcf v019\0padding"));
    await writeFile(join(source, "notes.bin"), Buffer.alloc(80, 3));
    await writeFile(join(source, "old.bmp"), Buffer.concat([Buffer.from("BM"), Buffer.alloc(80)]));
    await importInto(library, [source]);
    await runDerives(library, { sizes: [GRID_SIZE] });

    // Parked, all three, so the sweep does not offer them again…
    expect(library.db.repo.jobCounts()).toContainEqual({
      kind: "derive",
      state: "blocked",
      count: 3,
    });
    // …and only the picture is reported.
    expect(queueStatus(library)).toMatchObject({
      blocked: 1,
      reasons: [{ reason: "unsupported:bmp", count: 1 }],
    });
    const listed = deriveFailures(library, { state: "blocked" });
    expect(listed.total).toBe(1);
    expect(listed.groups.map((group) => group.reason)).toEqual(["unsupported:bmp"]);
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

  it("works only what was asked for by name, when told to", async () => {
    // ADR-0065: what was asked for is drawn, and nothing else is touched.
    const report = await importInto(library, [source]);
    expect(report.importedIds).toHaveLength(4);
    const [a, b] = report.importedIds as AssetId[];
    const requested = new Requested();
    requested.queue([b as AssetId, a as AssetId, b as AssetId]);
    const order: string[] = [];

    const run = await runDerives(library, {
      sizes: [GRID_SIZE],
      concurrency: 1,
      asked: requested,
      onDerived: (assets) => order.push(...assets.map((asset) => asset.id)),
    });

    // `b` a second time has nothing waiting, and is skipped rather than drawn
    // twice; the other two assets are still queued, untouched.
    expect(order).toEqual([b, a]);
    expect(run.derived).toBe(2);
    expect(queueStatus(library).ready).toBe(2);
  });

  it("draws what somebody changed ahead of what was asked for", async () => {
    await importInto(library, [source]);
    const [a, b] = library.db.repo.allIds() as AssetId[];
    library.db.repo.enqueueJob("derive", b as AssetId, JOB_PRIORITY.interactive, 1);
    const asked = new Requested();
    asked.open(a as AssetId);
    const order: string[] = [];

    await runDerives(library, {
      sizes: [GRID_SIZE],
      concurrency: 1,
      asked,
      onDerived: (assets) => order.push(...assets.map((asset) => asset.id)),
    });

    expect(order).toEqual([b, a]);
  });

  it("skips an asked-for id with nothing waiting, rather than deriving it again", async () => {
    await importInto(library, [source]);
    await runDerives(library, { sizes: [GRID_SIZE] });
    const [a] = library.db.repo.allIds() as AssetId[];
    const asked = new Requested();
    asked.open(a as AssetId);

    const report = await runDerives(library, { sizes: [GRID_SIZE], asked });

    expect(report.derived).toBe(0);
    expect(asked.size).toBe(0);
  });

  it("reads what a rebuild left unread, and draws nothing (ADR-0065)", async () => {
    await importInto(library, [source]);
    const [drawn, undrawn] = library.db.repo.allIds() as AssetId[];
    const asked = new Requested();
    asked.open(drawn as AssetId);
    await runDerives(library, { sizes: EAGER_SIZES, asked });
    const size = library.db.repo.assetDetail(undrawn as AssetId)?.size;
    const waiting = queueStatus(library).ready;

    for (const id of [drawn, undrawn] as AssetId[]) library.db.repo.clearDerived(id);
    enqueueMissing(library);
    const left: number[] = [];
    await measureUnread(library, { onProgress: (n) => left.push(n) });

    expect(left[0]).toBe(2);
    expect(left.at(-1)).toBe(0);
    expect(library.db.repo.underivedCount()).toBe(0);
    expect(library.db.repo.assetDetail(undrawn as AssetId)?.size).toBe(size);
    // Still waiting to be drawn, and the one with a picture still has it.
    expect(library.db.repo.thumbnail(undrawn as AssetId, GRID_SIZE)).toBeUndefined();
    expect(library.db.repo.thumbnail(drawn as AssetId, GRID_SIZE)).toBeDefined();
    expect(queueStatus(library).ready).toBe(waiting);
  });

  it("queues a picture whose file changed while the index was gone (ADR-0065)", async () => {
    await importInto(library, [source]);
    const [a] = library.db.repo.allIds() as AssetId[];
    const asked = new Requested();
    asked.open(a as AssetId);
    await runDerives(library, { sizes: EAGER_SIZES, asked });
    const detail = library.db.repo.assetDetail(a as AssetId);
    await appendFile(library.storage.locate(a as AssetId, detail?.ext ?? ""), "edited");
    library.db.repo.clearDerived(a as AssetId);

    await measureUnread(library);

    const order: string[] = [];
    await runDerives(library, {
      sizes: EAGER_SIZES,
      asked: new Requested(),
      onDerived: (assets) => order.push(...assets.map((asset) => asset.id)),
    });
    expect(order).toEqual([a]);
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
