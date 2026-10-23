import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, run } from "@roost/cli";
import { parseAssetId } from "@roost/core";
import { addSubtitles, Library, subtitles } from "@roost/library";
import { gradient } from "@roost/media";
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
    hashes = await ok("query", "", "--ids");
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
    expect(first).toContain("alpha");
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

  it("deletes a tag from every asset and from the library (ADR-0061)", async () => {
    await ok("tag", "add", "--tag", "draft", hashes[0] as string, hashes[1] as string);
    expect(await ok("tag", "delete", "DRAFT")).toEqual(["Deleted draft, from 2 assets"]);
    expect(await ok("query", "tag:draft", "--count")).toEqual(["0"]);
    expect((await ok("tag", "list")).join("\n")).not.toContain("draft");
    expect(await ok("tag", "delete", "never-was")).toEqual(["No tag called never-was"]);
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

  it("imports into a folder by path, and leaves a duplicate out of it", async () => {
    // ADR-0037. The CLI's half of the window's rule: `--folder` resolves the
    // same path `folder:` does, and a file already in the library does not
    // join it — there is no dialog here to offer it one.
    await ok("folder", "create", "Design");
    await ok("folder", "create", "Icons", "--parent", "Design");
    const more = join(dir, "more");
    await mkdir(more, { recursive: true });
    await writeFile(join(more, "delta.png"), "roost test payload 3");

    // `--flat`, so the directory itself does not become a folder in between
    // (ADR-0058); the next test is that half.
    await ok("import", more, "--folder", "Design/Icons", "--flat");
    expect(await ok("query", "infolder:Design/Icons", "--count")).toEqual(["1"]);

    // The same file again: still one, and nothing new was filed.
    await ok("import", more, "--folder", "Design", "--flat");
    expect(await ok("query", "infolder:Design", "--count")).toEqual(["0"]);
  });

  it("brings a directory across as folders, unless told --flat (ADR-0058)", async () => {
    await ok("folder", "create", "Design");
    const trip = join(dir, "Trip");
    await mkdir(join(trip, "Bali"), { recursive: true });
    await writeFile(join(trip, "Bali", "beach.png"), "roost test payload 4");
    await writeFile(join(trip, "cover.png"), "roost test payload 5");

    const said = await ok("import", trip, "--folder", "Design");
    expect(said.join("\n")).toContain("2 folders made");
    expect(await ok("query", "infolder:Design/Trip", "--count")).toEqual(["1"]);
    expect(await ok("query", "infolder:Design/Trip/Bali", "--count")).toEqual(["1"]);

    const flat = join(dir, "Flat");
    await mkdir(join(flat, "Inner"), { recursive: true });
    await writeFile(join(flat, "Inner", "one.png"), "roost test payload 6");
    await ok("import", flat, "--folder", "Design", "--flat");
    expect(await ok("query", "infolder:Design", "--count")).toEqual(["1"]);
    expect((await ok("folder", "list")).join("\n")).not.toMatch(/Flat|Inner/);
  });

  it("refuses a folder that is not there, before it imports anything", async () => {
    const { streams, warn } = capture();
    const code = await run(["import", dir, "--folder", "Nowhere", "-L", root], streams);

    expect(code).not.toBe(EXIT.ok);
    expect(warn.join("\n")).toContain("Nowhere");
    expect(await ok("query", "", "--count")).toEqual([String(hashes.length)]);
  });

  it("deletes a folder without touching the assets, and with, when asked", async () => {
    await ok("folder", "create", "Keep");
    await ok("folder", "create", "Inner", "--parent", "Keep");
    await ok("folder", "add", "Keep/Inner", hashes[0] as string);

    // The default: the shelf goes, what was on it stays (ADR-0033).
    const kept = await ok("folder", "delete", "Keep");
    expect(kept.join("\n")).toContain("still in the library");
    expect(await ok("query", "", "--count")).toEqual([String(hashes.length)]);

    await ok("folder", "create", "Gone");
    await ok("folder", "add", "Gone", hashes[0] as string);
    const taken = await ok("folder", "delete", "Gone", "--trash-contents");
    expect(taken.join("\n")).toContain("moved 1 asset to the trash");
    expect(await ok("query", "", "--count")).toEqual([String(hashes.length - 1)]);
    // Trashed, not removed: it comes back.
    await ok("trash", "--restore", hashes[0] as string);
    expect(await ok("query", "", "--count")).toEqual([String(hashes.length)]);
  });

  it("rates, notes, renames, and shows the result", async () => {
    const prefix = (hashes[0] as string).slice(0, 10);
    await ok("rate", "4", prefix);
    await ok("note", prefix, "needs", "a", "crop");
    await ok("rename", prefix, "renamed.png");

    const shown = (await ok("show", prefix)).join("\n");
    expect(shown).toContain("renamed.png");
    expect(shown).toContain("needs a crop");
    // A library nothing has favourited says nothing about favourites, because
    // nothing can favourite any more (ADR-0029).
    expect(shown).not.toContain("favourite");
    expect(await ok("query", "rating:4", "--count")).toEqual(["1"]);

    await ok("rate", "none", prefix);
    await ok("note", prefix, "--clear");
    // Still in the grammar, and still answering: a smart folder that says
    // `is:favorite` must keep parsing (`DATA_MODEL.md` §3).
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

  it("removes the row, deletes the bytes, and says how many came back", async () => {
    const out = await ok("remove", hashes[0] as string);
    expect(out.join("\n")).toContain("Freed ");
    expect(out.join("\n")).toContain("from files/");
    expect(await ok("query", "", "--count")).toEqual(["2"]);
    // The object went with the row (ADR-0031), so `doctor` has nothing left to
    // reclaim — which is the observable difference from the old behaviour.
    expect((await ok("doctor")).join("\n")).not.toContain("Files nothing references");
  });

  it("moves assets into another library, and copies them without leaving (ADR-0054)", async () => {
    const other = join(dir, "other.roost");
    await run(["init", other], capture().streams);
    await ok("tag", "add", "--tag", "travels", hashes[0] as string);

    const moved = await ok("move", "--to", other, hashes[0] as string);
    expect(moved[0]).toMatch(/^Moved 1 asset/);
    expect(moved.join("\n")).toContain("1 asset removed from this library");
    expect(await ok("query", "", "--count")).toEqual(["2"]);

    const copied = await ok("copy", "--to", other, hashes[1] as string);
    expect(copied[0]).toMatch(/^Copied 1 asset/);
    expect(await ok("query", "", "--count")).toEqual(["2"]);

    const there = capture();
    expect(await run(["query", "tag:travels", "--count", "-L", other], there.streams)).toBe(
      EXIT.ok,
    );
    expect(there.out).toEqual(["1"]);
  });

  it("asks where a move is going before it moves anything", async () => {
    const { streams, warn } = capture();
    expect(await run(["move", hashes[0] as string, "-L", root], streams)).toBe(EXIT.usage);
    expect(warn.join("\n")).toContain("--to");
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
    await rm(join(root, "files", shard, `${hash}.png`));

    const damaged = capture();
    expect(await run(["doctor", "-L", root], damaged.streams)).toBe(EXIT.failed);
    expect(damaged.out.join("\n")).toContain("Assets whose file is gone: 1");

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
    const clip = (await ok("query", "ext:mp4", "--ids"))[0] as string;

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

  it("gives an asset a thumbnail of somebody's choosing, and its own back", async () => {
    // ADR-0060, and ADR-0005 once more: the window can, so this can.
    const asset = hashes[0] as string;
    const image = join(dir, "cover.png");
    await writeFile(image, await gradient(64, 48, 5, "png"));

    expect(await ok("thumbnail", asset)).toEqual([expect.stringContaining("its own thumbnail")]);
    expect(await ok("thumbnail", asset, image)).toEqual([
      expect.stringContaining("now has a custom thumbnail"),
    ]);
    expect(await ok("thumbnail", asset)).toEqual([expect.stringContaining("has a custom")]);

    // Not a picture: refused, by its code.
    const text = join(dir, "notes.txt");
    await writeFile(text, "words");
    const refused = capture();
    expect(await run(["thumbnail", asset, text, "-L", root], refused.streams)).not.toBe(EXIT.ok);
    expect(refused.warn.join("\n")).toContain("[not_a_picture]");

    expect((await ok("thumbnail", asset, "--clear"))[0]).toContain("roost thumb");
    expect((await ok("thumbnail", asset, "--clear"))[0]).toContain("already");
  });

  it("writes a file's bytes over an asset's own file", async () => {
    // ADR-0005 again: the window can save an edit, so this can too. What it
    // writes is the **same asset** (ADR-0046, superseding ADR-0026): version 1
    // made a second one and marked the first superseded, because identity was
    // the hash of the bytes and a save could not be a write.
    const replacement = join(dir, "replacement.png");
    await writeFile(replacement, "roost test payload edited");
    const first = hashes[0] as string;

    const saved = await ok("save", first, replacement);
    expect(saved[0]).toContain("now holds those bytes");
    expect(saved[0]).toContain("roost thumb");

    // Three assets before and three after, with the same ids: nothing entered
    // the library and nothing left it.
    expect(await ok("query", "", "--ids")).toHaveLength(3);
    expect(await ok("query", "", "--ids")).toContain(first);
  });

  it("says which subtitle captions which video, and un-says it", async () => {
    // ADR-0005: the attachment is user-authored state, so it must be writable
    // without a window — and the rebuild test needs a way to author one.
    const media = join(dir, "films");
    await mkdir(media, { recursive: true });
    await writeFile(join(media, "film.mkv"), "not really a film");
    await writeFile(join(media, "notes.srt"), "1\n00:00:01,000 --> 00:00:02,000\nHello.\n");
    await ok("import", media);

    const film = (await ok("query", "ext:mkv", "--ids"))[0] as string;
    const track = (await ok("query", "ext:srt", "--ids"))[0] as string;
    expect(track).toBeDefined();

    expect((await ok("subtitle", film))[0]).toContain("no subtitles");

    expect((await ok("subtitle", film, track, "--lang", "id"))[0]).toContain("captions");
    expect((await ok("subtitle", film))[0]).toContain("[id]");

    // An attached track leaves every view but its own (ADR-0025 §4).
    expect(await ok("query", "ext:srt", "--ids")).toEqual([]);
    expect(await ok("query", "is:subtitle", "--ids")).toEqual([track]);
    expect(await ok("query", "is:captioned", "--ids")).toEqual([film]);

    // Detaching deletes nothing: the track becomes an ordinary text asset.
    expect((await ok("subtitle", film, track, "--detach"))[0]).toContain("no longer captions");
    expect(await ok("query", "ext:srt", "--ids")).toEqual([track]);
  });

  it("attaches a subtitle sitting beside its film, without being asked", async () => {
    // Eagle's convention, kept as a heuristic: adjacency proposes it and the
    // journal line is what makes it true (ADR-0025 §3).
    const media = join(dir, "beside");
    await mkdir(media, { recursive: true });
    await writeFile(join(media, "holiday.mp4"), "not really a film either");
    await writeFile(join(media, "holiday.id.srt"), "1\n00:00:01,000 --> 00:00:02,000\nHalo.\n");
    await ok("import", media);

    const film = (await ok("query", "ext:mp4", "--ids"))[0] as string;
    const listed = await ok("subtitle", film);
    expect(listed[0]).toContain("[id]");
    // The language came from the filename's suffix, not from a guess.
    expect(await ok("query", "is:subtitle", "--ids")).toHaveLength(1);
  });

  it("imports and attaches in one step, which is what the CC menu sends", async () => {
    // Apart, an import and an attach leave a state between them: a track
    // imported and attached to nothing (ADR-0025).
    const media = join(dir, "one-step");
    await mkdir(media, { recursive: true });
    await writeFile(join(media, "movie.mp4"), "not really a film");
    await ok("import", join(media, "movie.mp4"));
    const film = (await ok("query", "ext:mp4", "--ids"))[0] as string;

    const loose = join(dir, "elsewhere.id.srt");
    await writeFile(loose, "1\n00:00:01,000 --> 00:00:02,000\nHalo.\n");

    const library = await Library.open(root, { exclusive: true });
    try {
      const added = await addSubtitles(library, parseAssetId(film), [loose, join(dir, "a.png")]);
      expect(added.attached).toBe(1);
      // What it declined comes back rather than disappearing: a drop onto an
      // open video is offered here first, and the rest has to reach the import
      // it was always going to (ADR-0025).
      expect(added.ignored).toEqual([join(dir, "a.png")]);
      // Copied into the library, which is the only place an asset's bytes can
      // be (RL-19): a track left in a downloads folder disappears when that
      // folder is tidied.
      const [track] = subtitles(library, parseAssetId(film));
      expect(track?.lang).toBe("id");
      expect(library.db.repo.findAsset(track?.trackId as never)?.ext).toBe("srt");
    } finally {
      await library.close();
    }
  });

  it("refuses to save over an asset in the trash", async () => {
    // Version 1 refused a `referenced` asset here, because its bytes were the
    // user's own file in the user's own directory. There is one storage mode
    // now (RL-19), so what is left to refuse is the gesture that has no meaning
    // until the asset is restored.
    const trashed = hashes[0] as string;
    await ok("trash", trashed);

    const { streams, warn } = capture();
    const replacement = join(dir, "ours.txt");
    await writeFile(replacement, "ours now");
    expect(await run(["save", trashed, replacement, "-L", root], streams)).toBe(EXIT.failed);
    expect(warn.join("\n")).toContain("[not_editable]");

    await ok("trash", "--restore", trashed);
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
