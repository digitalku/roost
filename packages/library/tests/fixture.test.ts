import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixture } from "@roost/library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("the synthetic corpus", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-fixture-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the same bytes the Rust implementation writes", async () => {
    // Captured from `roost fixture --count 4 --size 40 --duplicate-ratio 0
    // --seed 7` run by `../roost-old`. Matching them is what makes a
    // measurement here comparable to one recorded there rather than merely
    // similar — the 20,000-file import benchmark in `BENCHMARKS.md` compares
    // the two builds on one corpus, and this is why that is meaningful.
    const expected: [string, string][] = [
      [
        "asset-0000000.jpg",
        "5dd38e172c753ff6bbb90805cf2ecf9c08a60b82c57f01be4433af9955c2ede8223c7cc7f241032f",
      ],
      [
        "asset-0000001.jpg",
        "1cf30c572c753ff6faad0909c96fcf8c21808deceafb1f2561b3f2cc5637b91d47ae2557425e0fa9",
      ],
      [
        "asset-0000002.jpg",
        "df938a962c753ff63891081dc3accfbc1ace05579ff63c880603171771e04c92802c998924e67380",
      ],
      [
        "asset-0000003.png",
        "9eb308d62c753ff679850911c5edcfac33e88339b072221323834a4272151867e5bec01994f97f06",
      ],
    ];

    // `realImages: false` is the mode the two builds share: real images encode
    // through different libraries and WebP is not byte-identical between them.
    const report = await generateFixture(dir, {
      count: 4,
      size: 40,
      duplicateRatio: 0,
      seed: 7,
      realImages: false,
    });

    expect(report).toEqual({ files: 4, duplicates: 0, bytes: 160, directories: 1 });

    for (const [name, hex] of expected) {
      const bytes = await readFile(join(dir, "batch-0000", name));
      expect(bytes.toString("hex")).toBe(hex);
    }
  });

  it("repeats a file's content at the duplicate interval, exactly", async () => {
    // The duplicate has to be byte-identical to the file before it, or the
    // importer sees a near-match and deduplication is not what is measured.
    await generateFixture(dir, {
      count: 6,
      size: 32,
      duplicateRatio: 0.5,
      seed: 1,
      realImages: false,
    });
    const names = (await readdir(join(dir, "batch-0000"))).sort();

    const read = async (n: number): Promise<string> =>
      (await readFile(join(dir, "batch-0000", names[n] ?? ""))).toString("hex");

    // Every second file duplicates the one before it.
    expect(await read(2)).toBe(await read(1));
    expect(await read(4)).toBe(await read(3));
    expect(await read(1)).not.toBe(await read(3));
  });

  it("is deterministic across runs and different across seeds", async () => {
    const other = await mkdtemp(join(tmpdir(), "roost-fixture-"));
    try {
      const options = { count: 3, size: 64, duplicateRatio: 0, realImages: false } as const;
      await generateFixture(dir, { ...options, seed: 42 });
      await generateFixture(other, { ...options, seed: 42 });

      const one = await readFile(join(dir, "batch-0000", "asset-0000000.jpg"));
      const two = await readFile(join(other, "batch-0000", "asset-0000000.jpg"));
      expect(one.equals(two)).toBe(true);

      await rm(other, { recursive: true, force: true });
      await generateFixture(other, { ...options, seed: 43 });
      const three = await readFile(join(other, "batch-0000", "asset-0000000.jpg"));
      expect(one.equals(three)).toBe(false);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("writes decodable images when asked, which is what thumbnails need", async () => {
    // Random bytes cannot be decoded. A fixture whose `.webp` files were random
    // made a ninth of every synthetic library permanently unthumbnailable in
    // the Rust build, and it looked like a pipeline failure.
    await generateFixture(dir, {
      count: 6,
      duplicateRatio: 0,
      seed: 1,
      realImages: true,
      imageWidth: 48,
      imageHeight: 32,
    });

    const { sniff } = await import("@roost/media");
    const names = (await readdir(join(dir, "batch-0000"))).sort();
    const formats = [];
    for (const name of names) {
      formats.push(sniff(await readFile(join(dir, "batch-0000", name))));
    }
    // jpg, jpg, jpg, png, png, webp — the extension cycle's first six.
    expect(formats).toEqual(["jpeg", "jpeg", "jpeg", "png", "png", "webp"]);
  });
});
