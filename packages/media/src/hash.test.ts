import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FULL_HASH_MAX_BYTES, hashFile, PARTIAL_WINDOW_BYTES } from "./hash.js";
import { deterministicBytes, HASH_FIXTURES, writeHashFixtures } from "./testing/hash-fixtures.js";

/**
 * Digests produced by the **Rust implementation** at `../roost-old`, by writing
 * these exact fixtures with `scripts/make-hash-fixtures.mjs` and importing them
 * into a library.
 *
 * They are not this code's output recorded as a snapshot — that would assert
 * only that the implementation is stable, not that it is right. The partial
 * scheme has a byte-order and integer-width decision inside it, and JavaScript
 * can produce a different, self-consistent, wrong answer that no round trip
 * through one implementation would ever reveal.
 *
 * The first two double as a check on the whole chain: they are the published
 * BLAKE3 vectors for "" and "abc".
 */
const EXPECTED: Record<string, string> = {
  "empty.bin": "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
  "abc.bin": "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85",
  "small-1mib.bin": "579e2d99a750ba0b5ee3870a50bdd4ed98671cf57f92d8fdc8101fcd5783098b",
  "boundary-50mib.bin": "dbb8cd8d1a997bea0136e3a6a9419d96bc9ae51cee7a2d5635997b85d902d151",
  "boundary-50mib-plus-1.bin": "406289f023a1755d580aec2d898af8a4faed1993d7650a45e553971fe5e75725",
  "large-64mib.bin": "8544f94b306efafba05d10ab5bbed62902b9a596e76f3877d4d612ca2f2cbb98",
};

describe("hashFile, against the Rust implementation", () => {
  let paths: Map<string, string>;

  beforeAll(async () => {
    paths = await writeHashFixtures(join(tmpdir(), "roost-hash-fixtures"));
  }, 180_000);

  for (const fixture of HASH_FIXTURES) {
    it(`agrees on ${fixture.name}`, async () => {
      const path = paths.get(fixture.name);
      expect(path).toBeDefined();
      const hashed = await hashFile(path as string);

      expect(hashed.hash).toBe(EXPECTED[fixture.name]);
      expect(hashed.size).toBe(fixture.size);
      expect(hashed.isPartial).toBe(fixture.isPartial);
    }, 60_000);
  }
});

describe("the partial-hash boundary", () => {
  it("is `greater than`, so exactly 50 MiB is still hashed in full", () => {
    // Asserted through the fixtures rather than through the constant, because
    // an off-by-one here splits one asset into two and the constant alone
    // would happily agree with either reading.
    const exact = HASH_FIXTURES.find((f) => f.name === "boundary-50mib.bin");
    const plusOne = HASH_FIXTURES.find((f) => f.name === "boundary-50mib-plus-1.bin");

    expect(exact?.size).toBe(FULL_HASH_MAX_BYTES);
    expect(exact?.isPartial).toBe(false);
    expect(plusOne?.size).toBe(FULL_HASH_MAX_BYTES + 1);
    expect(plusOne?.isPartial).toBe(true);
  });
});

describe("hashFile, on files it must not confuse", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-hash-"));
  });

  it("distinguishes two large files that share both windows but not their size", async () => {
    // This is what the size prefix is for. Without it, a file and a truncation
    // of itself that happens to end the same way would be one asset.
    const window = Buffer.alloc(PARTIAL_WINDOW_BYTES, 0xab);
    const middle = FULL_HASH_MAX_BYTES;
    const a = join(dir, "a.bin");
    const b = join(dir, "b.bin");
    await writeFile(a, Buffer.concat([window, Buffer.alloc(middle, 0), window]));
    await writeFile(b, Buffer.concat([window, Buffer.alloc(middle + 1, 0), window]));

    const [ha, hb] = [await hashFile(a), await hashFile(b)];
    expect(ha.isPartial).toBe(true);
    expect(hb.isPartial).toBe(true);
    expect(ha.hash).not.toBe(hb.hash);
  }, 60_000);

  it("gives the same answer twice, which is the whole basis of dedupe", async () => {
    const path = join(dir, "repeat.bin");
    await writeFile(path, deterministicBytes(9, 3 * 1024 * 1024));
    expect((await hashFile(path)).hash).toBe((await hashFile(path)).hash);
  });

  it("reads past a short read rather than hashing a stale buffer tail", async () => {
    // A file whose size is not a multiple of the read buffer exercises the
    // final partial chunk, which is where a `read` returning fewer bytes than
    // asked for would otherwise poison the digest with leftover memory.
    const odd = join(dir, "odd.bin");
    await writeFile(odd, deterministicBytes(11, 256 * 1024 + 7));
    const first = await hashFile(odd);
    await writeFile(odd, deterministicBytes(11, 256 * 1024 + 7));
    expect((await hashFile(odd)).hash).toBe(first.hash);
  });
});
