import { availableParallelism } from "node:os";
import { type ContentHash, logger, parseContentHash, type ThumbnailTarget } from "@roost/core";
import { EAGER_SIZES, generateThumbnails } from "@roost/media";
import { mapWithConcurrency } from "./concurrency.js";
import type { Library } from "./library.js";

/**
 * Deriving thumbnails for assets that have none.
 *
 * Deliberately **not** part of import. Decoding and resizing costs orders of
 * magnitude more than hashing and placing; folding it into import would make
 * the two indistinguishable in a profile and impossible to resume separately.
 * Import stays fast, and thumbnails fill in afterwards — repeatedly, at any
 * time, without re-importing anything.
 *
 * Thumbnails are derived data: a rebuild discards them and running this
 * restores them from `originals/`.
 */

const log = logger("thumbnails");

/**
 * Assets written per transaction.
 *
 * Bounds peak memory: a chunk holds every generated BLOB until it is written,
 * and a WebP is tens of kilobytes.
 */
const CHUNK_SIZE = 128;

/**
 * How many assets are decoded at once.
 *
 * `sharp`'s asynchronous API runs on libuv's threadpool, and the default pool
 * of four is a silent ceiling: measured at 113 thumbnails/sec sequentially
 * against 623/sec across the cores. `UV_THREADPOOL_SIZE` has to be raised
 * before the pool is first used, which is a binary's job, not a library's —
 * `docs/SETUP.md` says where.
 */
function decodeConcurrency(): number {
  return Math.max(2, Math.min(16, availableParallelism()));
}

export interface ThumbnailReport {
  generated: number;
  /** Assets whose format has no backend in this build. Expected, not a fault. */
  unsupported: number;
  /** Referenced assets whose file has moved or been deleted. */
  missing: number;
  bytes: number;
  elapsed: number;
  readonly failed: { path: string; reason: string }[];
}

/** Generates missing thumbnails at every size in `sizes`. */
export async function generateMissing(
  library: Library,
  sizes: readonly number[] = EAGER_SIZES,
  limit = Number.MAX_SAFE_INTEGER,
  onProgress?: (report: ThumbnailReport) => void,
): Promise<ThumbnailReport> {
  const started = performance.now();
  const report: ThumbnailReport = {
    generated: 0,
    unsupported: 0,
    missing: 0,
    bytes: 0,
    elapsed: 0,
    failed: [],
  };

  const targets = library.db.repo.assetsMissingThumbnails(sizes, limit);
  const concurrency = decodeConcurrency();

  for (let start = 0; start < targets.length; start += CHUNK_SIZE) {
    const chunk = targets.slice(start, start + CHUNK_SIZE);
    const rendered = await mapWithConcurrency(chunk, concurrency, async (target) => {
      const path = locate(library, target);
      if (path === undefined) return { target, kind: "missing" as const };
      try {
        const thumbs = await generateThumbnails(path, sizes);
        return thumbs.length === 0
          ? { target, kind: "unsupported" as const }
          : { target, kind: "ok" as const, thumbs };
      } catch (error) {
        return {
          target,
          kind: "failed" as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    });

    // One transaction per chunk, so a long run commits progress as it goes and
    // an interruption costs at most a chunk.
    library.db.transaction(() => {
      for (const result of rendered) {
        if (result.kind !== "ok") continue;
        const hash = parseContentHash(result.target.hash);
        for (const thumb of result.thumbs) {
          library.db.repo.putThumbnail(hash, thumb.size, thumb.width, thumb.height, thumb.data);
          report.bytes += thumb.data.length;
        }
        report.generated += 1;
      }
    });

    for (const result of rendered) {
      if (result.kind === "missing") report.missing += 1;
      else if (result.kind === "unsupported") report.unsupported += 1;
      else if (result.kind === "failed") {
        report.failed.push({ path: result.target.hash, reason: result.reason });
      }
    }

    onProgress?.(report);
  }

  report.elapsed = performance.now() - started;
  log.info("thumbnails complete", {
    generated: report.generated,
    unsupported: report.unsupported,
    missing: report.missing,
    failed: report.failed.length,
    ms: Math.round(report.elapsed),
  });
  return report;
}

/**
 * Where an asset's bytes are.
 *
 * A referenced asset's path is user-chosen and recorded in the index; a managed
 * one's is derived from its hash by the store, which is the only thing allowed
 * to do that (invariant 2).
 */
function locate(library: Library, target: ThumbnailTarget): string | undefined {
  if (target.storageMode === "referenced") return target.refPath ?? undefined;
  const hash: ContentHash = parseContentHash(target.hash);
  return library.storageFor("managed").locate(hash, target.ext);
}
