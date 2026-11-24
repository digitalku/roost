import { useEffect, useState } from "react";
import { onEvent } from "./bridge.js";

/**
 * A counter that moves whenever a derive names one of `ids` (ADR-0047).
 *
 * A file saved by another application reaches the window as `assets:derived`
 * and nothing else: no journal line was written, so there is no
 * `library:changed`, and a reader that re-reads only on a change goes on
 * showing what the file was. The grid patches its cards from the event itself;
 * a reader holding a whole detail — the preview, the inspector — uses this as a
 * trigger to read it again.
 *
 * Takes the ids as one string key, so a caller passing a fresh array per render
 * does not resubscribe on every one.
 */
export function useRedrawn(ids: readonly string[]): number {
  const [count, setCount] = useState(0);
  const key = ids.join(" ");

  useEffect(() => {
    if (key === "") return;
    const wanted = new Set(key.split(" "));
    return onEvent((event) => {
      if (event.type !== "assets:derived") return;
      if (event.assets.some((asset) => wanted.has(asset.id))) setCount((n) => n + 1);
    });
  }, [key]);

  return count;
}
