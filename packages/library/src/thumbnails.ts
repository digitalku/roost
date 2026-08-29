import { access } from "node:fs/promises";
import { parseContentHash } from "@roost/core";
import { derive, EAGER_SIZES, GRID_SIZE, PREVIEW_SIZE } from "@roost/media";
import { type DeriveReport, enqueueMissing, runDerives } from "./jobs.js";
import type { Library } from "./library.js";

/**
 * The backfill pass: derive whatever is still missing, then report it in the
 * words `roost thumb` has always used.
 *
 * Since M4 this is a **view of the queue** rather than a second pipeline
 * (`jobs.ts`). The command still means the same thing — "fill in what has no
 * thumbnail" — but the work is now claimable, resumable, and shared with the
 * app's background runner, and it covers every format a backend exists for
 * rather than only the ones `sharp` decodes.
 *
 * Thumbnails are derived data: a rebuild discards them and running this
 * restores them from `originals/`.
 */

export interface ThumbnailReport {
  generated: number;
  /**
   * Assets nothing on this machine can draw: a format with no backend, or a
   * backend that is not installed. Expected, not a fault.
   */
  unsupported: number;
  /** Referenced assets whose file has moved or been deleted. */
  missing: number;
  bytes: number;
  elapsed: number;
  readonly failed: { path: string; reason: string }[];
}

/**
 * Generates whatever is missing at every size in `sizes`.
 *
 * Queues first, then works the queue: the sweep leaves parked work alone, so
 * running this twice over a library full of formats this build cannot draw
 * converges instead of retrying them forever.
 */
export async function generateMissing(
  library: Library,
  sizes: readonly number[] = EAGER_SIZES,
  limit = Number.MAX_SAFE_INTEGER,
  onProgress?: (report: ThumbnailReport) => void,
): Promise<ThumbnailReport> {
  enqueueMissing(library, sizes, undefined, limit);

  const derived = await runDerives(library, {
    sizes,
    limit,
    ...(onProgress === undefined
      ? {}
      : { onProgress: (running: DeriveReport) => onProgress(asThumbnailReport(running)) }),
  });

  return asThumbnailReport(derived);
}

function asThumbnailReport(report: DeriveReport): ThumbnailReport {
  return {
    generated: report.derived,
    unsupported: report.blocked,
    missing: report.missing,
    bytes: report.bytes,
    elapsed: report.elapsed,
    failed: report.failures.map((failure) => ({ path: failure.hash, reason: failure.reason })),
  };
}

/**
 * Makes the preview-size thumbnail for one asset, if it is missing.
 *
 * The 512px size is generated **on first use**, not with the grid size: the
 * Rust build measured it at 72% of all thumbnail bytes, for an image only ever
 * needed for the asset somebody is looking at — roughly 34 GB at a million
 * assets (`serving.ts`). "On first use" was the plan from M1 and nothing
 * implemented it, so the inspector asked for a size no library had and drew a
 * broken image. Seen in a window, not in a test.
 *
 * Only for an asset that already has its grid thumbnail: that is the cheap
 * proof something in this build can draw it, and it stops a selection from
 * re-deriving a format that is parked, on every click.
 *
 * Returns whether the preview exists now.
 */
export async function ensurePreview(library: Library, hash: string): Promise<boolean> {
  const asset = parseContentHash(hash);
  if (library.db.repo.thumbnail(asset, PREVIEW_SIZE) !== undefined) return true;
  if (library.db.repo.thumbnail(asset, GRID_SIZE) === undefined) return false;

  const target = library.db.repo.thumbnailTarget(asset);
  if (target === undefined) return false;
  const path =
    target.storageMode === "referenced"
      ? target.refPath
      : library.storageFor("managed").locate(asset, target.ext);
  if (path === null) return false;

  try {
    await access(path);
    const outcome = await derive(path, [PREVIEW_SIZE]);
    if (!outcome.ok) return false;
    library.db.transaction(() => {
      for (const thumbnail of outcome.thumbnails) {
        library.db.repo.putThumbnail(
          asset,
          thumbnail.size,
          thumbnail.width,
          thumbnail.height,
          thumbnail.data,
        );
      }
    });
    return outcome.thumbnails.length > 0;
  } catch {
    // A referenced original that moved, or a backend that failed on a file it
    // drew once. Either way the inspector falls back to the grid size, which is
    // a softer picture rather than a broken one.
    return false;
  }
}
