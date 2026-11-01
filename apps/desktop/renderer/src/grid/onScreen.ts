import type { AssetCard } from "@roost/contract";
import { useEffect, useRef } from "react";

/**
 * How long a screen has to stay put before it is told. Scrolling through a grid
 * says nothing, so a paused queue draws where somebody stopped and nothing they
 * passed on the way there.
 */
const AT_REST_MS = 150;

/**
 * Says which cells are on screen, for a paused queue to draw the ones still
 * waiting (ADR-0049 §5).
 *
 * All of them, because a card cannot say whether it has a picture: an import
 * writes the derive time before anything is drawn. The engine is what knows.
 *
 * Sent again as each picture arrives, which is why the key holds the derive
 * time: that is what finishes a screen holding more than a paused queue
 * remembers. `cards` is compared by value, since a new array comes per render.
 */
export function useOnScreen(
  cards: readonly AssetCard[],
  tell: ((ids: readonly string[]) => void) | undefined,
): void {
  const told = useRef("");
  const key = cards.map((card) => `${card.id}:${card.derivedAt}`).join();

  useEffect(() => {
    if (tell === undefined || key === told.current) return;
    const timer = setTimeout(() => {
      told.current = key;
      const ids = key === "" ? [] : key.split(",").map((part) => part.slice(0, part.indexOf(":")));
      tell(ids);
    }, AT_REST_MS);
    return () => clearTimeout(timer);
  }, [key, tell]);
}
