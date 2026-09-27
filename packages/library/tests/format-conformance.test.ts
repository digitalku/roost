import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AssetId,
  Db,
  FileStore,
  IndexSink,
  parseAssetId,
  platformName,
  platformOf,
  replay,
} from "@roost/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotALibraryError } from "../src/error.js";
import { readManifest } from "../src/manifest.js";
import { LIBRARY_SUFFIX, libraryNameFromPath } from "../src/naming.js";

/**
 * The format's conformance suite, run against this build (RL-52).
 *
 * It came from the `roost-library` repository and has lived at this
 * repository's root since ADR-0052. What it checks is what the build's own
 * tests cannot: that a journal nobody here wrote replays to the published
 * state. The fixture's journal was written **by hand**, which is the point — a
 * library written by a working build contains only what that build can write,
 * and the cases that matter are the ones nobody writes on purpose.
 */
const CONFORMANCE = fileURLToPath(new URL("../../../conformance/", import.meta.url));

/**
 * What `expected.json` publishes, in its own names.
 *
 * Read rather than restated. A test that copied the numbers out would pass
 * forever after the suite changed one of them, which is the failure this
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
  readonly tags_in_use: readonly string[];
  readonly folders: readonly {
    readonly id: number;
    readonly parent: number | null;
    readonly name: string;
  }[];
  readonly tag_groups: readonly { readonly id: number; readonly name: string }[];
  readonly smart_folders: readonly {
    readonly id: number;
    readonly parent: number | null;
    readonly name: string;
    readonly query: string;
  }[];
  readonly comments: readonly {
    readonly id: number;
    readonly asset: string;
    readonly at: number | null;
    readonly body: string;
  }[];
  readonly watched_roots: readonly {
    readonly id: number;
    readonly path: string;
    readonly take: string;
  }[];
  readonly files: {
    readonly present: readonly string[];
    readonly not_adopted: readonly string[];
  };
}

let work: string;
let library: string;
let noSuffix: string;
let expected: Expected;
let db: Db;
let report: Awaited<ReturnType<typeof replay>>;

beforeAll(async () => {
  // Said plainly, because a bare ENOENT reads as a broken test rather than as a
  // fixture that went missing from the tree.
  if (!existsSync(CONFORMANCE)) {
    throw new Error(`The conformance suite is not at ${CONFORMANCE} — see ADR-0052.`);
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
  it("applies exactly the records the suite says are effective", () => {
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
    // different tag set (RL-28, RL-29).
    expect(report.months).toEqual(["2026-01", "2026-02"]);
  });

  it("skips the truncated final line rather than calling the journal corrupt", () => {
    expect(report.tornTrailing).toHaveLength(expected.replay.records_torn);
    expect(report.malformed).toHaveLength(0);
  });

  it("skips what it does not recognise, and can name whose it is", () => {
    // RL-37, RL-40, RL-41. The prefix is the whole of what lets a message say
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

  it("keeps a field it does not know, rather than rejecting the record (RL-44)", () => {
    // The first `add` carries `spotlight_id`, which is another implementation's
    // business. The asset imports normally; nothing here rewrites the record.
    expect(db.repo.assetDetail(parseAssetId("K7QM4X2AJH9F"))).toBeDefined();
  });

  it("counts a dangling reference apart from damage, and invents nothing", () => {
    // RL-38. `folder_add` names folder 99, which was never created.
    expect(report.dangling).toHaveLength(expected.replay.records_dangling);
    expect(report.dangling[0]?.reason).toContain("folder 99");
    expect(db.repo.folders().some((folder) => folder.id === 99)).toBe(false);
  });
});

describe("the state a correct replay produces", () => {
  it("lands every asset the suite publishes, field for field", () => {
    expect(db.repo.allIds()).toHaveLength(expected.assets.length);

    for (const want of expected.assets) {
      const id = parseAssetId(want["id"] as string);
      const got = db.repo.assetDetail(id);
      expect(got, `asset ${id}`).toBeDefined();
      if (got === undefined) continue;

      expect(got.ext).toBe(want["ext"]);
      // RL-33: the display name, extension excluded. RL-49: the composed
      // spelling, not the decomposed one — the fixture's `café möbel` is `caf`
      // U+00E9, and a build that normalised the other way would hold a name
      // that looks identical and compares unequal.
      expect(got.name).toBe(want["name"]);
      expect(got.createdAt).toBe(want["created"] ?? null);
      expect(got.trashedAt !== null).toBe(want["trashed"]);
      expect(got.isFavorite).toBe(want["favorite"]);
      expect(got.rating).toBe(want["rating"]);
      expect(got.note).toBe(want["note"]);
      expect(got.sourceUrl).toBe(want["source"]);
      expect(got.tags).toEqual(want["tags"]);
      expect(got.folders.map((folder) => folder.id)).toEqual(want["folders"]);

      // **Nothing about the bytes.** The fixture's files are placeholders and
      // their contents are not normative, because every fact about them is
      // derived in version 2 (RL-22) — so a replay that invented a size would
      // be inventing it.
      expect(got.size).toBeNull();
      expect(got.width).toBeNull();
      expect(got.contentHash).toBeNull();

      const subtitles = (want["subtitles"] ?? []) as readonly Record<string, unknown>[];
      expect(
        db.repo.subtitlesFor(id).map((track) => ({
          track: track.trackId,
          lang: track.lang,
          label: track.label,
        })),
      ).toEqual(subtitles.map((track) => ({ ...track })));
    }
  });

  it("holds the comments the suite publishes, on the assets they are about", () => {
    const got = expected.assets.flatMap((asset) =>
      db.repo.commentsFor(parseAssetId(asset["id"] as string)).map((comment) => ({
        id: comment.id,
        asset: comment.assetId as string,
        at: comment.atMs,
        body: comment.body,
      })),
    );
    expect(got).toEqual([...expected.comments]);
  });

  it("holds the tags, folders, groups and smart folders the suite publishes", () => {
    // The tags **in use**: whether a tag with no assets left survives as a row
    // is open (`SPEC.md` §11.4), and this build keeps it — so the comparison is
    // over what is carried rather than over what is listed.
    const inUse = db.repo
      .tags()
      .filter((tag) => tag.count > 0)
      .map((tag) => tag.name);
    expect(inUse).toEqual([...expected.tags_in_use]);

    expect(
      db.repo.folders().map((folder) => ({
        id: folder.id,
        parent: folder.parentId,
        name: folder.name,
      })),
    ).toEqual(sortById(expected.folders));

    expect(db.repo.tagGroups()).toEqual(
      expected.tag_groups.map((group) => ({ id: group.id, name: group.name })),
    );

    // RL-47: a query naming something this build cannot evaluate is stored byte
    // for byte and never repaired. `color:` is exactly that.
    expect(
      db.repo.smartFolders().map((folder) => ({
        id: folder.id,
        parent: folder.parentId,
        name: folder.name,
        query: folder.query,
      })),
    ).toEqual([...expected.smart_folders]);
  });

  it("holds the watched roots, with what each one does to a file it catches", () => {
    expect(db.repo.watchedRoots()).toEqual(expected.watched_roots.map((root) => ({ ...root })));
  });

  it("puts a file with no extension at the bare id, with no trailing dot", async () => {
    // RL-9a, and the one a Windows build can break without noticing: Windows
    // strips a trailing dot before the path reaches the filesystem, so a build
    // that wrote `H8VKC0S6ZB1P.` would find it again through its own API and
    // produce a library Linux and macOS cannot read. Checked against the
    // fixture's own directory entry rather than against this build's idea of
    // the path.
    const want = expected.assets.find((asset) => asset["ext"] === "");
    expect(want).toBeDefined();

    const id = parseAssetId(want?.["id"] as string);
    const path = new FileStore(library).locate(id, "");

    expect(path).toBe(join(library, "files", id.slice(0, 2), id));
    expect((await stat(path)).isFile()).toBe(true);

    // And the entry itself, because a trailing dot is invisible to `stat` on
    // Windows: the name has to come back from the directory.
    const entries = await readdir(join(library, "files", id.slice(0, 2)));
    expect(entries).toContain(id);
    expect(entries).not.toContain(`${id}.`);
  });

  it("neither adopts nor deletes the file whose name is not an id (RL-11)", async () => {
    const store = new FileStore(library);

    const adopted: AssetId[] = [];
    for await (const file of store.iterAll()) adopted.push(file.id);
    // Every id the store walks is an asset the journal created — the lock file
    // is not among them.
    for (const id of adopted) expect(db.repo.assetDetail(id) ?? null).not.toBeNull();

    const unrecognised: string[] = [];
    for await (const path of store.iterUnrecognised()) {
      unrecognised.push(
        path
          .slice(library.length + 1)
          .split("\\")
          .join("/"),
      );
    }
    expect(unrecognised).toEqual([...expected.files.not_adopted]);

    // And it is still there: RL-11 forbids deleting it as firmly as it forbids
    // adopting it.
    for (const path of expected.files.present) {
      expect(existsSync(join(library, ...path.split("/")))).toBe(true);
    }
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
    // RL-7a, and the case that matters: requiring the suffix on write is a
    // change somebody notices the same day, and requiring it on read is one
    // nobody notices until a library made before the rule has stopped opening.
    const manifest = await readManifest(noSuffix);
    expect(manifest.name).toBe("Made before the rule");
    expect(libraryNameFromPath(noSuffix)).toBe("made-before-the-rule");

    // …and it is still where it was. RL-7a forbids renaming one that is found.
    expect(existsSync(noSuffix)).toBe(true);
  });

  it("refuses a version below 2 as not a library, and touches nothing (RL-6a)", async () => {
    // A lower version is not a layout this build reads, so anything it did
    // with one would be a guess (ADR-0053).
    const old = join(work, "version-one.roost");
    await cp(library, old, { recursive: true });

    const manifestPath = join(old, "library.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const before = JSON.stringify({ ...manifest, roost_library_version: 1 });
    await writeFile(manifestPath, before, "utf8");

    await expect(readManifest(old)).rejects.toBeInstanceOf(NotALibraryError);
    // Unchanged, byte for byte: RL-6 forbids modifying anything in a library
    // this build has refused, a cache it cannot read included.
    expect(await readFile(manifestPath, "utf8")).toBe(before);
  });

  it("leaves no cache inside the fixture it was handed", () => {
    // The suite commits its library without an `index.db` and forbids adding
    // one: a committed cache would bake one implementation's schema into a
    // shared fixture. This suite replays into memory, which is how it keeps
    // that promise even when it is pointed at the checkout itself.
    expect(existsSync(join(CONFORMANCE, "library.roost", "index.db"))).toBe(false);
  });
});

/** The folder rows in the order this build's sidebar lists them: by name. */
function sortById<T extends { readonly name: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}
