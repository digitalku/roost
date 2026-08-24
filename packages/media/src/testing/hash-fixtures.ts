/**
 * Deterministic fixture files for the content-hashing conformance test.
 *
 * The files are generated rather than committed: two of them are over 50 MB,
 * which is the whole point — the specification hashes those differently, and
 * the partial scheme carries a byte-order and integer-width decision that
 * JavaScript will happily get self-consistently wrong
 * (`docs/STORAGE_SPEC.md` §TypeScript implementation notes).
 *
 * The generator is committed so that anyone — including the Rust
 * implementation at `../roost-old`, which produced the expected digests — can
 * recreate byte-identical inputs. `scripts/make-hash-fixtures.mjs` writes them
 * to a directory for exactly that purpose.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A linear congruential generator, the "numerical recipes" constants.
 *
 * `Math.imul` is not a micro-optimisation: it takes the low 32 bits of the
 * product, which is the modulo this is defined with. Plain `*` would lose
 * precision above 2^53 and could produce a different stream on a different
 * engine — the one thing a fixture generator may not do.
 */
export function deterministicBytes(seed: number, length: number): Buffer {
  const out = Buffer.allocUnsafe(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    // The high byte, because an LCG's low bits have short periods.
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

export interface HashFixture {
  readonly name: string;
  readonly bytes: () => Buffer;
  readonly size: number;
  readonly isPartial: boolean;
}

const MIB = 1024 * 1024;

function generated(name: string, seed: number, size: number): HashFixture {
  return { name, size, isPartial: size > 50 * MIB, bytes: () => deterministicBytes(seed, size) };
}

function literal(name: string, text: string): HashFixture {
  const bytes = Buffer.from(text, "utf8");
  return { name, size: bytes.length, isPartial: false, bytes: () => bytes };
}

/**
 * `FULL_HASH_MAX_BYTES` is 50 MiB and the test is `size > limit`, so 52428800
 * bytes is hashed in full and 52428801 is not. Both boundaries are fixtures,
 * because an off-by-one there splits one asset into two.
 */
export const HASH_FIXTURES: readonly HashFixture[] = [
  literal("empty.bin", ""),
  literal("abc.bin", "abc"),
  generated("small-1mib.bin", 1, MIB),
  generated("boundary-50mib.bin", 2, 50 * MIB),
  generated("boundary-50mib-plus-1.bin", 3, 50 * MIB + 1),
  generated("large-64mib.bin", 4, 64 * MIB),
];

/**
 * Writes the fixtures into `dir`, skipping any already present at the right
 * size. Regenerating 165 MB on every test run would be its own kind of wrong.
 */
export async function writeHashFixtures(dir: string): Promise<Map<string, string>> {
  await mkdir(dir, { recursive: true });
  const paths = new Map<string, string>();
  for (const fixture of HASH_FIXTURES) {
    const path = join(dir, fixture.name);
    const existing = await stat(path).catch(() => null);
    if (!existing || existing.size !== fixture.size) {
      await writeFile(path, fixture.bytes());
    }
    paths.set(fixture.name, path);
  }
  return paths;
}
