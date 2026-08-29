import { EAGER_SIZES } from "@roost/media";
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
