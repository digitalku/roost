import { useEffect, useState } from "react";

/**
 * How long a wait may run before the window says anything about it
 * (`UI_SPEC.md` §8).
 *
 * Anything faster reads as a flash: a skeleton or a line of text that appears
 * and is replaced within a fifth of a second is a flicker, not news.
 */
export const LOADING_DELAY_MS = 150;

/**
 * True once `active` has held for `ms` without a break, and false again the
 * moment it stops — so the next wait starts counting from nothing.
 */
export function useShownAfter(active: boolean, ms: number = LOADING_DELAY_MS): boolean {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);

  return active && shown;
}
