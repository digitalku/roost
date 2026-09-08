import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, readSettings, SETTINGS_FILE, writeSettings } from "./settings.js";

/**
 * ADR-0019 states three rules about this file and they are the whole of what is
 * under test: a read tolerates absence and damage, a write tolerates failure,
 * and unknown keys survive being written over.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "roost-settings-"));
});

afterEach(async () => {
  await chmod(dir, 0o700).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

const write = (text: string): Promise<void> => writeFile(join(dir, SETTINGS_FILE), text, "utf8");
const read = (): Promise<string> => readFile(join(dir, SETTINGS_FILE), "utf8");

describe("reading settings", () => {
  it("is the defaults where there is no file", async () => {
    // The ordinary case, not an exception: a library that has never had a
    // preference changed has no file, and never gets one until it does.
    expect(await readSettings(dir)).toEqual(DEFAULT_SETTINGS);
  });

  it("shows subfolder contents off, which is what a folder means by default", async () => {
    // The user's choice on 2026-09-08 (ADR-0036): a folder shows its own
    // contents, as a file manager's does.
    expect(DEFAULT_SETTINGS.showSubfolderContents).toBe(false);
  });

  it("takes what the file says", async () => {
    await write('{ "showSubfolderContents": true }');
    expect(await readSettings(dir)).toEqual({ showSubfolderContents: true });
  });

  it("falls back per key rather than discarding the file", async () => {
    // A key with the wrong type is one bad setting, not a bad library.
    await write('{ "showSubfolderContents": "yes" }');
    expect(await readSettings(dir)).toEqual(DEFAULT_SETTINGS);
  });

  it("opens a library whose settings are unreadable", async () => {
    // A damaged `settings.json` must not be able to keep somebody out of their
    // own library. It is a separate file from `library.json` for exactly this.
    for (const damaged of ["{ not json", "[]", "null", "12", ""]) {
      await write(damaged);
      expect(await readSettings(dir)).toEqual(DEFAULT_SETTINGS);
    }
  });
});

describe("writing settings", () => {
  it("writes what was asked and reads it back", async () => {
    expect(await writeSettings(dir, { showSubfolderContents: true })).toBe(true);
    expect(await readSettings(dir)).toEqual({ showSubfolderContents: true });
  });

  it("keeps a key this build has never heard of", async () => {
    // The same reason an unknown journal op is skipped rather than dropped: a
    // newer build's settings have to survive being opened by an older one.
    await write('{ "gridZoom": 3, "showSubfolderContents": true }');
    await writeSettings(dir, { showSubfolderContents: false });

    const kept: unknown = JSON.parse(await read());
    expect(kept).toEqual({ gridZoom: 3, showSubfolderContents: false });
  });

  it("says so rather than throwing when it cannot write", async () => {
    // A library on read-only media or a network share that has gone away must
    // not produce an error dialog when somebody changes a checkbox.
    await chmod(dir, 0o500);
    expect(await writeSettings(dir, { showSubfolderContents: true })).toBe(false);
  });
});
