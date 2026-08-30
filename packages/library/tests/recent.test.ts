import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  forgetLibrary,
  listRecent,
  pinLibrary,
  RECENT_LIMIT,
  recentPath,
  rememberLibrary,
} from "@roost/library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The recent-libraries list.
 *
 * Driven against a real `$XDG_STATE_HOME` rather than a stubbed filesystem: the
 * whole point of this module is what it does when the file is missing,
 * truncated, or written by something else, and a mock would only ever return
 * what the test decided it would.
 *
 * The libraries here are directories holding a `library.json` and nothing else.
 * That is exactly what availability is checked against, and building fifteen
 * real ones would measure SQLite rather than this.
 */

describe("the recent-libraries list", () => {
  let root: string;
  let state: string;
  let previous: string | undefined;

  /** A directory that looks like a library to the availability check. */
  const makeLibrary = async (name: string): Promise<string> => {
    const path = join(root, `${name}.roost`);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "library.json"), "{}\n", "utf8");
    return path;
  };

  const remember = (path: string, name: string) =>
    rememberLibrary({ root: path, name, id: name.toLowerCase() });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "roost-recent-"));
    state = join(root, "state");
    previous = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = state;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = previous;
    await rm(root, { recursive: true, force: true });
  });

  it("answers with nothing at all before anything has been opened", async () => {
    // A first run must not be an error. The picker draws no heading and offers
    // its two buttons, which is where the application was before this existed.
    expect(await listRecent()).toEqual([]);
  });

  it("remembers a library that was opened, and finds it again", async () => {
    const path = await makeLibrary("Holiday");
    await remember(path, "Holiday");

    const [entry, ...rest] = await listRecent();
    expect(rest).toEqual([]);
    expect(entry?.name).toBe("Holiday");
    expect(entry?.id).toBe("holiday");
    expect(entry?.available).toBe(true);
    expect(entry?.pinned).toBe(false);
  });

  it("moves a library that is opened again to the front, without duplicating it", async () => {
    const first = await makeLibrary("One");
    const second = await makeLibrary("Two");
    await remember(first, "One");
    await remember(second, "Two");
    await remember(first, "One");

    expect((await listRecent()).map((entry) => entry.name)).toEqual(["One", "Two"]);
  });

  it("marks a library whose folder has gone, rather than dropping it", async () => {
    // Dropping it silently reads as the application having forgotten, and
    // leaves somebody wondering whether they imagined the library.
    const path = await makeLibrary("Vanishing");
    await remember(path, "Vanishing");
    await rm(path, { recursive: true, force: true });

    const [entry] = await listRecent();
    expect(entry?.name).toBe("Vanishing");
    expect(entry?.available).toBe(false);
  });

  it("keeps a pin through the limit and through being opened again", async () => {
    const pinned = await makeLibrary("Pinned");
    await remember(pinned, "Pinned");
    await pinLibrary(pinned, true);

    for (let index = 0; index < RECENT_LIMIT + 3; index += 1) {
      await remember(await makeLibrary(`Other${index}`), `Other${index}`);
    }

    const entries = await listRecent();
    // A pinned entry is never evicted, the limit counts only the unpinned ones,
    // and pinned rows sort first.
    expect(entries[0]?.name).toBe("Pinned");
    expect(entries[0]?.pinned).toBe(true);
    expect(entries.filter((entry) => !entry.pinned)).toHaveLength(RECENT_LIMIT);

    // Opening it again does not clear the mark: a pin is the user's, not a
    // property of one visit.
    await remember(pinned, "Pinned");
    expect((await listRecent()).find((entry) => entry.name === "Pinned")?.pinned).toBe(true);
  });

  it("forgets one entry and leaves the rest", async () => {
    const keep = await makeLibrary("Keep");
    const drop = await makeLibrary("Drop");
    await remember(keep, "Keep");
    await remember(drop, "Drop");

    const left = await forgetLibrary(drop);
    expect(left.map((entry) => entry.name)).toEqual(["Keep"]);
  });

  it("starts over on a file that is not valid JSON, rather than refusing", async () => {
    await mkdir(dirname(recentPath()), { recursive: true });
    await writeFile(recentPath(), "{ this is not json", "utf8");
    expect(await listRecent()).toEqual([]);

    // And the next write replaces it, so the damage does not persist.
    await remember(await makeLibrary("After"), "After");
    expect((await listRecent()).map((entry) => entry.name)).toEqual(["After"]);
  });

  it("drops one unusable row without discarding the rest of the file", async () => {
    // A row from a future build, or a corrupted one. Discarding the file would
    // cost the other entries for the sake of the one nobody can read.
    const good = await makeLibrary("Good");
    await mkdir(dirname(recentPath()), { recursive: true });
    await writeFile(
      recentPath(),
      JSON.stringify({
        version: 1,
        libraries: [
          { root: good, name: "Good", id: "g", openedAt: 1_700_000_000, pinned: false },
          { root: 42, name: "Broken" },
        ],
      }),
      "utf8",
    );

    expect((await listRecent()).map((entry) => entry.name)).toEqual(["Good"]);
  });

  it("never lets a failure to record cost the caller anything", async () => {
    // The state directory is a file, so every write under it fails. Recording
    // happens *after* a library is open, and a window that refused to show one
    // because of this would trade the thing for the note about the thing.
    await writeFile(state, "not a directory", "utf8");

    const path = await makeLibrary("Unrecordable");
    await expect(remember(path, "Unrecordable")).resolves.toBeUndefined();
  });

  it("writes through a temporary file, so a crash cannot leave half a list", async () => {
    await remember(await makeLibrary("Atomic"), "Atomic");

    // The rename is what makes it atomic; what is assertable afterwards is that
    // the temporary file did not survive it.
    const written = JSON.parse(await readFile(recentPath(), "utf8")) as { version: number };
    expect(written.version).toBe(1);
    await expect(readFile(`${recentPath()}.tmp`, "utf8")).rejects.toThrow();
  });
});
