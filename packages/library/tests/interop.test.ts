import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { generateFixture, generateMissing, importInto, Library } from "@roost/library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);

/**
 * The Rust implementation's binary, if this machine has one.
 *
 * These tests are the other half of the fixtures committed elsewhere in this
 * repository. Those prove this build **reads** what the Rust one wrote; only a
 * live binary can prove the reverse, and the reverse is half the promise in
 * `CONCEPT.md` §7. It cannot be committed, so the tests skip where it is
 * absent — which includes CI. `TODO.md` records that.
 */
const ROOST_OLD = fileURLToPath(
  new URL("../../../../roost-old/target/release/roost", import.meta.url),
);

const available = await access(ROOST_OLD).then(
  () => true,
  () => false,
);

describe.runIf(available)("a library this build wrote, opened by the Rust build", () => {
  let dir: string;
  let root: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-interop-"));
    root = join(dir, "library");

    const corpus = join(dir, "corpus");
    await generateFixture(corpus, {
      count: 40,
      seed: 11,
      duplicateRatio: 0.1,
      realImages: true,
      imageWidth: 160,
      imageHeight: 120,
    });

    const library = await Library.create(root, "Interop");
    try {
      await importInto(library, [corpus], { tags: ["crossing"] });
      await generateMissing(library, [256]);
    } finally {
      await library.close();
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const oldRoost = async (...args: string[]): Promise<string> => {
    const { stdout, stderr } = await run(ROOST_OLD, [...args, "-L", root]);
    return stdout + stderr;
  };

  it("reads the same counts out of it", async () => {
    const ours = await Library.open(root);
    let counts: ReturnType<Library["stats"]>;
    try {
      counts = ours.stats();
    } finally {
      await ours.close();
    }

    const theirs = await oldRoost("stats");
    expect(theirs).toContain(`assets      ${counts.assets}`);
    expect(theirs).toContain(`managed     ${counts.managed}`);
    expect(theirs).toContain(`tags        ${counts.tags}`);
    expect(theirs).toContain(`thumbnails  ${counts.thumbnails}`);
  });

  it("rebuilds its index from the journal and lands in the same place", async () => {
    // The strongest check either direction has: the other implementation
    // replays a journal this one wrote, folds it with its own code, and gets an
    // index that matches row for row.
    const output = await oldRoost("rebuild");
    expect(output).toContain("Index matches what it replaced");
    expect(output).not.toContain("differs");
  });

  it("finds nothing wrong with the object store", async () => {
    // Every object has a row, every row has bytes, and the shard layout is what
    // the other build expects to find.
    const output = await oldRoost("doctor");
    expect(output).toContain("Nothing wrong");
  });
});

describe.runIf(!available)("cross-implementation checks", () => {
  it("are skipped without ../roost-old built", () => {
    // Not a silent pass: this is here so a run that proved nothing says so.
    expect(available).toBe(false);
  });
});
