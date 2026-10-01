import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDirectoryInside, makeDirectoryInsideSync } from "./inside.js";

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "roost-inside-"));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (found) => found.isDirectory(),
    () => false,
  );
}

describe("makeDirectoryInside", () => {
  it("makes every level below the root, and is idempotent", async () => {
    const root = join(work, "traveling.roost");
    await makeDirectoryInside(work, root);
    await makeDirectoryInside(root, join(root, "files", "K7"));
    await makeDirectoryInside(root, join(root, "files", "K7"));
    makeDirectoryInsideSync(root, join(root, "thumbs"));
    expect(await isDirectory(join(root, "files", "K7"))).toBe(true);
    expect(await isDirectory(join(root, "thumbs"))).toBe(true);
  });

  // ADR-0056 §3.4. `mkdir -p` here recreated the old path of a library renamed
  // while it was open, and the next import's file went into it.
  it("never recreates a root that has gone", async () => {
    const root = join(work, "traveling.roost");
    await makeDirectoryInside(work, join(root, "files"));
    await rename(root, join(work, "trip.roost"));

    await expect(makeDirectoryInside(root, join(root, "files", "K7"))).rejects.toMatchObject({
      code: "io",
    });
    expect(() => makeDirectoryInsideSync(root, join(root, "staging"))).toThrow();
    expect(await isDirectory(root)).toBe(false);
  });

  it("refuses a directory outside the root", async () => {
    const root = join(work, "traveling.roost");
    await expect(makeDirectoryInside(root, join(work, "elsewhere"))).rejects.toThrow(/not inside/);
  });
});
