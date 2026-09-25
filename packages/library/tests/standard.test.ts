import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAssetId } from "@roost/core";
import { gradient } from "@roost/media";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importInto } from "../src/import.js";
import { Library } from "../src/library.js";
import { readManifest, writeManifest } from "../src/manifest.js";

/**
 * The requirements of the library format that this build has to meet on its own,
 * as opposed to the ones the standard's own fixture checks
 * (`format-conformance.test.ts`).
 *
 * A conformance library can only carry cases somebody thought to write down. The
 * four here are about what this implementation *does* — how it validates a
 * manifest, what it writes back into one, what encoding a filename reaches the
 * journal in, and what it does on meeting a library whose cache is not its own.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "roost-standard-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes a `library.json` verbatim, including a broken one. */
async function manifestFile(name: string, body: unknown): Promise<string> {
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "library.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return root;
}

const GOOD = {
  roost_library_version: 2,
  id: "e0ec4720-c791-4a56-84a5-2c7fc11bb00e",
  name: "Fixture",
  created_at: 1789344118,
};

describe("validating library.json (RL-5, RL-5b)", () => {
  it("refuses a manifest missing a required field rather than filling it in", async () => {
    // Through M4 a missing `id` became `""` and a missing `created_at` became
    // `0` — a repair, and one the next write would have made permanent. RL-5b
    // requires the file be reported as *not a library* instead: this is the
    // file that decides whether a directory is a library at all, and a build
    // that guesses at a damaged one can start writing into somebody's
    // photographs.
    for (const field of ["id", "name", "created_at"] as const) {
      const { [field]: _dropped, ...rest } = GOOD;
      const root = await manifestFile(`missing-${field}`, rest);
      await expect(readManifest(root)).rejects.toMatchObject({
        code: "not_a_library",
        detail: { reason: expect.stringContaining(field) },
      });
    }
  });

  it("refuses a required field of the wrong type", async () => {
    const root = await manifestFile("wrong-type", { ...GOOD, created_at: "yesterday" });
    await expect(readManifest(root)).rejects.toMatchObject({ code: "not_a_library" });
  });

  it("refuses a file that is not JSON, and one that is not an object", async () => {
    const broken = join(dir, "not-json");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "library.json"), "{oh dear", "utf8");
    await expect(readManifest(broken)).rejects.toMatchObject({ code: "not_a_library" });

    const list = await manifestFile("an-array", [GOOD]);
    await expect(readManifest(list)).rejects.toMatchObject({ code: "not_a_library" });
  });

  it("refuses a format version from a later build without touching the directory", async () => {
    const root = await manifestFile("from-the-future", { ...GOOD, roost_library_version: 3 });
    await expect(readManifest(root)).rejects.toMatchObject({ code: "library_too_new" });

    // RL-6's second half: nothing is created, and no cache is rebuilt. A higher
    // version means the meaning of the bytes has changed, so every guess an
    // older build could make is a wrong one.
    await expect(readFile(join(root, "index.db"))).rejects.toThrow();
  });

  it("refuses a Format 1 library by name, and before anything else (RL-6a)", async () => {
    // **Before the other three fields**, deliberately, and that is why a
    // version 1 manifest missing an `id` reports the format rather than the
    // missing field: a different format version may spell those fields
    // differently, so reading them first would be answering a question about a
    // document this build cannot read.
    const root = await manifestFile("version-one", { ...GOOD, roost_library_version: 1 });
    await expect(readManifest(root)).rejects.toMatchObject({ code: "library_format_1" });

    const bare = await manifestFile("version-one-bare", { roost_library_version: 1 });
    await expect(readManifest(bare)).rejects.toMatchObject({ code: "library_format_1" });

    // Nothing is read, repaired or converted: converting is a separate tool's
    // job, run deliberately, writing a new library beside the old one.
    expect((await readdir(root)).sort()).toEqual(["library.json"]);
  });
});

describe("rewriting library.json (RL-5a)", () => {
  it("keeps fields it does not recognise", async () => {
    // Reading leniently and writing destructively would mean that opening a
    // library here silently deletes whatever another implementation put in its
    // manifest — and nothing would say so until that build looked for it.
    const root = await manifestFile("with-extras", {
      ...GOOD,
      win_last_opened: 1789344200,
      colour: { accent: "#ff8800" },
    });

    const manifest = await readManifest(root);
    expect(manifest.unrecognised).toEqual({
      win_last_opened: 1789344200,
      colour: { accent: "#ff8800" },
    });

    await writeManifest(root, { ...manifest, name: "Renamed" });
    const written: unknown = JSON.parse(await readFile(join(root, "library.json"), "utf8"));
    expect(written).toEqual({
      ...GOOD,
      name: "Renamed",
      win_last_opened: 1789344200,
      colour: { accent: "#ff8800" },
    });

    // The four required fields first, in the order the standard publishes them.
    expect(Object.keys(written as object).slice(0, 4)).toEqual([
      "roost_library_version",
      "id",
      "name",
      "created_at",
    ]);
  });
});

describe("filenames in the journal (RL-49)", () => {
  it("records a decomposed filename composed", async () => {
    const library = await Library.create(join(dir, "nfc.roost"), "NFC");
    try {
      const source = join(dir, "pictures");
      await mkdir(source, { recursive: true });

      // `cafe` + U+0301, which is what a filesystem that stores decomposed
      // names hands out. The two spellings look identical and compare unequal,
      // so the journal — the durable copy, the one another implementation reads
      // — has to hold exactly one of them.
      const decomposed = "cafe\u0301 mo\u0308bel.png";
      await writeFile(join(source, decomposed), await gradient(40, 24, 7, "png"));

      await importInto(library, [source], { take: "copy" });

      const [hash] = library.db.repo.allIds();
      expect(hash).toBeDefined();
      // The name carries no extension (RL-33), so what is normalised is the
      // name a person reads.
      expect(library.db.repo.assetDetail(parseAssetId(hash as string))?.name).toBe(
        "caf\u00e9 m\u00f6bel",
      );

      const month = (await library.journal.months())[0];
      const line = await readFile(library.journal.pathFor(month as string), "utf8");
      expect(line).toContain("caf\u00e9 m\u00f6bel");
      expect(line).not.toContain("cafe\u0301 mo\u0308bel");
    } finally {
      await library.close();
    }
  });
});

describe("meeting a library whose cache is not ours (RL-2, RL-11)", () => {
  it("folds the journal on open when the index is missing", async () => {
    // The format puts the index outside itself, so a library written by another
    // implementation arrives with no cache of ours. Through M4 the window drew
    // the empty one and said nothing.
    const root = join(dir, "shared.roost");
    const first = await Library.create(root, "Shared");
    const source = join(dir, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "one.png"), await gradient(32, 32, 3, "png"));
    await importInto(first, [source], { take: "copy" });
    expect(first.stats().assets).toBe(1);
    await first.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(join(root, `index.db${suffix}`), { force: true });
    }

    const journal = join(root, "journal");
    let total = 0;
    for (const month of await readdir(journal)) total += (await stat(join(journal, month))).size;

    // A fold is seconds at a hundred thousand assets, and the window has
    // nothing else to show for them (`UI_SPEC.md` §8).
    const progress: { done: number; total: number }[] = [];
    const second = await Library.open(root, { onFold: (step) => progress.push(step) });
    try {
      expect(second.stats().assets).toBe(1);
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.every((step) => step.total === total && step.done <= step.total)).toBe(true);
      expect(progress.at(-1)).toEqual({ done: total, total });
    } finally {
      await second.close();
    }
  });

  it("folds again when the journal has grown behind our back", async () => {
    const root = join(dir, "appended.roost");
    const first = await Library.create(root, "Appended");
    const source = join(dir, "more");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "two.png"), await gradient(32, 32, 4, "png"));
    await importInto(first, [source], { take: "copy" });
    const [hash] = first.db.repo.allIds();
    await first.close();

    // Another implementation, appending an operation of its own while this one
    // was closed. Written by hand for the same reason the standard's fixture is:
    // this build cannot produce the case it has to survive.
    const month = "2026-03";
    await writeFile(
      join(root, "journal", `${month}.jsonl`),
      `{"ts":1772000000,"op":"rate","asset":"${hash}","rating":5}\n` +
        `{"ts":1772000001,"op":"win.shell_pin","asset":"${hash}"}\n`,
      "utf8",
    );

    const second = await Library.open(root);
    try {
      expect(second.db.repo.assetDetail(parseAssetId(hash as string))?.rating).toBe(5);

      // RL-40: the person is told, and told whose it is. Held in the index so
      // that the *next* open can say it too, without replaying to find out.
      expect(second.notice.skipped).toEqual([
        { op: "win.shell_pin", count: 1, platform: "win", platformLabel: "Roost for Windows" },
      ]);
    } finally {
      await second.close();
    }

    const third = await Library.open(root);
    try {
      expect(third.notice.skipped).toHaveLength(1);
    } finally {
      await third.close();
    }
  });

  it("keeps what a derive found when it folds over rows that already exist", async () => {
    // The fold an open performs writes over rows rather than emptying the index
    // first, which is what keeps the library's thumbnails. It must therefore
    // not undo anything a derive backend learned *after* import. `width` and
    // `height` are the only columns with two sources — a header probe at import,
    // and a proper read afterwards — and before this was measured on 2026-09-15
    // the fold blanked them, silently squaring off in the grid every asset whose
    // dimensions had come from the second.
    //
    // Nothing brings them back on its own, which is what makes it worth a test:
    // `enqueueMissing` looks for assets with no *thumbnail*, and this one keeps
    // its thumbnail throughout.
    const root = join(dir, "derived.roost");
    const source = join(dir, "opaque");
    await mkdir(source, { recursive: true });
    // Bytes the importer's header probe learns nothing from — the position a
    // video is in when only the derive backend can read its dimensions.
    await writeFile(join(source, "clip.bin"), Buffer.alloc(2048, 7));

    const first = await Library.create(root, "Derived");
    await importInto(first, [source], { take: "copy" });
    const [raw] = first.db.repo.allIds();
    const hash = parseAssetId(raw as string);
    expect(first.db.repo.assetDetail(hash)?.width).toBeNull();

    first.db.repo.putDerived(hash, { width: 1920, height: 1080, durationMs: 42_000 }, 1);
    first.db.repo.putThumbnail(hash, 256, 256, 144, Buffer.from([1, 2, 3]));
    // A library from before the mark existed, which is every library there is.
    first.db.repo.setMeta("journal.folded", "");
    await first.close();

    const second = await Library.open(root);
    try {
      expect(second.db.repo.assetDetail(hash)).toMatchObject({
        width: 1920,
        height: 1080,
        durationMs: 42_000,
      });
      expect(second.db.repo.stats().thumbnails).toBe(1);
    } finally {
      await second.close();
    }
  });

  it("does not fold a library it has just been writing to", async () => {
    // The mark is what stops every open of a large library from replaying its
    // whole journal to discover that nothing has changed.
    const root = join(dir, "quiet.roost");
    const first = await Library.create(root, "Quiet");
    const source = join(dir, "quiet-source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "three.png"), await gradient(32, 32, 5, "png"));
    await importInto(first, [source], { take: "copy" });
    const month = (await first.journal.months())[0] as string;
    const fileSize = (await stat(first.journal.pathFor(month))).size;
    await first.close();

    let folded = false;
    const second = await Library.open(root, {
      onFold: () => {
        folded = true;
      },
    });
    try {
      // The mark the import left behind still describes the journal on disk, so
      // the open had nothing to do — and nothing to report doing.
      expect(folded).toBe(false);
      expect(second.db.repo.meta("journal.folded")).toBe(JSON.stringify({ [month]: fileSize }));
      expect(second.notice.skipped).toEqual([]);
      expect(second.stats().assets).toBe(1);
    } finally {
      await second.close();
    }
  });
});
