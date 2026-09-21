/**
 * The preview-size image, and what to draw when it is not there yet.
 *
 * `@512` is generated on first use rather than at import (`serving.ts`), so
 * there is a window — the first time an asset is opened, or after a rebuild —
 * where the size the inspector wants does not exist. Falling back to the grid
 * size is a softer picture; the alternative is Chromium's broken-image glyph,
 * which is what it was.
 *
 * Declared at module scope so every image shares one function rather than
 * allocating a closure each (`UI_SPEC.md` §6).
 */

export function previewSrc(
  id: string,
  posterMs: number | null = null,
  derivedAt: number | null = null,
): string {
  return `roost://thumb/${id}@512${version(posterMs, derivedAt)}`;
}

export function gridSrc(
  id: string,
  posterMs: number | null = null,
  derivedAt: number | null = null,
): string {
  return `roost://thumb/${id}@256${version(posterMs, derivedAt)}`;
}

/**
 * Everything that can change the pixels behind one id, as part of the address.
 *
 * `roost://thumb/<id>@<size>` is served with `immutable` and a year's lifetime,
 * and under version 1 that was free: the id was the hash of the bytes, so an id
 * and a size fixed the picture. **Version 2 breaks that promise by design** —
 * the bytes behind an id may change at any time, by any application (RL-20) —
 * and an `<img>` whose `src` has not changed is an `<img>` Chromium never asks
 * about again. A watcher that re-derives perfectly would still leave last
 * week's thumbnail on screen.
 *
 * So both of the things that can move the picture go in the query:
 *
 * - `at` — the moment a video's thumbnail is pinned to (ADR-0024 stage 4);
 * - `v` — when the asset was last derived, which the watcher and the catch-up
 *   sweep move whenever the file underneath changes (ADR-0047).
 *
 * The query is not part of what is addressed — `route.ts` reads the path and
 * nothing else — it is part of the cache key, which is exactly what is needed.
 */
function version(posterMs: number | null, derivedAt: number | null): string {
  const parts: string[] = [];
  if (posterMs !== null) parts.push(`at=${posterMs}`);
  if (derivedAt !== null) parts.push(`v=${derivedAt}`);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/**
 * Falls back once, from the preview size to the grid size.
 *
 * Once, because a second failure means the asset has no thumbnail at all — a
 * format nothing draws, or work the queue has not reached — and retrying would
 * be a loop against a 404.
 */
export function fallbackToGrid(event: React.SyntheticEvent<HTMLImageElement>): void {
  const image = event.currentTarget;
  const fallback = image.src.replace("@512", "@256");
  if (fallback === image.src) {
    image.hidden = true;
    return;
  }
  image.src = fallback;
}

/**
 * Steps a preview down to something that exists, once per step.
 *
 * The pane asks for a **rendition** where a browser cannot read the file itself
 * — HEIC, RAW, TIFF (ADR-0040 §7) — and that can fail for reasons the window
 * cannot see: a machine with no libheif, a RAW with no embedded preview, a file
 * that is not what its name says. The picture Roost already derived is the
 * honest answer then, and Chromium's broken-image glyph is not.
 *
 * `render → @512 → @256 → hidden`, and each failure moves one step, so a
 * missing thumbnail cannot become a loop against a 404.
 */
export function fallbackFromRendition(event: React.SyntheticEvent<HTMLImageElement>): void {
  const image = event.currentTarget;
  const rendition = /^roost:\/\/render\/([0-9a-f]{64})$/.exec(image.src);
  if (rendition?.[1] !== undefined) {
    image.src = previewSrc(rendition[1]);
    return;
  }
  fallbackToGrid(event);
}

/**
 * Shows an image that has arrived, undoing a hiding meant for a different one.
 *
 * The hiding above is written straight onto the node, which React neither knows
 * about nor undoes — and the panel draws **one** `<img>` for whatever is
 * selected, so the element survives the change of asset. Select a `.txt`, which
 * has no thumbnail at any size, and the next asset's picture loads into an
 * element still marked hidden: a panel that is blank for everything until the
 * selection empties and the node is finally thrown away. Reported from a real
 * window on 2026-09-05 and reproduced there before this was written.
 *
 * `load` is the right event to undo it on: it fires when bytes have arrived and
 * only then, so the flag tracks what the element is actually showing.
 */
export function showLoaded(event: React.SyntheticEvent<HTMLImageElement>): void {
  event.currentTarget.hidden = false;
}
