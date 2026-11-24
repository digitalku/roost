import { useState } from "react";

/**
 * The query that keeps `roost://file/`, `roost://render/` and `roost://page/`
 * honest after a save elsewhere.
 *
 * All three are served with a long cache lifetime, and the file's own bytes as
 * `immutable` — but under version 2 the bytes behind an id may change at any
 * time, by any application (RL-20). An `<img>` whose `src` did not change is one
 * Chromium never asks about again, so a photograph flipped in another editor
 * went on showing unflipped in the preview until Roost was restarted, while its
 * thumbnail, whose address carries the derive time, had already moved
 * (reported 2026-11-24). The fix is the thumbnail's: the address carries what
 * decides the bytes (`TODO.md` lesson 17).
 *
 * **The content hash, not the derive time.** The derive time also moves when a
 * video's thumbnail is pinned to another moment (ADR-0024 stage 4), and that is
 * done from the player while it plays: a new address there would reload the
 * video under the hand pinning the frame. The hash moves only with the bytes.
 *
 * **The first hash is adopted, not shown.** A file opened before its first
 * derive has no hash yet, and the derive an opening asks for (ADR-0065) lands a
 * moment later. Moving the address then would restart a video a few seconds
 * into playing it, for bytes that did not change. So the address takes a hash
 * only once a second one differs from the first, and the state is per asset:
 * stepping to another resets it.
 */
export function useFileVersion(id: string, hash: string | null): string {
  const [held, setHeld] = useState(() => ({ id, hash, query: queryFor(hash) }));

  let current = held;
  if (id !== held.id) {
    current = { id, hash, query: queryFor(hash) };
  } else if (hash !== null && hash !== held.hash) {
    current = { id, hash, query: held.hash === null ? held.query : queryFor(hash) };
  }
  // Adjusting state from the previous render, as React documents it: the
  // update is applied before the children see this render's output.
  if (current !== held) setHeld(current);

  return current.query;
}

function queryFor(hash: string | null): string {
  return hash === null ? "" : `?h=${hash}`;
}
