import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Db,
  IndexSink,
  ManagedStorage,
  parseContentHash,
  platformName,
  platformOf,
  replay,
} from "@roost/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readManifest } from "../src/manifest.js";
import { LIBRARY_SUFFIX, libraryNameFromPath } from "../src/naming.js";

/**
 * The Roost Library Format's own conformance suite, run against this build.
 *
 * RL-39 requires it and recommends running it in continuous integration. It is
 * **not vendored**: the standard lives in its own repository beside this one,
 * every implementation checks that out and runs it, and a copy would drift the
 * moment somebody fixed one of them. That is the standard's rule, not a
 * preference here — a suite this repository owned would be this repository
 * marking its own homework, which is the thing one format with three
 * implementations exists to prevent.
 *
 * What it checks is what a single implementation cannot check about itself:
 * that a journal nobody here wrote replays to the state the standard publishes.
 * The fixture's journal was written **by hand**, which is the point — a library
 * written by a working implementation contains only what that implementation
 * can write, and the cases that matter are the ones nobody writes on purpose.
 */

/** Where the standard is checked out. A sibling of this repository by default. */
const STANDARD = fileURLToPath(new URL("../../../../roost-library/", import.meta.url));

const CONFORMANCE = join(STANDARD, "conformance");

/**
 * What `expected.json` publishes, in its own names.
 *
 * Read rather than restated. A test that copied the numbers out would pass
 * forever after the standard changed one of them, which is the failure this
 * whole arrangement is built to avoid.
 */
interface Expected {
  readonly format_version: number;
  readonly replay: {
    readonly records_total: number;
    readonly records_torn: number;
    readonly records_unrecognised: number;
    readonly records_dangling: number;
    readonly records_effective: number;
    readonly unrecognised: readonly {
      readonly op: string;
      readonly kind: string;
      readonly platform: string | null;
    }[];
  };
  readonly library: { readonly id: string; readonly name: string; readonly created_at: number };
  readonly assets: readonly Record<string, unknown>[];
  readonly tags: readonly string[];
  readonly folders: readonly {
    readonly id: number;
    readonly parent: number | null;
    readonly name: string;
  }[];
  readonly tag_groups: readonly unknown[];
  readonly smart_folders: readonly unknown[];
}

let work: string;
let library: string;
let noSuffix: string;
let expected: Expected;
let db: Db;
let report: Awaited<ReturnType<typeof replay>>;

beforeAll(async () => {
  // Said plainly, because a bare ENOENT reads as a broken test rather than as a
  // missing checkout: this suite is another repository's, and its absence means
  // the standard is not beside this one.
  if (!existsSync(CONFORMANCE)) {
    throw new Error(
      `The Roost Library Format's conformance suite is not at ${CONFORMANCE}. ` +
        "Check the roost-library repository out beside this one — see docs/SETUP.md.",
    );
  }

  expected = JSON.parse(await readFile(join(CONFORMANCE, "expected.json"), "utf8")) as Expected;

  // Copied before anything is read, as the suite's README requires: replaying
  // produces a cache, the fixture is committed without one on purpose, and a
  // committed `index.db` would bake this build's schema into a shared fixture.
  work = await mkdtemp(join(tmpdir(), "roost-conformance-"));
  library = join(work, `library${LIBRARY_SUFFIX}`);
  noSuffix = join(work, "made-before-the-rule");
  await cp(join(CONFORMANCE, "library.roost"), library, { recursive: true });
  await cp(join(CONFORMANCE, "made-before-the-rule"), noSuffix, { recursive: true });

  db = Db.openInMemory();
  report = await replay(join(library, "journal"), new IndexSink(db));
}, 60_000);

afterAll(async () => {
  db?.close();
  if (work !== undefined) await rm(work, { recursive: true, force: true });
});

describe("replaying the conformance library", () => {
  it("applies exactly the records the standard says are effective", () => {
    expect(report.applied).toBe(expected.replay.records_effective);
  });

  it("accounts for every line in the journal", () => {
    const seen =
      report.applied +
      [...report.unknownOps.values()].reduce((sum, count) => sum + count, 0) +
      report.dangling.length +
      report.tornTrailing.length +
      report.malformed.length;
    expect(seen).toBe(expected.replay.records_total);
  });

  it("reads the two months in chronological order", () => {
    // `2026-02` renames a tag created in `2026-01`, so the wrong order lands a
    // different tag set (RL-19, RL-20).
    expect(report.months).toEqual(["2026-01", "2026-02"]);
  });

  it("skips the truncated final line rather than calling the journal corrupt", () => {
    expect(report.tornTrailing).toHaveLength(expected.replay.records_torn);
    expect(report.malformed).toHaveLength(0);
  });

  it("skips what it does not recognise, and can name whose it is", () => {
    // RL-26, RL-28, RL-29. The prefix is the whole of what lets a message say
    // "this is available in Roost for Mac" without a registry of features.
    expect([...report.unknownOps.keys()].sort()).toEqual(
      expected.replay.unrecognised.map((entry) => entry.op).sort(),
    );

    for (const entry of expected.replay.unrecognised) {
      expect(platformOf(entry.op) ?? null).toBe(entry.platform);
      expect(entry.kind).toBe(entry.platform === null ? "core" : "platform");
    }

    // `win.` is a *newer build of the same platform* to a Windows Roost and
    // another platform to this one; either way the person is told a name.
    expect(platformName("mac")).toBe("Roost for Mac");
    expect(platformName("win")).toBe("Roost for Windows");
  });

  it("counts a dangling reference apart from damage, and invents nothing", () => {
    // RL-26a. `folder_add` names folder 99, which was never created.
    expect(report.dangling).toHaveLength(expected.replay.records_dangling);
    expect(report.dangling[0]?.reason).toContain("folder 99");
    expect(db.repo.folders().some((folder) => folder.id === 99)).toBe(false);
  });
});

describe("the state a correct replay produces", () => {
  it("lands every asset the standard publishes, field for field", () => {
    expect(db.repo.allHashes()).toHaveLength(expected.assets.length);

    for (const want of expected.assets) {
      const hash = parseContentHash(want["hash"] as string);
      const got = db.repo.assetDetail(hash);
      expect(got, `asset ${hash}`).toBeDefined();
      if (got === undefined) continue;

      expect(got.ext).toBe(want["ext"]);
      expect(got.size).toBe(want["size"]);
      // RL-36: the composed spelling, not the decomposed one. The fixture's
      // `café möbel.png` is `caf` U+00E9, and a build that normalised the other
      // way would hold a name that looks identical and compares unequal.
      expect(got.origName).toBe(want["name"]);
      expect(got.storageMode).toBe(want["mode"]);
      expect(got.linkMethod).toBe(want["link"] ?? null);
      expect(got.width).toBe(want["width"] ?? null);
      expect(got.height).toBe(want["height"] ?? null);
      expect(got.createdAt).toBe(want["created_at"] ?? null);
      expect(got.isPartialHash).toBe(want["partial_hash"]);
      expect(got.trashedAt !== null).toBe(want["trashed"]);
      if (want["trashed_at"] !== undefined) expect(got.trashedAt).toBe(want["trashed_at"]);
      expect(got.isFavorite).toBe(want["favorite"]);
      expect(got.rating).toBe(want["rating"]);
      expect(got.note).toBe(want["note"]);
      expect(got.sourceUrl).toBe(want["source_url"]);
      expect(got.supersededBy).toBe(want["superseded_by"]);
      expect(got.tags).toEqual(want["tags"]);
      expect(got.folders.map((folder) => folder.id)).toEqual(want["folders"]);

      expect(
        db.repo.commentsFor(hash).map((comment) => ({
          id: comment.id,
          at: comment.atMs,
          body: comment.body,
        })),
      ).toEqual(want["comments"]);
    }
  });

  it("holds the tags, folders, groups and smart folders the standard publishes", () => {
    expect(db.repo.tags().map((tag) => tag.name)).toEqual([...expected.tags]);
    expect(
      db.repo.folders().map((folder) => ({
        id: folder.id,
        parent: folder.parentId,
        name: folder.name,
      })),
    ).toEqual([...expected.folders]);
    expect(db.repo.tagGroups()).toEqual([...expected.tag_groups]);
    expect(db.repo.smartFolders()).toEqual([...expected.smart_folders]);
  });

  it("puts a file with no extension at the bare hash, with no trailing dot", async () => {
    // RL-8b, and the one a Windows build can break without noticing: Windows
    // strips a trailing dot before the path reaches the filesystem, so a build
    // that wrote `…d663.` would find it again through its own API and produce a
    // library Linux and macOS cannot read. Checked against the fixture's own
    // directory entry rather than against this build's idea of the path.
    const want = expected.assets.find((asset) => asset["ext"] === "");
    expect(want).toBeDefined();

    const stored = want?.["stored_at"] as string;
    const hash = parseContentHash(want?.["hash"] as string);
    const path = new ManagedStorage(library).locate(hash, "");

    expect(path).toBe(join(library, ...stored.split("/")));
    expect((await stat(path)).isFile()).toBe(true);
  });
});

describe("identifying a library", () => {
  it("reads the fixture's manifest exactly as published", async () => {
    const manifest = await readManifest(library);
    expect(manifest.roost_library_version).toBe(expected.format_version);
    expect(manifest.id).toBe(expected.library.id);
    expect(manifest.name).toBe(expected.library.name);
    expect(manifest.created_at).toBe(expected.library.created_at);
  });

  it("opens a library whose folder has no suffix, and names it from its manifest", async () => {
    // RL-6b, and the case that matters: requiring the suffix on write is a
    // change somebody notices the same day, and requiring it on read is one
    // nobody notices until a library made before the rule has stopped opening.
    const manifest = await readManifest(noSuffix);
    expect(manifest.name).toBe("Made before the rule");
    expect(libraryNameFromPath(noSuffix)).toBe("made-before-the-rule");

    // …and it is still where it was. RL-6b forbids renaming one that is found.
    expect(existsSync(noSuffix)).toBe(true);
  });

  it("leaves no cache inside the fixture it was handed", async () => {
    // The standard commits its library without an `index.db` and forbids adding
    // one: a committed cache would bake one implementation's schema into a
    // shared fixture. This suite replays into memory, which is how it keeps
    // that promise even when it is pointed at the checkout itself.
    expect(existsSync(join(CONFORMANCE, "library.roost", "index.db"))).toBe(false);
  });
});

/** Two assertions about the hashing vectors, which live in their own document. */
describe("the hashing vectors", () => {
  it("publishes the digests this build asserts", async () => {
    // `packages/media/src/hash.test.ts` is where they are actually checked,
    // against files it generates. This makes sure the two documents have not
    // parted company: a digest corrected in the standard and not here would
    // leave that test asserting a number nobody publishes any more.
    const published = await readFile(join(CONFORMANCE, "hashing.md"), "utf8");
    const ours = await readFile(
      fileURLToPath(new URL("../../media/src/hash.test.ts", import.meta.url)),
      "utf8",
    );
    const digests = [...published.matchAll(/`([0-9a-f]{64})`/g)].map((match) => match[1] as string);

    expect(digests.length).toBeGreaterThanOrEqual(6);
    for (const digest of digests) expect(ours).toContain(digest);
  });
});
