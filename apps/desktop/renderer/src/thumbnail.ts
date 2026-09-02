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

export function previewSrc(hash: string, posterMs: number | null = null): string {
  return `roost://thumb/${hash}@512${pinned(posterMs)}`;
}

export function gridSrc(hash: string, posterMs: number | null = null): string {
  return `roost://thumb/${hash}@256${pinned(posterMs)}`;
}

/**
 * The moment a video's thumbnail is pinned to, as part of its address.
 *
 * `roost://thumb/<hash>@<size>` is served with `immutable` and a year's
 * lifetime, on the promise that a hash and a size fix the pixels. A pinned
 * frame is the one thing that can change them (ADR-0024 stage 4), so it goes in
 * the URL: the bytes behind any one address still cannot change, a new frame is
 * a new address, and an `<img>` already showing the old one is asked for the
 * new one rather than left holding a picture nothing will replace.
 *
 * The query is not part of what is addressed — `route.ts` reads the path and
 * nothing else — it is part of the cache key, which is exactly what is needed.
 */
function pinned(posterMs: number | null): string {
  return posterMs === null ? "" : `?at=${posterMs}`;
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
