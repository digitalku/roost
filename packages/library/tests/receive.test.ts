import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGING_DIR } from "@roost/core";
import {
  count,
  createFolder,
  Library,
  ReceiveFailedError,
  receiveFile,
  UnknownFolderError,
} from "@roost/library";
import { gradient } from "@roost/media";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("receiving a file from a phone", () => {
  let dir: string;
  let library: Library;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-receive-"));
    library = await Library.create(join(dir, "library"), "test");
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Where the server stages a body (ADR-0073 §3.3). */
  const staged = async (name: string, seed: number): Promise<string> => {
    const directory = join(library.root, STAGING_DIR, `upload-${seed}`);
    await mkdir(directory, { recursive: true });
    const path = join(directory, name);
    await writeFile(path, await gradient(64, 48, seed, "png"));
    return path;
  };

  it("adds the file under its own name and moves it out of staging", async () => {
    const path = await staged("pantai.png", 1);
    const received = await receiveFile(library, path, null);

    expect(received.id).not.toBeNull();
    expect(received.duplicateOf).toBeNull();
    expect(count(library, "pantai")).toBe(1);
    // A move, not a copy: the bytes were written once.
    await expect(access(path)).rejects.toThrow();
  });

  it("files it in the folder it was sent to", async () => {
    const folder = await createFolder(library, "Liburan", null);
    await receiveFile(library, await staged("bali.png", 2), folder);
    expect(count(library, "folder:Liburan")).toBe(1);
  });

  it("answers a duplicate with the asset that already holds the bytes", async () => {
    const first = await receiveFile(library, await staged("one.png", 3), null);
    const again = await receiveFile(library, await staged("again.png", 3), null);

    expect(again).toEqual({ id: null, duplicateOf: first.id });
    expect(library.db.repo.allIds()).toHaveLength(1);
  });

  it("takes a hidden name, because somebody chose that file", async () => {
    const received = await receiveFile(library, await staged(".hidden.png", 4), null);
    expect(received.id).not.toBeNull();
  });

  it("refuses a folder that has gone, and a file that is not there", async () => {
    await expect(receiveFile(library, await staged("x.png", 5), 999)).rejects.toThrow(
      UnknownFolderError,
    );
    await expect(
      receiveFile(library, join(library.root, STAGING_DIR, "missing.png"), null),
    ).rejects.toThrow(ReceiveFailedError);
  });
});
