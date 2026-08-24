import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IoError } from "@roost/core";
import { gradient, syntheticFormatForExtension } from "@roost/media";

/**
 * Synthetic library fixtures for benchmarking.
 *
 * Performance targets are requirements, not aspirations, so they need a
 * reproducible corpus to measure against. Real photo libraries cannot serve:
 * they are not shareable, not deterministic, and not available in CI.
 *
 * **The bytes match the Rust implementation's**, given the same seed, count,
 * and size. That is what makes a measurement here comparable to one recorded in
 * `../roost-old`'s own `BENCHMARKS.md` rather than merely similar, and it is
 * tested against files that build actually wrote.
 */

/** Extensions cycled through, roughly reflecting a reference library's mix. */
const EXTENSIONS = ["jpg", "jpg", "jpg", "png", "png", "webp", "mp4", "pdf", "svg"] as const;

/**
 * Files per directory. Keeps any one directory small enough that listing it
 * stays fast, the way a real import source usually looks.
 */
const FILES_PER_DIR = 250;

export interface FixtureOptions {
  readonly count?: number;
  /** Approximate bytes per file. */
  readonly size?: number;
  /** Fraction of files that duplicate an earlier one, to exercise dedupe. */
  readonly duplicateRatio?: number;
  readonly seed?: number;
  /**
   * Encode real images for image extensions instead of writing random bytes.
   *
   * Off by default, matching the Rust implementation, because random bytes are
   * an order of magnitude faster to write and are all that hashing, placing,
   * and indexing need. They cannot be decoded, though — so a corpus generated
   * without this has **no thumbnails at all**, which reads as a broken pipeline
   * and is only ever the fixture.
   */
  readonly realImages?: boolean;
  readonly imageWidth?: number;
  readonly imageHeight?: number;
}

export interface FixtureReport {
  files: number;
  duplicates: number;
  bytes: number;
  directories: number;
}

/** Writes `count` files under `root`. */
export async function generateFixture(
  root: string,
  options: FixtureOptions = {},
): Promise<FixtureReport> {
  const count = options.count ?? 1000;
  const size = options.size ?? 4096;
  const seed = options.seed ?? 0;
  const realImages = options.realImages ?? false;
  const width = options.imageWidth ?? 1200;
  const height = options.imageHeight ?? 800;
  const interval = duplicateInterval(options.duplicateRatio ?? 0.05);

  try {
    await mkdir(root, { recursive: true });
  } catch (cause) {
    throw new IoError("mkdir", root, cause);
  }

  const report: FixtureReport = { files: 0, duplicates: 0, bytes: 0, directories: 0 };
  const buffer = Buffer.allocUnsafe(size);
  let currentDir = root;

  for (let index = 0; index < count; index += 1) {
    if (index % FILES_PER_DIR === 0) {
      currentDir = join(
        root,
        `batch-${String(Math.floor(index / FILES_PER_DIR)).padStart(4, "0")}`,
      );
      try {
        await mkdir(currentDir, { recursive: true });
      } catch (cause) {
        throw new IoError("mkdir", currentDir, cause);
      }
      report.directories += 1;
    }

    // A duplicate reuses an earlier file's content verbatim, so the importer
    // sees genuinely identical bytes rather than a near-match.
    const isDuplicate = interval !== undefined && index > 0 && index % interval === 0;
    const contentIndex = isDuplicate ? index - 1 : index;

    const ext = EXTENSIONS[index % EXTENSIONS.length] ?? "jpg";
    const path = join(currentDir, `asset-${String(index).padStart(7, "0")}.${ext}`);

    let bytes: Buffer;
    const format = realImages ? syntheticFormatForExtension(ext) : undefined;
    if (format !== undefined) {
      bytes = await gradient(width, height, seed + contentIndex, format);
    } else {
      fill(buffer, seed, contentIndex);
      bytes = buffer;
    }

    try {
      await writeFile(path, bytes);
    } catch (cause) {
      throw new IoError("write", path, cause);
    }

    report.files += 1;
    report.bytes += bytes.length;
    if (isDuplicate) report.duplicates += 1;
  }

  return report;
}

function duplicateInterval(ratio: number): number | undefined {
  if (ratio <= 0) return undefined;
  const interval = Math.round(1 / ratio);
  return interval >= 2 ? interval : undefined;
}

/**
 * Fills `buffer` with bytes determined entirely by `(seed, index)`.
 *
 * A 64-bit xorshift, matching the Rust implementation exactly — cheap, because
 * generating 100k files must not be dominated by the generator.
 *
 * The state is a pair of 32-bit halves rather than a `bigint`. Correctness is
 * the same either way; speed is not. A 24 KiB file needs three thousand rounds,
 * and at twenty thousand files that is sixty million of them, which is the
 * difference between a fixture that takes a second and one that takes a minute.
 */
function fill(buffer: Buffer, seed: number, index: number): void {
  // Once per file, so `bigint` is affordable here and keeps the wrapping
  // multiply readable.
  const start = (BigInt(seed) * 0x9e3779b97f4a7c15n + BigInt(index) + 1n) & 0xffffffffffffffffn;
  let hi = Number((start >> 32n) & 0xffffffffn) >>> 0;
  let lo = Number(start & 0xffffffffn) >>> 0;

  for (let at = 0; at < buffer.length; at += 8) {
    // x ^= x << 13
    let sh = (((hi << 13) | (lo >>> 19)) >>> 0) >>> 0;
    let sl = (lo << 13) >>> 0;
    hi = (hi ^ sh) >>> 0;
    lo = (lo ^ sl) >>> 0;

    // x ^= x >> 7, logical
    sh = hi >>> 7;
    sl = (((lo >>> 7) | (hi << 25)) >>> 0) >>> 0;
    hi = (hi ^ sh) >>> 0;
    lo = (lo ^ sl) >>> 0;

    // x ^= x << 17
    sh = (((hi << 17) | (lo >>> 15)) >>> 0) >>> 0;
    sl = (lo << 17) >>> 0;
    hi = (hi ^ sh) >>> 0;
    lo = (lo ^ sl) >>> 0;

    // Little-endian: the low half first, exactly as `u64::to_le_bytes` writes
    // it. A short final chunk takes only as many bytes as it has room for.
    const remaining = Math.min(8, buffer.length - at);
    for (let byte = 0; byte < remaining; byte += 1) {
      const half = byte < 4 ? lo : hi;
      buffer[at + byte] = (half >>> ((byte % 4) * 8)) & 0xff;
    }
  }
}
