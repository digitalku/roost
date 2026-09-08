import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentHash } from "@roost/core";
import {
  importEagle,
  Library,
  NotAnEagleLibraryError,
  rate,
  setNote,
  setSource,
  surveyEagle,
} from "@roost/library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Importing an Eagle library (ADR-0032).
 *
 * The fixture is built rather than committed, and it is deliberately *not* a
 * copy of the library this was written against: it carries the cases that one
 * did not have — nested folders, an item in two of them, a tag group, an item
 * in Eagle's trash, and two items whose bytes are identical — alongside the six
 * conventions that a parser written from memory gets wrong.
 */

/** Eagle writes `""` for an absent URL or note, and omits `star` entirely. */
interface ItemFixture {
  readonly id: string;
  readonly name: string;
  readonly ext: string;
  readonly bytes: string;
  readonly tags?: readonly string[];
  readonly folders?: readonly string[];
  readonly star?: number;
  readonly annotation?: string;
  readonly url?: string;
  readonly isDeleted?: boolean;
  readonly comments?: readonly { duration: number; annotation: string }[];
  /** Eagle's own preview, which must never be imported as an asset. */
  readonly thumbnail?: boolean;
  /** A caption dropped beside the file, which Eagle's metadata never mentions. */
  readonly srt?: string;
}

const ITEMS: readonly ItemFixture[] = [
  {
    id: "a1",
    name: "photo one",
    ext: "jpg",
    bytes: "the first picture",
    tags: ["blue", "wip"],
    thumbnail: true,
  },
  {
    id: "a2",
    name: "photo two",
    ext: "jpg",
    bytes: "the second picture",
    tags: ["blue"],
    folders: ["f-icons", "f-deep"],
    star: 4,
    annotation: "a note about the asset",
    url: "https://example.test/post/1",
    comments: [
      { duration: 726.211598, annotation: "a comment at twelve minutes" },
      { duration: 0.854957, annotation: "one right at the start" },
    ],
  },
  {
    id: "a3",
    name: "photo three",
    ext: "jpg",
    bytes: "the third picture",
    folders: ["f-gym"],
    isDeleted: true,
  },
  // Identical bytes to a1, which is one asset here however many items Eagle
  // gives it. Its tags have to survive the collapse.
  { id: "a4", name: "photo one copy", ext: "jpg", bytes: "the first picture", tags: ["dupe"] },
  {
    id: "a5",
    name: "clip",
    ext: "mp4",
    bytes: "not really a video",
    srt: "1\n00:00:01,000 --> 00:00:02,000\nhello\n",
  },
  { id: "a6", name: "README", ext: "", bytes: "a file with no extension" },
];

/**
 * Writes an Eagle library. `items` defaults to the shared fixture; a test that
 * needs a shape the fixture does not have passes its own rather than growing
 * the one every other test asserts counts against.
 */
async function writeEagleLibrary(
  root: string,
  items: readonly ItemFixture[] = ITEMS,
): Promise<void> {
  await mkdir(join(root, "images"), { recursive: true });

  await writeFile(
    join(root, "metadata.json"),
    JSON.stringify({
      folders: [
        {
          id: "f-icons",
          // Roost refuses "/" in a folder name, so this one has to be rewritten.
          name: "Design/Icons",
          children: [{ id: "f-deep", name: "Deep", children: [] }],
        },
        { id: "f-gym", name: "gym", children: [] },
      ],
      smartFolders: [{ id: "s1", name: "Recent", conditions: [] }],
      tagsGroups: [{ id: "g1", name: "Mood", tags: ["blue"] }],
      quickAccess: [],
      applicationVersion: "4.0.0",
    }),
  );

  // `historyTags` is a typing history, not the vocabulary: "ghost" is a tag
  // nothing carries, and importing it would invent one.
  await writeFile(
    join(root, "tags.json"),
    JSON.stringify({ historyTags: ["blue", "ghost"], starredTags: [] }),
  );
  // "all" is the item count, not an item id.
  await writeFile(join(root, "mtime.json"), JSON.stringify({ a1: 1, a2: 2, all: items.length }));

  for (const item of items) {
    const dir = join(root, "images", `${item.id}.info`);
    await mkdir(dir, { recursive: true });

    const file = item.ext === "" ? item.name : `${item.name}.${item.ext}`;
    await writeFile(join(dir, file), item.bytes);
    if (item.thumbnail === true) {
      await writeFile(join(dir, `${item.name}_thumbnail.png`), "a preview Eagle drew");
    }
    if (item.srt !== undefined) await writeFile(join(dir, `${item.name}.srt`), item.srt);

    await writeFile(
      join(dir, "metadata.json"),
      JSON.stringify({
        id: item.id,
        name: item.name,
        size: item.bytes.length,
        btime: 1_700_000_000_000,
        mtime: 1_600_000_000_000,
        ext: item.ext,
        tags: item.tags ?? [],
        folders: item.folders ?? [],
        isDeleted: item.isDeleted ?? false,
        url: item.url ?? "",
        annotation: item.annotation ?? "",
        modificationTime: 1_700_000_000_000,
        // Present on some items and not others, exactly as Eagle writes it.
        ...(item.star === undefined ? {} : { star: item.star }),
        ...(item.comments === undefined ? {} : { comments: item.comments }),
        palettes: [{ color: [1, 2, 3], ratio: 50, $$hashKey: "object:961" }],
      }),
    );
  }

  // An item whose metadata cannot be read must not end the import.
  const broken = join(root, "images", "bad.info");
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, "metadata.json"), "{{{ not json");
}

describe("importing an Eagle library", () => {
  let dir: string;
  let eagle: string;
  let library: Library;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-eagle-"));
    eagle = join(dir, "Sample.library");
    await writeEagleLibrary(eagle);
    library = await Library.create(join(dir, "library"), "test");
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a directory that is not an Eagle library", async () => {
    await expect(surveyEagle(join(dir, "library"))).rejects.toBeInstanceOf(NotAnEagleLibraryError);
  });

  it("surveys without writing anything", async () => {
    const survey = await surveyEagle(eagle);

    expect(survey.version).toBe("4.0.0");
    expect(survey.items).toBe(ITEMS.length);
    expect(survey.folders).toBe(3);
    expect(survey.rated).toBe(1);
    expect(survey.notes).toBe(1);
    expect(survey.sources).toBe(1);
    expect(survey.comments).toBe(2);
    expect(survey.subtitles).toBe(1);
    expect(survey.trashed).toBe(1);
    // Every tag any item carries, and nothing from `tags.json`.
    expect(survey.tags).toEqual(["blue", "dupe", "wip"]);
    expect(survey.renamedFolders).toEqual([{ from: "Design/Icons", to: "Design-Icons" }]);
    expect(survey.unreadable).toHaveLength(1);

    expect(library.db.repo.stats().assets).toBe(0);
  });

  it("brings the items across, and only the items", async () => {
    const report = await importEagle(library, eagle);

    // Six items, two of which are one asset, plus the subtitle — which is an
    // asset of its own (ADR-0025). Eagle's thumbnail and its metadata.json are
    // not assets at all.
    expect(report.assets).toBe(5);
    expect(report.collapsed).toBe(1);
    expect(library.db.repo.stats().assets).toBe(6);

    const names = library.db.repo
      .folders()
      .map((folder) => folder.name)
      .sort();
    expect(names).toEqual(["Deep", "Design-Icons", "gym"]);
  });

  it("keeps a folder's nesting, and an item in two folders", async () => {
    await importEagle(library, eagle);

    const folders = library.db.repo.folders();
    const icons = folders.find((folder) => folder.name === "Design-Icons");
    const deep = folders.find((folder) => folder.name === "Deep");
    expect(deep?.parentId).toBe(icons?.id);

    const hash = hashOf(library, "photo two.jpg");
    const memberships = library.db.repo.folderIdsFor(hash).slice().sort();
    expect(memberships).toEqual([icons?.id, deep?.id].sort());
  });

  it("reads a rating only where Eagle wrote one", async () => {
    await importEagle(library, eagle);

    expect(library.db.repo.assetDetail(hashOf(library, "photo two.jpg"))?.rating).toBe(4);
    // `star` is omitted when unrated, and an omitted field is not a zero.
    expect(
      library.db.repo.assetDetail(hashOf(library, "photo one.jpg", "photo one copy.jpg"))?.rating,
    ).toBeNull();
  });

  it("carries the note, the URL, and the comments in milliseconds", async () => {
    await importEagle(library, eagle);
    const hash = hashOf(library, "photo two.jpg");

    const detail = library.db.repo.assetDetail(hash);
    expect(detail?.note).toBe("a note about the asset");
    expect(detail?.sourceUrl).toBe("https://example.test/post/1");

    // Eagle's field is called `duration` and holds float seconds; `at_ms` is
    // milliseconds, and this is the conversion.
    const moments = library.db.repo.commentsFor(hash).map((comment) => comment.atMs);
    expect(moments).toContain(726_212);
    expect(moments).toContain(855);
  });

  it("puts an item Eagle had deleted into the trash, not into nothing", async () => {
    await importEagle(library, eagle);

    const hash = hashOf(library, "photo three.jpg");
    expect(library.db.repo.trashedAt(hash)).toBeTypeOf("number");
  });

  it("merges the tags of two items whose bytes are the same", async () => {
    await importEagle(library, eagle);

    const tags =
      library.db.repo.assetDetail(hashOf(library, "photo one.jpg", "photo one copy.jpg"))?.tags ??
      [];
    expect(tags.slice().sort()).toEqual(["blue", "dupe", "wip"]);
  });

  it("attaches a subtitle nothing in Eagle's metadata mentions", async () => {
    const report = await importEagle(library, eagle);

    expect(report.subtitles).toBe(1);
    expect(library.db.repo.subtitlesFor(hashOf(library, "clip.mp4"))).toHaveLength(1);
  });

  it("creates the tag groups, and no tag Eagle only remembers having typed", async () => {
    await importEagle(library, eagle);

    expect(library.db.repo.findTagGroupByName("Mood")).toBeDefined();
    const tags = library.db.repo.tags().map((tag) => tag.name);
    expect(tags).not.toContain("ghost");
  });

  it("can be run twice", async () => {
    await importEagle(library, eagle);
    const before = snapshot(library);

    const second = await importEagle(library, eagle);

    expect(second.imported).toBe(0);
    expect(second.folders).toBe(0);
    expect(second.comments).toBe(0);
    expect(snapshot(library)).toEqual(before);
  });

  it("fills a rating, a note and a URL, and never overwrites one", async () => {
    // ADR-0032 §8, the user's decision of 2026-09-08. Re-running an import must
    // not undo the judgements somebody made here in between.
    await importEagle(library, eagle);
    const hash = hashOf(library, "photo two.jpg");
    await rate(library, [hash], 1);
    await setNote(library, hash, "what I actually think");
    await setSource(library, hash, "https://example.test/mine");

    const second = await importEagle(library, eagle);

    const detail = library.db.repo.assetDetail(hash);
    expect(detail?.rating).toBe(1);
    expect(detail?.note).toBe("what I actually think");
    expect(detail?.sourceUrl).toBe("https://example.test/mine");
    // Counted rather than silent: an import that left a note alone and one that
    // found no note are otherwise indistinguishable afterwards.
    expect(second.preserved).toBe(3);
    expect({ ratings: second.ratings, notes: second.notes, sources: second.sources }).toEqual({
      ratings: 0,
      notes: 0,
      sources: 0,
    });
  });

  it("says nothing was preserved on a first run, because nothing was there", async () => {
    const report = await importEagle(library, eagle);

    expect(report.preserved).toBe(0);
    expect({ ratings: report.ratings, notes: report.notes, sources: report.sources }).toEqual({
      ratings: 1,
      notes: 1,
      sources: 1,
    });
  });

  it("does not let one item overwrite another that shares its bytes", async () => {
    // The index cannot answer "is this empty" inside a chunk: the ops are
    // applied at the end, so both items would read an empty note and the second
    // would win. Identical bytes are one asset, and the rule holds within a run
    // as much as between two.
    const twins = join(dir, "Twins.library");
    await writeEagleLibrary(twins, [
      { id: "b1", name: "first", ext: "jpg", bytes: "one and the same", star: 5, annotation: "a" },
      { id: "b2", name: "second", ext: "jpg", bytes: "one and the same", star: 1, annotation: "b" },
    ]);

    const report = await importEagle(library, twins);

    expect(report.collapsed).toBe(1);
    // Which of the two lands is the directory's order to decide; that exactly
    // one does is this rule.
    expect({ ratings: report.ratings, notes: report.notes, preserved: report.preserved }).toEqual({
      ratings: 1,
      notes: 1,
      preserved: 2,
    });
    const detail = library.db.repo.assetDetail(hashOf(library, "first.jpg", "second.jpg"));
    expect([5, 1]).toContain(detail?.rating);
    expect(["a", "b"]).toContain(detail?.note);
  });

  it("applies a run-wide tag to items the library already held", async () => {
    await importEagle(library, eagle);
    await importEagle(library, eagle, { tags: ["migrated"] });

    // The second run imported no bytes at all, so a tag applied only to new
    // files would have reached nothing.
    expect(
      library.db.repo.assetDetail(hashOf(library, "photo one.jpg", "photo one copy.jpg"))?.tags,
    ).toContain("migrated");
  });

  it("rebuilds to the same state, because everything went through the journal", async () => {
    await importEagle(library, eagle);
    const before = snapshot(library);

    await library.rebuild();

    expect(snapshot(library)).toEqual(before);
  });
});

/**
 * The hash of the asset that came in under one of `names`.
 *
 * Several names, because two items with identical bytes are one asset and
 * **which of their names it keeps is undetermined** — the first of the two the
 * directory happened to yield is the one that journalled the `add`. That is
 * content addressing working, not a bug, so the test asks for either.
 */
function hashOf(library: Library, ...names: readonly string[]): ContentHash {
  for (const hash of library.db.repo.allHashes()) {
    const detail = library.db.repo.assetDetail(hash);
    if (detail !== undefined && names.includes(detail.origName)) return hash;
  }
  throw new Error(`no asset called ${names.join(" or ")}`);
}

/** Everything a rebuild or a second run must not change. */
function snapshot(library: Library): unknown {
  const hashes = library.db.repo.allHashes().slice().sort();
  return {
    stats: library.db.repo.stats(),
    folders: library.db.repo.folders(),
    tags: library.db.repo.tags(),
    memberships: hashes.map((hash) => library.db.repo.folderIdsFor(hash).slice().sort()),
    comments: hashes.flatMap((hash) =>
      library.db.repo.commentsFor(hash).map(({ atMs, body }) => ({ hash, atMs, body })),
    ),
  };
}
