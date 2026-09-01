import { useSyncExternalStore } from "react";

/**
 * The player on screen, for whoever needs to drive it.
 *
 * A store rather than a prop, because the two things that seek are in different
 * subtrees: the marker strip is under the player in the preview, and the
 * comment list is in the inspector beside it (ADR-0023 §6). Threading a ref
 * from one to the other would go up through `App` and back down, and every
 * component on the way would gain a prop about a feature it has nothing to do
 * with.
 *
 * It is a fact about the *window* rather than about a component: one preview is
 * open at a time (`UI_SPEC.md` §7), so there is at most one media element to
 * hold. That is the same argument that puts the selection outside the cell tree
 * (§6), for a much smaller thing.
 *
 * Nothing here polls, and nothing here holds a copy of what the element knows.
 * The position is read at the moment somebody asks for it, and the transport
 * keys go straight through to `play()` and `muted` — the element then announces
 * the change and the transport redraws itself from it (ADR-0024). A store that
 * kept its own idea of "playing" would be a second answer to a question the
 * element already answers.
 */
class Playhead {
  #media: HTMLMediaElement | undefined;
  readonly #listeners = new Set<() => void>();

  /**
   * Registers the element and hands back the way to unregister it.
   *
   * Shaped for `useEffect`'s cleanup, which is the only caller. Detaching
   * checks identity rather than clearing outright: a preview stepping to the
   * next asset mounts the new element before React runs the old one's cleanup,
   * and clearing unconditionally would leave the window believing there is no
   * player while one is on screen.
   */
  attach(media: HTMLMediaElement): () => void {
    this.#media = media;
    this.#announce();
    return () => {
      if (this.#media !== media) return;
      this.#media = undefined;
      this.#announce();
    };
  }

  subscribe = (notify: () => void): (() => void) => {
    this.#listeners.add(notify);
    return () => this.#listeners.delete(notify);
  };

  /** Whether there is anything to seek. A primitive, so it is a stable snapshot. */
  attached = (): boolean => this.#media !== undefined;

  /** Where the player is, in milliseconds, or `null` when there is no player. */
  now(): number | null {
    const media = this.#media;
    if (media === undefined) return null;
    // `currentTime` is seconds as a float; the format stores milliseconds, and
    // rounding here is what keeps the two from disagreeing by a rounding step
    // every time a comment is read back and re-saved.
    return Math.round(media.currentTime * 1000);
  }

  /** Seeks, and answers whether there was a player to seek. */
  seek(ms: number): boolean {
    const media = this.#media;
    if (media === undefined) return false;
    media.currentTime = ms / 1000;
    return true;
  }

  /**
   * Seeks by a step, staying inside the medium.
   *
   * What the preview's `J` and `L` are: the arrow keys step between assets, so
   * coarse seeking needs keys of its own (`UI_SPEC.md` §9).
   */
  nudge(deltaMs: number): boolean {
    const media = this.#media;
    if (media === undefined) return false;
    const seconds = media.currentTime + deltaMs / 1000;
    const end = media.duration;
    media.currentTime = Math.max(
      0,
      Number.isFinite(end) && end > 0 ? Math.min(end, seconds) : seconds,
    );
    return true;
  }

  /** Plays or pauses, and answers whether there was a player. */
  toggle(): boolean {
    const media = this.#media;
    if (media === undefined) return false;
    // The promise rejects when the platform refuses to start playing, which is
    // a policy rather than a fault: the element stays paused and says so.
    if (media.paused) void media.play().catch(() => undefined);
    else media.pause();
    return true;
  }

  /** Mutes or unmutes, and answers whether there was a player. */
  toggleMute(): boolean {
    const media = this.#media;
    if (media === undefined) return false;
    media.muted = !media.muted;
    return true;
  }

  #announce(): void {
    for (const notify of this.#listeners) notify();
  }
}

export const playhead = new Playhead();

/** Whether a player is on screen, as a component can subscribe to it. */
export function usePlayer(): boolean {
  return useSyncExternalStore(playhead.subscribe, playhead.attached, () => false);
}
