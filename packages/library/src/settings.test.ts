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

  it("keeps a video at its own pixels until somebody says otherwise", async () => {
    // The user's choice on 2026-09-08 (ADR-0024 §8): a low-resolution video is
    // fitted to the pane but never blown up, and Fit is what changes that.
    expect(DEFAULT_SETTINGS.fitVideoToWindow).toBe(false);
  });

  it("starts in the order the application had before it had a menu", async () => {
    // ADR-0039: `added` descending is what every library shows until somebody
    // asks for something else, and a new library must not open shuffled.
    expect(DEFAULT_SETTINGS.sortKey).toBe("added");
    expect(DEFAULT_SETTINGS.sortDescending).toBe(true);
  });

  it("falls back on a sort key this build has retired", async () => {
    // The one shape ADR-0019's per-key rule has to survive on a vocabulary:
    // a newer build's key read by an older one is not a broken library.
    await write('{ "sortKey": "colour", "sortDescending": false }');
    expect(await readSettings(dir)).toEqual({ ...DEFAULT_SETTINGS, sortDescending: false });
  });

  it("clamps a zoom rather than throwing it away", async () => {
    // The steps are the renderer's, so a number a little outside them is a
    // build that changed its steps — and forgetting the preference over that
    // would be worse than snapping it.
    await write('{ "gridZoom": 100000 }');
    expect((await readSettings(dir)).gridZoom).toBe(1024);
    await write('{ "gridZoom": "big" }');
    expect((await readSettings(dir)).gridZoom).toBe(DEFAULT_SETTINGS.gridZoom);
  });

  it("starts at full volume, which is where a media element starts", async () => {
    // A library nobody has changed the volume in behaves exactly as it did
    // before this setting existed (ADR-0024 §9).
    expect(DEFAULT_SETTINGS.mediaVolume).toBe(100);
    expect(DEFAULT_SETTINGS.mediaMuted).toBe(false);
  });

  it("clamps a hand-edited volume into what the element will accept", async () => {
    // `HTMLMediaElement.volume` throws outside its own 0–1, so a number typed
    // into this file by hand must not survive as far as the assignment.
    await write('{ "mediaVolume": 400 }');
    expect((await readSettings(dir)).mediaVolume).toBe(100);
    await write('{ "mediaVolume": -20 }');
    expect((await readSettings(dir)).mediaVolume).toBe(0);
    await write('{ "mediaVolume": "loud" }');
    expect((await readSettings(dir)).mediaVolume).toBe(DEFAULT_SETTINGS.mediaVolume);
  });

  it("keeps the volume and the silence together", async () => {
    await write('{ "mediaVolume": 30, "mediaMuted": true }');
    expect(await readSettings(dir)).toEqual({
      ...DEFAULT_SETTINGS,
      mediaVolume: 30,
      mediaMuted: true,
    });
  });

  it("takes a view it has never heard of at its word", async () => {
    // The vocabulary is the window's (ADR-0039 §7): this file checks the shape
    // and the renderer decides whether it knows the word.
    await write('{ "gridView": "gallery" }');
    expect((await readSettings(dir)).gridView).toBe("gallery");
  });

  it("takes what the file says", async () => {
    await write('{ "showSubfolderContents": true }');
    expect(await readSettings(dir)).toEqual({ ...DEFAULT_SETTINGS, showSubfolderContents: true });
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
    expect(await readSettings(dir)).toEqual({ ...DEFAULT_SETTINGS, showSubfolderContents: true });
  });

  it("writes one setting without disturbing the other", async () => {
    // A patch, not a document: the preview writes `fitVideoToWindow` and knows
    // nothing about what the filter bar last wrote.
    await writeSettings(dir, { showSubfolderContents: true });
    await writeSettings(dir, { fitVideoToWindow: true });
    expect(await readSettings(dir)).toEqual({
      ...DEFAULT_SETTINGS,
      showSubfolderContents: true,
      fitVideoToWindow: true,
    });
  });

  it("keeps a key this build has never heard of", async () => {
    // The same reason an unknown journal op is skipped rather than dropped: a
    // newer build's settings have to survive being opened by an older one.
    await write('{ "colourLabels": ["red"], "showSubfolderContents": true }');
    await writeSettings(dir, { showSubfolderContents: false });

    const kept: unknown = JSON.parse(await read());
    expect(kept).toEqual({ colourLabels: ["red"], showSubfolderContents: false });
  });

  it("says so rather than throwing when it cannot write", async () => {
    // A library on read-only media or a network share that has gone away must
    // not produce an error dialog when somebody changes a checkbox.
    await chmod(dir, 0o500);
    expect(await writeSettings(dir, { showSubfolderContents: true })).toBe(false);
  });
});
