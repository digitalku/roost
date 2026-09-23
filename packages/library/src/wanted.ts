import type { AssetId } from "@roost/core";

/**
 * The assets somebody is looking at a placeholder for, newest first.
 *
 * The derive queue's own order is by priority and then by arrival, which is
 * right for a queue and wrong for a person: open a library with a hundred
 * thousand thumbnails missing, scroll to the middle, and the cells on screen
 * would wait behind every asset imported after them. This is the order that
 * fixes it — whatever was asked for last is what is being looked at now.
 *
 * Held in memory and never written down. It is a hint about one window at one
 * moment, and an index that remembered it would remember a screen nobody is
 * looking at any more.
 *
 * Bounded, and the bound is what makes scrolling cheap: flinging through ten
 * thousand cells asks for ten thousand thumbnails, and only the last few
 * screens of them are still on one. The oldest are forgotten, not derived
 * early — they are still queued, in the queue's own order.
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
