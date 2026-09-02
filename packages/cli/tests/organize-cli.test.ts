import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, run } from "@roost/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Collects what a command would have printed, so no subprocess is needed. */
function capture(): {
  streams: Parameters<typeof run>[1];
  out: string[];
  warn: string[];
} {
  const out: string[] = [];
  const warn: string[] = [];
  return {
    streams: { out: (l) => out.push(l), warn: (l) => warn.push(l), progress: () => {} },
    out,
    warn,
  };
}

describe("the organize commands", () => {
  let dir: string;
  let root: string;
  let hashes: string[];

  /** Runs a command and asserts it succeeded, returning its stdout lines. */
  const ok = async (...argv: string[]): Promise<string[]> => {
    const { streams, out, warn } = capture();
    const code = await run([...argv, "-L", root], streams);
    expect({ code, warn }).toEqual({ code: EXIT.ok, warn: [] });
    return out;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-organize-cli-"));
    root = join(dir, "library.roost");
    const source = join(dir, "pictures");
    await mkdir(source, { recursive: true });
    // Bytes, not images: nothing here thumbnails, and a distinct payload per
    // file is all the importer needs to give each one its own hash.
    for (const [index, name] of ["alpha.png", "beta.png", "gamma.png"].entries()) {
      await writeFile(join(source, name), `roost test payload ${index}`);
    }

    await run(["init", root], capture().streams);
    await run(["import", source, "-L", root], capture().streams);
    hashes = await ok("query", "", "--hashes");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("searches, counts, and pipes hashes", async () => {
    expect(hashes).toHaveLength(3);
    expect(await ok("query", "ext:png", "--count")).toEqual(["3"]);
    expect(await ok("query", "ext:jpg", "--count")).toEqual(["0"]);
    expect(await ok("query", "ext:png", "--limit", "2")).toHaveLength(2);

    // A listed row carries the hash prefix every other command accepts.
    const [first] = await ok("query", "alpha");
    expect(first).toContain("alpha.png");
    expect(hashes.some((hash) => hash.startsWith((first ?? "").slice(0, 12)))).toBe(true);
  });

  it("takes a negated query after --, which otherwise reads as a flag", async () => {
    // `-tag:wip` starts with a dash and is a flag to any argument parser, this
    // one and the Rust build's alike. `--` is the escape hatch both offer, and
    // the help says so because the failure otherwise looks like a parser bug.
    await ok("tag", "add", "--tag", "wip", hashes[0] as string);

    const negated = capture();
    expect(await run(["query", "-L", root, "--count", "--", "-tag:wip"], negated.streams)).toBe(
      EXIT.ok,
    );
    expect(negated.out).toEqual(["2"]);
  });

  it("tags by prefix, and finds what it tagged", async () => {
    const prefix = (hashes[0] as string).slice(0, 10);
    await ok("tag", "add", "--tag", "wood", "--tag", "wip", prefix);

    expect(await ok("query", "tag:wood tag:wip", "--count")).toEqual(["1"]);
    expect((await ok("tag", "list")).join("\n")).toContain("wood");

    await ok("tag", "remove", "--tag", "wip", prefix);
    expect(await ok("query", "tag:wip", "--count")).toEqual(["0"]);
  });

  it("groups tags without changing what tag: means", async () => {
    await ok("tag", "add", "--tag", "oak wood", hashes[0] as string);
    await ok("tag", "group", "create", "Material");
    await ok("tag", "group", "add", "Material", "oak wood");

    expect((await ok("tag", "group", "list")).join("\n")).toContain("Material");
    expect((await ok("tag", "list")).join("\n")).toContain("Material");
    // The group arranges the tag; it does not rename or nest it.
    expect(await ok("query", 'tag:"oak wood"', "--count")).toEqual(["1"]);
  });

  it("puts assets in a folder and finds them through the subtree", async () => {
    await ok("folder", "create", "Design");
    await ok("folder", "create", "Icons", "--parent", "Design");
    await ok("folder", "add", "Design/Icons", hashes[0] as string);

    expect(await ok("query", "folder:Design", "--count")).toEqual(["1"]);
    expect((await ok("folder", "list")).join("\n")).toContain("Icons");

    await ok("folder", "remove", "Design/Icons", hashes[0] as string);
    expect(await ok("query", "folder:Design", "--count")).toEqual(["0"]);
  });

  it("rates, favourites, notes, renames, and shows the result", async () => {
    const prefix = (hashes[0] as string).slice(0, 10);
    await ok("rate", "4", prefix);
    await ok("favorite", prefix);
    await ok("note", prefix, "needs", "a", "crop");
    await ok("rename", prefix, "renamed.png");

    const shown = (await ok("show", prefix)).join("\n");
    expect(shown).toContain("renamed.png");
    expect(shown).toContain("needs a crop");
    expect(await ok("query", "rating:4 is:favorite", "--count")).toEqual(["1"]);

    await ok("rate", "none", prefix);
    await ok("favorite", "--off", prefix);
    await ok("note", prefix, "--clear");
    expect(await ok("query", "is:unrated -is:favorite", "--count")).toEqual(["3"]);
  });

  it("saves a query and evaluates it on every read", async () => {
    await ok("tag", "add", "--tag", "wood", hashes[0] as string);
    const created = await ok("smart", "create", "Wooden", "tag:wood");
    expect(created.join("\n")).toContain("1 match now");

    // Tagging a second asset changes what the saved folder holds, without the
    // saved folder being touched. That is the whole point of storing the query.
    await ok("tag", "add", "--tag", "wood", hashes[1] as string);
    expect((await ok("smart", "list")).join("\n")).toContain("      2  Wooden");

    await ok("smart", "update", "Wooden", "--query", "tag:wood rating:5");
    expect((await ok("smart", "list")).join("\n")).toContain("tag:wood rating:5");
    await ok("smart", "delete", "Wooden");
    expect((await ok("smart", "list")).join("\n")).toContain("No smart folders yet");
  });

  it("removes index rows and says the bytes are still there", async () => {
    const out = await ok("remove", hashes[0] as string);
    expect(out.join("\n")).toContain("Originals were not deleted");
    expect(await ok("query", "", "--count")).toEqual(["2"]);
  });

  it("separates a wrong command line from a command that failed", async () => {
    // Exit 2 is "you typed something I cannot act on"; exit 1 is "I tried".
    const missingTag = capture();
    expect(await run(["tag", "add", hashes[0] as string, "-L", root], missingTag.streams)).toBe(
      EXIT.usage,
    );
    expect(missingTag.warn.join("\n")).toContain("--tag");

    const badRating = capture();
    expect(await run(["rate", "eleven", hashes[0] as string, "-L", root], badRating.streams)).toBe(
      EXIT.usage,
    );

    const badSubcommand = capture();
    expect(await run(["folder", "frobnicate", "-L", root], badSubcommand.streams)).toBe(EXIT.usage);

    const unknownAsset = capture();
    expect(await run(["show", "ffffffffff", "-L", root], unknownAsset.streams)).toBe(EXIT.failed);
    expect(unknownAsset.warn.join("\n")).toContain("[unknown_asset]");

    const brokenQuery = capture();
    expect(
      await run(["smart", "create", "Broken", "rating:>=", "-L", root], brokenQuery.streams),
    ).toBe(EXIT.failed);
    expect(brokenQuery.warn.join("\n")).toContain("[invalid_query]");
  });

  it("reports a healthy library, and exits 1 once there is damage", async () => {
    expect((await ok("doctor")).join("\n")).toContain("Nothing wrong");

    // Bytes gone, row still there. Exit 1 rather than 0, so a scheduled run is
    // a check and not a report nobody reads.
    const { rm } = await import("node:fs/promises");
    const [hash] = hashes;
    if (hash === undefined) throw new Error("nothing was imported");
    const shard = hash.slice(0, 2);
    await rm(join(root, "originals", shard, `${hash}.png`));

    const damaged = capture();
    expect(await run(["doctor", "-L", root], damaged.streams)).toBe(EXIT.failed);
    expect(damaged.out.join("\n")).toContain("Assets whose bytes are gone: 1");

    // Reclaiming acts on the index's word, and the index is exactly what this
    // report says cannot be trusted.
    const refused = capture();
    expect(await run(["doctor", "-L", root, "--reclaim"], refused.streams)).toBe(EXIT.failed);
    expect(refused.warn.join("\n")).toContain("[unsound_reclaim]");

    // --force means nothing on its own, and saying so beats ignoring it.
    const lonely = capture();
    expect(await run(["doctor", "-L", root, "--force"], lonely.streams)).toBe(EXIT.usage);
  });

  it("chooses which frame a video's thumbnail comes from, and says so", async () => {
    // ADR-0005: every user-authored mutation has a verb here, so nothing is
    // writable only from the window and the rebuild test can author one.
    const clips = join(dir, "clips");
    await mkdir(clips, { recursive: true });
    await writeFile(join(clips, "clip.mp4"), "not really a video");
    await ok("import", clips);
    const clip = (await ok("query", "ext:mp4", "--hashes"))[0] as string;

    expect(await ok("poster", clip)).toEqual([expect.stringContaining("default frame")]);

    const pinned = await ok("poster", clip, "--at", "1:31.5");
    // The picture is not drawn here: `import` and `thumb` are separate commands
    // and this is a third, so the line says which one redraws it.
    expect(pinned[0]).toContain("1:31.500");
    expect(pinned[0]).toContain("roost thumb");
    expect(await ok("poster", clip)).toEqual([expect.stringContaining("1:31.500")]);

    // The same moment again writes nothing, and says that rather than nothing.
    expect((await ok("poster", clip, "--at", "91500ms"))[0]).toContain("already");

    expect((await ok("poster", clip, "--clear"))[0]).toContain("default frame");
    expect(await ok("poster", clip)).toEqual([expect.stringContaining("default frame")]);
  });

  it("refuses a thumbnail moment on something with no frames", async () => {
    const { streams, warn } = capture();
    expect(await run(["poster", hashes[0] as string, "--at", "1:00", "-L", root], streams)).toBe(
      EXIT.failed,
    );
    expect(warn.join("\n")).toContain("[not_a_video]");
  });

  it("refuses --clear and --at together, which ask for different things", async () => {
    const { streams } = capture();
    expect(
      await run(["poster", hashes[0] as string, "--clear", "--at", "1:00", "-L", root], streams),
    ).toBe(EXIT.usage);
  });

  it("lets two commands spell the same flag differently", async () => {
    // `--count` is a number for fixture and a bare switch for query. One shared
    // option table could hold only one of them, and did.
    const corpus = join(dir, "corpus");
    const { streams } = capture();
    expect(await run(["fixture", corpus, "--count", "4", "--seed", "7"], streams)).toBe(EXIT.ok);
    expect(await ok("query", "", "--count")).toEqual(["3"]);
  });
});
