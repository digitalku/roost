import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findMovedLibrary,
  importInto,
  Library,
  renameLibrary,
  renameTarget,
  watchRoot,
} from "@roost/library";
import { gradient } from "@roost/media";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The folder is the library's name (ADR-0056).
 *
 * Real directories throughout: what is under test is what a rename does to a
 * path, an inode and the descriptors held on them, and a stubbed filesystem
 * would only say what the test told it to.
 */

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "roost-rename-"));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function manifestOf(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, "library.json"), "utf8")) as Record<string, unknown>;
}

describe("a library's name", () => {
  it("is its folder's, whatever library.json says", async () => {
    const library = await Library.create(join(work, "traveling.roost"), "Something else");
    try {
      expect(library.name).toBe("traveling");
      expect(library.manifest.name).toBe("Something else");
    } finally {
      await library.close();
    }
  });

  it("is the whole folder name where there is no suffix", async () => {
    const root = join(work, "Photos");
    await (await Library.create(root, "Photos")).close();
    const library = await Library.open(root);
    try {
      expect(library.name).toBe("Photos");
    } finally {
      await library.close();
    }
  });
});

describe("renameLibrary", () => {
  it("renames the folder, then records the name in library.json", async () => {
    const root = join(work, "traveling.roost");
    await (await Library.create(root, "traveling")).close();
    // RL-5a: a field this build does not know survives the rewrite.
    await writeFile(
      join(root, "library.json"),
      JSON.stringify({ ...(await manifestOf(root)), "win.colour": "teal" }),
    );

    const moved = await renameLibrary(root, "trip");

    expect(moved).toBe(join(work, "trip.roost"));
    expect(await exists(root)).toBe(false);
    const manifest = await manifestOf(moved);
    expect(manifest["name"]).toBe("trip");
    expect(manifest["win.colour"]).toBe("teal");

    const library = await Library.open(moved);
    try {
      expect(library.name).toBe("trip");
    } finally {
      await library.close();
    }
  });

  it("adds the suffix to a library that had none (RL-7)", async () => {
    const root = join(work, "Photos");
    await (await Library.create(root, "Photos")).close();
    expect(await renameLibrary(root, "Holiday")).toBe(join(work, "Holiday.roost"));
  });

  it("touches nothing when the name is the one it has", async () => {
    const root = join(work, "traveling.roost");
    await (await Library.create(root, "an older name")).close();
    expect(await renameTarget(root, "traveling")).toBeUndefined();
    expect(await renameLibrary(root, "  traveling ")).toBe(root);
    // A stale `name` is not repaired by a rename that did not happen (RL-7b).
    expect((await manifestOf(root))["name"]).toBe("an older name");
  });

  it("refuses a name a neighbour already has, even an empty directory", async () => {
    const root = join(work, "traveling.roost");
    await (await Library.create(root, "traveling")).close();
    // On Linux a rename onto an empty directory replaces it without a word.
    await mkdir(join(work, "trip.roost"));

    await expect(renameLibrary(root, "trip")).rejects.toMatchObject({
      code: "library_name_taken",
    });
    expect(await exists(join(root, "library.json"))).toBe(true);
  });

  it("refuses a name the filesystem would read as a path (ADR-0014)", async () => {
    const root = join(work, "traveling.roost");
    await (await Library.create(root, "traveling")).close();
    await expect(renameLibrary(root, "../elsewhere")).rejects.toMatchObject({
      code: "invalid_library_name",
    });
    await expect(renameLibrary(root, ".hidden")).rejects.toMatchObject({
      code: "invalid_library_name",
    });
  });
});

describe("renamed while it is open", () => {
  // ADR-0056 §2, the regression. `mkdir -p` recreated the old path, so the
  // import's file went into a new `traveling.roost/files/<shard>/` while its
  // journal line went to `trip.roost`, and the asset was missing on the next
  // open, beside a folder that was not a library.
  it("never recreates the old folder, and loses nothing", async () => {
    const root = join(work, "traveling.roost");
    const source = join(work, "incoming");
    await mkdir(source);
    await writeFile(join(source, "photo.png"), await gradient(40, 30, 1, "png"));

    const library = await Library.create(root, "traveling");
    const renamed = join(work, "trip.roost");
    await rename(root, renamed);
    const report = await importInto(library, [source]);
    await library.close();

    expect(report.imported).toBe(0);
    expect(report.failed).toHaveLength(1);
    expect(await exists(root)).toBe(false);

    const reopened = await Library.open(renamed);
    try {
      expect(reopened.db.repo.allIds()).toEqual([]);
    } finally {
      await reopened.close();
    }
  });

  it("is noticed, with the new folder found beside the old one", async () => {
    const root = join(work, "traveling.roost");
    const library = await Library.create(root, "traveling");
    const lost = new Promise<string | undefined>((settle) => {
      void watchRoot(root, { id: library.manifest.id, intervalMs: 20, onLost: settle });
    });

    await rename(root, join(work, "trip.roost"));

    expect(await lost).toBe(join(work, "trip.roost"));
    await library.close();
  });

  it("is noticed when it went somewhere else, with nowhere to offer", async () => {
    const root = join(work, "traveling.roost");
    const library = await Library.create(root, "traveling");
    await mkdir(join(work, "elsewhere"));
    const lost = new Promise<string | undefined>((settle) => {
      void watchRoot(root, { id: library.manifest.id, intervalMs: 20, onLost: settle });
    });

    await rename(root, join(work, "elsewhere", "traveling.roost"));

    expect(await lost).toBeUndefined();
    await library.close();
  });

  it("counts a new directory at the old path as the library gone", async () => {
    const root = join(work, "traveling.roost");
    const library = await Library.create(root, "traveling");
    const identity = await stat(root);
    const lost = new Promise<string | undefined>((settle) => {
      void watchRoot(root, { id: library.manifest.id, intervalMs: 20, onLost: settle });
    });

    // What an unplugged drive leaves behind: an empty mount point.
    await rename(root, join(work, "trip.roost"));
    await mkdir(root);

    expect(await lost).toBe(join(work, "trip.roost"));
    expect(await findMovedLibrary(root, identity, "not its id")).toBeUndefined();
    await library.close();
  });

  it("says nothing once closed", async () => {
    const root = join(work, "traveling.roost");
    const library = await Library.create(root, "traveling");
    let told = false;
    const watcher = await watchRoot(root, {
      id: library.manifest.id,
      intervalMs: 10,
      onLost: () => {
        told = true;
      },
    });
    watcher.close();
    await rename(root, join(work, "trip.roost"));
    await new Promise((settle) => setTimeout(settle, 60));
    expect(told).toBe(false);
    await library.close();
  });
});
