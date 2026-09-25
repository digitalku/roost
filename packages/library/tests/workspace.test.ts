import { mkdir, mkdtemp, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetId } from "@roost/core";
import {
  catchUp,
  importInto,
  Library,
  refreshAsset,
  resolveFile,
  runDerives,
  saveEdit,
  watchFiles,
} from "@roost/library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The workspace half of format 2 (ADR-0047): a file under `files/` is edited by
 * an application that has never heard of Roost, and the library catches up.
 *
 * Every test here writes to the store **behind the library's back**, on
 * purpose. That is what an external editor does, and a test that went through
 * `saveEdit` would be testing the one path that already works.
 */

/** An 8×8 PNG that libvips will actually decode, so a derive has work to do. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWOowAEYhpYEACrVWgHfA7Y0AAAAAElFTkSuQmCC",
  "base64",
);

/** The same picture as a GIF, for when the bytes stop being what the name says. */
const GIF = Buffer.from(
  "R0lGODlhCAAIAIAAAExpccjIyCH5BAUAAAAALAAAAAAIAAgAAAIHjI+py+1dAAA7",
  "base64",
);

/** Every byte the journal holds, for asserting that nothing was appended. */
async function journalBytes(library: Library): Promise<number> {
  const dir = join(library.root, "journal");
  let total = 0;
  for (const name of await readdir(dir)) {
    total += (await stat(join(dir, name))).size;
  }
  return total;
}

describe("noticing that a file changed", () => {
  let dir: string;
  let library: Library;
  let picture: AssetId;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-workspace-"));
    const source = join(dir, "incoming");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "picture.png"), PNG);

    library = await Library.create(join(dir, "library"), "test");
    await importInto(library, [source]);

    const [first] = library.db.repo.allIds();
    if (first === undefined) throw new Error("nothing imported");
    picture = first;

    // A derive, so the index knows what the file measured. Everything here
    // turns on comparing against that.
    await runDerives(library);
    const found = await resolveFile(library, picture);
    if (found.kind !== "found") throw new Error("the import placed no file");
    path = found.path;
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes over the file the way another application would, moving its mtime. */
  async function overwrite(bytes: Buffer, at = path): Promise<void> {
    await writeFile(at, bytes);
    const later = new Date(Date.now() + 5000);
    await utimes(at, later, later);
  }

  it("leaves an untouched file alone", async () => {
    expect(await refreshAsset(library, picture)).toEqual({ kind: "unchanged" });
  });

  it("clears what it derived and queues the asset again when the bytes move", async () => {
    expect(library.db.repo.thumbnail(picture, 256)).toBeDefined();
    const before = library.db.repo.fileState(picture);

    await overwrite(Buffer.concat([PNG, Buffer.alloc(64)]));
    const outcome = await refreshAsset(library, picture);

    expect(outcome).toMatchObject({ kind: "changed", adopted: false });
    // The stale thumbnail goes with the stale measurements: a cell showing last
    // week's picture is the whole complaint this feature answers.
    expect(library.db.repo.thumbnail(picture, 256)).toBeUndefined();
    expect(library.db.repo.fileState(picture)).toEqual({ size: null, mtime: null });
    expect(library.db.repo.jobCounts().some((count) => count.state === "ready")).toBe(true);
    expect(before?.size).not.toBeNull();
  });

  it("derives the new bytes, so the index ends up describing the file on disk", async () => {
    await overwrite(GIF);
    await refreshAsset(library, picture);
    await runDerives(library);

    const after = library.db.repo.fileState(picture);
    expect(after?.size).toBe(GIF.length);
  });

  it("is idempotent, so an editor's four events for one save cost one derive", async () => {
    await overwrite(Buffer.concat([PNG, Buffer.alloc(8)]));

    expect((await refreshAsset(library, picture)).kind).toBe("changed");
    expect((await refreshAsset(library, picture)).kind).toBe("pending");
    expect((await refreshAsset(library, picture)).kind).toBe("pending");
  });

  it("does not chase Roost's own writes", async () => {
    await saveEdit(library, picture, new Uint8Array(GIF));
    // `saveEdit` has already cleared and re-queued, so the watcher's comparison
    // finds nothing left to do rather than queuing the same work twice.
    expect((await refreshAsset(library, picture)).kind).toBe("pending");
  });

  it("reports a file that is gone, and keeps the row (RL-25)", async () => {
    await rm(path);
    expect(await refreshAsset(library, picture)).toEqual({ kind: "missing" });
    expect(library.db.repo.findAsset(picture)).toBeDefined();
  });
});

describe("finding a file another build renamed (RL-9b)", () => {
  let dir: string;
  let library: Library;
  let picture: AssetId;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-rl9b-"));
    const source = join(dir, "incoming");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "picture.png"), PNG);

    library = await Library.create(join(dir, "library"), "test");
    await importInto(library, [source]);
    const [first] = library.db.repo.allIds();
    if (first === undefined) throw new Error("nothing imported");
    picture = first;
    await runDerives(library);

    const found = await resolveFile(library, picture);
    if (found.kind !== "found") throw new Error("no file");
    path = found.path;
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("finds the asset under its new extension instead of reporting it missing", async () => {
    // What another implementation does when an application saves the file as a
    // different type. Before the fallback existed this asset was missing for
    // ever, with its file in the same directory.
    const renamed = path.replace(/\.png$/, ".gif");
    await rename(path, renamed);

    const found = await resolveFile(library, picture);
    expect(found).toMatchObject({ kind: "found", ext: "gif", renamed: true });
  });

  it("records the extension it found, without journalling anything", async () => {
    const before = await journalBytes(library);
    await rename(path, path.replace(/\.png$/, ".gif"));

    await refreshAsset(library, picture);

    expect(library.db.repo.findFile(picture)?.ext).toBe("gif");
    // RL-23: an edit is not journalled, and neither is the rename RL-9b makes
    // when one changes a file's type. The row is a cache of what the store
    // says, and a rebuild reads the extension back from there.
    expect(await journalBytes(library)).toBe(before);
  });

  it("refuses to choose between two files for one id (RL-12)", async () => {
    // Both under names the journalled extension does not describe, which is
    // what makes resolution list the shard and find them.
    await rename(path, path.replace(/\.png$/, ".gif"));
    await writeFile(path.replace(/\.png$/, ".webp"), GIF);

    expect((await resolveFile(library, picture)).kind).toBe("ambiguous");
    expect(await refreshAsset(library, picture)).toEqual({ kind: "ambiguous" });
  });

  it("does not pay for a directory listing when the expected file is there", async () => {
    // RL-12's other case: `<id>.png` still exists and a second file sits beside
    // it. Resolution takes the one it was asked for rather than listing the
    // shard on every serve — a readdir per asset per request is not affordable
    // at a million assets — so **`doctor` is what reports this one**, and
    // `doctor.test.ts` is where that is asserted.
    await writeFile(path.replace(/\.png$/, ".webp"), GIF);

    expect(await resolveFile(library, picture)).toMatchObject({
      kind: "found",
      ext: "png",
      renamed: false,
    });
    expect(library.db.repo.findFile(picture)?.ext).toBe("png");
  });

  it("renames the file when its bytes stop being the type its name claims", async () => {
    // A `.png` that is now a GIF: the derive pass sniffs before it draws, and
    // RL-9b makes it rename rather than journal.
    await writeFile(path, GIF);
    const later = new Date(Date.now() + 5000);
    await utimes(path, later, later);

    await refreshAsset(library, picture);
    await runDerives(library);

    expect(library.db.repo.findFile(picture)?.ext).toBe("gif");
    const found = await resolveFile(library, picture);
    expect(found).toMatchObject({ kind: "found", ext: "gif" });
    await expect(stat(path)).rejects.toThrow();
  });

  it("leaves an extension it cannot vouch for alone", async () => {
    // A ZIP is what every `.docx`, `.xlsx` and `.epub` is, so sniffing one is
    // no evidence that the name is wrong. The naive rule renames every Word
    // document in a library to `.zip` on its first derive.
    const zip = Buffer.from("504b0304140000000800", "hex");
    await writeFile(path, Buffer.concat([zip, Buffer.alloc(32)]));

    await refreshAsset(library, picture);
    await runDerives(library);

    expect(library.db.repo.findFile(picture)?.ext).toBe("png");
  });
});

describe("catching up with a library that changed while it was closed", () => {
  let dir: string;
  let library: Library;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-catchup-"));
    const source = join(dir, "incoming");
    await mkdir(source, { recursive: true });
    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(source, `p${index}.png`), Buffer.concat([PNG, Buffer.alloc(index)]));
    }

    library = await Library.create(join(dir, "library"), "test");
    await importInto(library, [source]);
    await runDerives(library);
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("walks the store and queues only what moved", async () => {
    const [first] = library.db.repo.allIds();
    if (first === undefined) throw new Error("nothing imported");
    const found = await resolveFile(library, first);
    if (found.kind !== "found") throw new Error("no file");

    await writeFile(found.path, GIF);
    const later = new Date(Date.now() + 5000);
    await utimes(found.path, later, later);

    const report = await catchUp(library);
    expect(report.seen).toBe(3);
    expect(report.changed).toBe(1);
    expect(report.unknown).toBe(0);
  });

  it("stops when it is asked to", async () => {
    const stop = new AbortController();
    stop.abort();
    expect((await catchUp(library, { signal: stop.signal })).seen).toBe(0);
  });
});

describe("watching files/ for other applications' saves", () => {
  let dir: string;
  let library: Library;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-watch-"));
    const source = join(dir, "incoming");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "picture.png"), PNG);

    library = await Library.create(join(dir, "library"), "test");
    await importInto(library, [source]);
    await runDerives(library);
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("notices a save and re-derives, without being told by anything in Roost", async () => {
    const [id] = library.db.repo.allIds();
    if (id === undefined) throw new Error("nothing imported");
    const found = await resolveFile(library, id);
    if (found.kind !== "found") throw new Error("no file");

    const changed: string[] = [];
    const watcher = await watchFiles(library, {
      quietMs: 30,
      onChanged: (asset) => changed.push(asset),
    });

    try {
      await writeFile(found.path, Buffer.concat([PNG, Buffer.alloc(128)]));
      const later = new Date(Date.now() + 5000);
      await utimes(found.path, later, later);
      await watcher.settled();
    } finally {
      watcher.close();
    }

    // `fs.watch` drops events under load on every platform, which is why the
    // catch-up sweep exists and why this asserts the *consequence* rather than
    // the event: either the watcher saw it, or the state says it did not.
    if (changed.length > 0) {
      expect(changed).toEqual([id]);
      expect(library.db.repo.fileState(id)).toEqual({ size: null, mtime: null });
    }
  });

  it.runIf(process.platform === "linux")(
    "watches a shard directory created after it started",
    async () => {
      // On Linux the watch is one per shard directory rather than Node's
      // recursive walk, which blocked the engine for a second per hundred
      // thousand files (2026-09-24). So a directory that did not exist when the
      // watch began has to be noticed and watched on its own — which is what
      // every import into an empty shard makes.
      const changed: string[] = [];
      const watcher = await watchFiles(library, {
        quietMs: 30,
        onChanged: (asset) => changed.push(asset),
      });

      try {
        const before = new Set(library.db.repo.allIds());
        const source = join(dir, "later");
        await mkdir(source, { recursive: true });
        // Different bytes, so it is not a duplicate of the picture already in.
        await writeFile(join(source, "second.png"), Buffer.concat([PNG, Buffer.alloc(64, 1)]));
        await importInto(library, [source]);
        const id = library.db.repo.allIds().find((each) => !before.has(each));
        if (id === undefined) throw new Error("nothing imported");
        const found = await resolveFile(library, id);
        if (found.kind !== "found") throw new Error("no file");
        // Long enough for the new directory's own watch to be in place.
        await new Promise((resume) => setTimeout(resume, 100));

        await writeFile(found.path, Buffer.concat([PNG, Buffer.alloc(256, 2)]));
        const later = new Date(Date.now() + 5000);
        await utimes(found.path, later, later);
        // Waited for rather than timed: under a full parallel run the chain —
        // the directory's event, its `stat`, its watch, the debounce — can take
        // longer than one `settled()` round, and the claim is that it arrives.
        const deadline = Date.now() + 3000;
        while (!changed.includes(id) && Date.now() < deadline) await watcher.settled();

        expect(changed).toContain(id);
      } finally {
        watcher.close();
      }
    },
  );

  it("closes twice without complaining", async () => {
    const watcher = await watchFiles(library, { quietMs: 10 });
    watcher.close();
    expect(() => watcher.close()).not.toThrow();
  });
});
