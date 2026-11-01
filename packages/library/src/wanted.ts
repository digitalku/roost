import type { AssetId } from "@roost/core";

/**
 * The assets somebody is looking at a placeholder for, newest first.
 *
 * Whatever was asked for last is what is being looked at now.
 *
 * Held in memory and never written down. It is a hint about one window at one
 * moment, and an index that remembered it would remember a screen nobody is
 * looking at any more. Bounded: the oldest are forgotten, and stay queued.
 */
export class Wanted {
  readonly #capacity: number;
  /** Insertion order is recency: a `Map` iterates oldest first. */
  readonly #ids = new Map<AssetId, true>();

  /**
   * @param capacity How many ids to remember. The default is a few screens of
   *   the smallest cells the grid draws.
   */
  constructor(capacity = 256) {
    this.#capacity = capacity;
  }

  /** Records that these assets were just asked for, the last one most recently. */
  add(ids: Iterable<AssetId>): void {
    for (const id of ids) {
      // Deleted first so that asking again moves an id to the newest end.
      this.#ids.delete(id);
      this.#ids.set(id, true);
    }
    for (const oldest of this.#ids.keys()) {
      if (this.#ids.size <= this.#capacity) break;
      this.#ids.delete(oldest);
    }
  }

  /** The most recently asked-for id, forgotten as it is handed out. */
  take(): AssetId | undefined {
    let newest: AssetId | undefined;
    // A `Map` has no cheap last element; the capacity bounds this walk.
    for (const id of this.#ids.keys()) newest = id;
    if (newest !== undefined) this.#ids.delete(newest);
    return newest;
  }

  clear(): void {
    this.#ids.clear();
  }

  get size(): number {
    return this.#ids.size;
  }
}

/**
 * How many cells the queue remembers, about one screen (ADR-0065).
 *
 * The user's number. A screen holding more is finished by the window, which
 * says again what is left as each picture arrives.
 */
export const ON_SCREEN_LIMIT = 60;

/**
 * What the window draws: what was asked for, and nothing else (ADR-0065).
 *
 * Three lines, each served before the next. **Opened** is a file somebody is
 * looking at right now, newest first, so it is the last one opened and not the
 * first. **On screen** is the cells a window has at rest, from the top,
 * {@link ON_SCREEN_LIMIT} of them at most. **Queued** is what *Try again*
 * released, in the order it was asked for. That list can be long, which is why
 * it is an array with a head rather than a {@link Wanted}: finding the newest
 * end of a `Map` walks it, and a walk per claim over a long list is quadratic.
 *
 * An id handed out that has nothing waiting is simply skipped by the runner, so
 * nothing here has to know what is already drawn.
 */
export class Requested {
  readonly #opened = new Wanted();
  readonly #onScreen = new Wanted(ON_SCREEN_LIMIT);
  #queued: AssetId[] = [];
  #head = 0;

  /** A file somebody opened: ahead of everything, the latest first. */
  open(id: AssetId): void {
    this.#opened.add([id]);
  }

  /**
   * The cells on screen with no picture, from the top, in place of the last
   * list: what somebody scrolled away from stops being drawn.
   */
  showing(ids: readonly AssetId[]): void {
    this.#onScreen.clear();
    // Reversed because a `Wanted` hands out, and keeps, its newest.
    this.#onScreen.add([...ids].reverse());
  }

  /** Files asked for together, worked in the order given. */
  queue(ids: Iterable<AssetId>): void {
    for (const id of ids) this.#queued.push(id);
  }

  take(): AssetId | undefined {
    const opened = this.#opened.take();
    if (opened !== undefined) return opened;
    const onScreen = this.#onScreen.take();
    if (onScreen !== undefined) return onScreen;
    if (this.#head >= this.#queued.length) {
      this.clear();
      return undefined;
    }
    const next = this.#queued[this.#head];
    this.#head += 1;
    return next;
  }

  clear(): void {
    this.#opened.clear();
    this.#onScreen.clear();
    this.#queued = [];
    this.#head = 0;
  }

  get size(): number {
    return this.#opened.size + this.#onScreen.size + this.#queued.length - this.#head;
  }
}
