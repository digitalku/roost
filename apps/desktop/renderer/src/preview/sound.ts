/**
 * How loud the player is, and whether it is silenced (ADR-0024 §9).
 *
 * Asked for on 2026-09-10: *"apakah memungkinkan bisa mengingat volume
 * terakhir? jadi tidak langsung volume 100% ketika membuka media"*. A media
 * element starts at full volume every time it is created, and the preview
 * creates a new one per asset — so turning the sound down lasted exactly as
 * long as the clip did.
 *
 * **A store rather than a prop**, for the reason `playhead.ts` gives about a
 * different fact of the same shape: it is one answer for the window, it changes
 * on a gesture that is continuous, and holding it in `App`'s state would
 * re-render the grid behind the preview once per pixel of a slider drag —
 * exactly what `CLAUDE.md` §8 forbids for scroll handlers, for the same reason.
 *
 * The element is still the state while it is on screen. This holds what a *new*
 * element should start at, seeded from the library when one opens and updated
 * from whatever the element says afterwards. Nothing here polls, and nothing
 * asks the element a question it has not already answered.
 */

/** Percent, 0–100 — the slider's own vocabulary, and `settings.json`'s. */
export interface Loudness {
  readonly volume: number;
  readonly muted: boolean;
}

/** Where a media element starts on its own, and so where this does. */
const FULL: Loudness = { volume: 100, muted: false };

class Sound {
  #held: Loudness = FULL;
  readonly #listeners = new Set<(loudness: Loudness) => void>();

  /**
   * Seeds from the library that has just opened, telling nobody.
   *
   * Silent on purpose: a listener here writes to `settings.json`, and a seed
   * that announced itself would write the value it had just read back — once
   * per library opened, for a preference nobody touched.
   */
  remember(loudness: Loudness): void {
    this.#held = clamp(loudness);
  }

  /** What the next element should start at. */
  current(): Loudness {
    return this.#held;
  }

  /**
   * The element reported something new.
   *
   * Identical values are dropped rather than passed on, which is what stops an
   * echo: applying the remembered volume to a new element makes the element
   * emit `volumechange`, and a listener that wrote every one of those would
   * write the file on every video opened.
   */
  changed(loudness: Loudness): void {
    const next = clamp(loudness);
    if (next.volume === this.#held.volume && next.muted === this.#held.muted) return;
    this.#held = next;
    for (const listener of this.#listeners) listener(next);
  }

  /** Shaped for `useEffect`'s cleanup, which is the only caller. */
  onChange(listener: (loudness: Loudness) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

/**
 * Whole percent inside the bounds the element will accept.
 *
 * `HTMLMediaElement.volume` throws on anything outside 0–1, so a hand-edited
 * `settings.json` must not be able to reach the assignment: the engine bounds
 * it too, and this is the side that would break if either check were dropped.
 */
function clamp({ volume, muted }: Loudness): Loudness {
  const whole = Number.isFinite(volume) ? Math.round(volume) : FULL.volume;
  return { volume: Math.min(Math.max(whole, 0), 100), muted };
}

export const sound = new Sound();
