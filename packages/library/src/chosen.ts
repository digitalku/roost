import { type AssetId, JOB_PRIORITY } from "@roost/core";
import { derive, THUMBNAIL_SIZES } from "@roost/media";
import { NotAPictureError, UnknownAssetError } from "./error.js";
import { enqueueDerives, type Redrawn } from "./jobs.js";
import { type Library, nowUnix } from "./library.js";

/**
 * Thumbnails somebody chose (ADR-0060).
 *
 * An image offered for an asset is drawn to the same pictures every asset has
 * and stored in place of the file's own, marked so that nothing draws over
 * them. **That is the only place they are kept**: there is no journal line and
 * no copy of the image, by the user's choice, so they are lost with `thumbs/`.
 * Everything measured about the file stays the file's (RL-22).
 */

/**
 * Why a derive stalled that a chosen picture does not answer.
 *
 * The file is gone, or there are two of it (RL-12, RL-25): a problem with the
 * file rather than with its picture, which a person still needs telling about.
 */
const FILE_PROBLEMS = ["missing:file", "ambiguous:file"] as const;

/**
 * Draws the image at `path` as the thumbnail of every asset in `ids`.
 *
 * Drawn once and stored for each, so a selection of forty costs one decode.
 * Anything this build can draw is accepted, as the queue would draw it: the
 * window's dialog offers images, and the clipboard may hold a file of any
 * kind. The image is only read, wherever it is (invariant 6).
 *
 * Answers what changed, for the windows that hold those cards: the derive time
 * moves, because a thumbnail's address carries it and an `<img>` whose address
 * did not move is one Chromium never asks about again (ADR-0047).
 */
export async function chooseThumbnail(
  library: Library,
  ids: readonly AssetId[],
  path: string,
): Promise<Redrawn[]> {
  const assets = [...new Set(ids)];
  for (const id of assets) {
    if (library.db.repo.findAsset(id) === undefined) throw new UnknownAssetError(id);
  }

  const outcome = await derive(path, THUMBNAIL_SIZES);
  if (!outcome.ok) throw new NotAPictureError(path, outcome.reason);

  const now = nowUnix();
  const { repo } = library.db;
  return library.db.transaction(() =>
    assets.map((id): Redrawn => {
      repo.choosePictures(id, outcome.thumbnails);
      // What the queue was stuck on is answered, so its badge goes. A job
      // still waiting stays: it measures the file, and keeps these.
      repo.settleStalled("derive", id, FILE_PROBLEMS);
      repo.touchPictures(id, now);
      return {
        id,
        derivedAt: now,
        undrawn: repo.stalledReasons("derive", [id]).get(id) ?? null,
        chosen: true,
      };
    }),
  );
}

/**
 * Gives every asset in `ids` its own thumbnail back, and answers the ones that
 * had a chosen one.
 *
 * The pictures go at once and the file's are queued ahead of everything else,
 * as an opened file is. A poster frame pinned meanwhile is what they are drawn
 * from (ADR-0024).
 *
 * **The address moves now, not when the file's picture arrives.** A thumbnail
 * is served `immutable`, so a card that kept its key went on showing the
 * removed picture out of Chromium's cache, for good where the file cannot be
 * drawn: a window check found it. The cell shows its placeholder in between.
 */
export function clearThumbnail(library: Library, ids: readonly AssetId[]): Redrawn[] {
  const { repo } = library.db;
  const now = nowUnix();
  return library.db.transaction(() => {
    const cleared = [...new Set(ids)].filter((id) => repo.unchoosePictures(id));
    enqueueDerives(library, cleared, JOB_PRIORITY.interactive);
    for (const id of cleared) repo.touchPictures(id, now);
    return cleared.map((id) => ({ id, derivedAt: now, undrawn: null, chosen: false }));
  });
}

/** Which of `ids` show a thumbnail somebody chose. */
export function chosenThumbnails(library: Library, ids: readonly AssetId[]): Set<AssetId> {
  return library.db.repo.chosenAmong(ids);
}
