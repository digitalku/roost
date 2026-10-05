import { access } from "node:fs/promises";
import { parseAssetId } from "@roost/core";
import { derive, EAGER_SIZES, GRID_SIZE, PREVIEW_SIZE, THUMBNAIL_SIZES } from "@roost/media";
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
 * Thumbnails are derived data, kept outside the index (ADR-0051): a rebuild
 * leaves them in place, and running this draws only what is missing or stale.
 */

export interface ThumbnailReport {
  generated: number;
  /**
   * Assets whose pictures were already there and still show the file, so they
   * were measured and not drawn (ADR-0051 §5). After a rebuild, most of them.
   */
  kept: number;
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
    generated: report.derived - report.kept,
    kept: report.kept,
    unsupported: report.blocked,
    missing: report.missing,
    bytes: report.bytes,
    elapsed: report.elapsed,
    failed: report.failures.map((failure) => ({ path: failure.id, reason: failure.reason })),
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
/**
 * Redraws both thumbnails from the frame the asset is now pinned to
 * (ADR-0024 stage 4).
 *
 * Immediately rather than through the queue, and this is the one derive that
 * earns it: the moment is journalled, the address of the thumbnail changes with
 * it, and a person who just chose a frame is looking at the cell. A quarter of
 * a second here is the difference between "the picture changed" and a
 * placeholder that fills in whenever the queue gets round to it.
 *
 * Best effort. Without ffmpeg, or with a file that has gone missing (RL-25),
 * this answers `false` and the caller leaves the job queued — the queue reads
 * the same `poster_ms`, so nothing is lost but time.
 */
export async function redrawPoster(library: Library, id: string): Promise<boolean> {
  const asset = parseAssetId(id);
  // A frame is a choice about the file's own picture, and the picture on
  // screen is somebody else's: the moment is journalled, and shows when that
  // one is removed (ADR-0060). Answered as done, so nothing queues a redraw.
  if (library.db.repo.pictureSource(asset)?.chosen === true) return true;
  const target = library.db.repo.thumbnailTarget(asset);
  if (target === undefined) return false;
  const path = library.storage.locate(asset, target.ext);

  try {
    await access(path);
    // Both sizes together, from one decode: a preview that disagrees with its
    // own grid cell is worse than either.
    const outcome = await derive(path, THUMBNAIL_SIZES, target.posterMs ?? undefined);
    if (!outcome.ok) return false;
    library.db.transaction(() => {
      // Checked again where it is written: the decode above took long enough
      // for somebody to choose a picture in the meantime.
      if (library.db.repo.pictureSource(asset)?.chosen === true) return;
      for (const thumbnail of outcome.thumbnails) {
        library.db.repo.putThumbnail(
          asset,
          thumbnail.size,
          thumbnail.width,
          thumbnail.height,
          thumbnail.data,
        );
      }
      // The same file, a different frame: the source stands apart from which
      // moment it shows, or the next derive would draw this all over again
      // (ADR-0051 §5).
      library.db.repo.setPictureSourcePoster(asset, target.posterMs);
    });
    return outcome.thumbnails.length > 0;
  } catch {
    return false;
  }
}

export async function ensurePreview(library: Library, id: string): Promise<boolean> {
  const asset = parseAssetId(id);
  if (library.db.repo.thumbnail(asset, PREVIEW_SIZE) !== undefined) return true;
  if (library.db.repo.thumbnail(asset, GRID_SIZE) === undefined) return false;
  // Chosen pictures come at every size or not at all, and the file is not what
  // they show, so a missing one is not drawn from it (ADR-0060).
  if (library.db.repo.pictureSource(asset)?.chosen === true) return false;

  const target = library.db.repo.thumbnailTarget(asset);
  if (target === undefined) return false;
  const path = library.storage.locate(asset, target.ext);

  try {
    await access(path);
    // The same pinned frame the grid thumbnail was drawn from, or the preview
    // would disagree with its own cell.
    const outcome = await derive(path, [PREVIEW_SIZE], target.posterMs ?? undefined);
    if (!outcome.ok) return false;
    library.db.transaction(() => {
      if (library.db.repo.pictureSource(asset)?.chosen === true) return;
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
    // A file that has gone missing, or a backend that failed on one it drew
    // once — which version 2 makes ordinary rather than surprising, because the
    // bytes may have been edited since (RL-20). Either way the inspector falls
    // back to the grid size, which is a softer picture rather than a broken one.
    return false;
  }
}
