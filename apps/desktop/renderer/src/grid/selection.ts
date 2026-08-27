/**
 * Selection and focus, held outside the cell tree.
 *
 * `UI_SPEC.md` §6 is explicit about why: selecting one cell must not re-render
 * ten thousand others. React state one level above the grid would do exactly
 * that, and a context whose value changes on selection would do it twice. So
 * this is a plain store, cells subscribe to their own hash, and a click
 * notifies the two cells whose state actually changed.
 *
 * The snapshot is a **number**, not an object: `useSyncExternalStore` compares
 * snapshots by identity, and a fresh `{selected, focused}` on every read would
 * make every cell re-render on every store read — the bug this file exists to
 * avoid, reintroduced by its own API.
 */

export const NOT_SELECTED = 0;
export const SELECTED = 1;
export const FOCUSED = 2;

/** The state of one cell, as a bitfield. */
export type CellState = number;

export class SelectionStore {
  #selected = new Set<string>();
  #focused: string | undefined;
  /** Where a `Shift`-click measures from. Set by a plain click, not by focus. */
  #anchor: number | undefined;
  #order: readonly string[] = [];

  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #revisionListeners = new Set<() => void>();
  #revision = 0;

  /**
   * The result order, which is what `Shift` and the arrow keys move through.
   *
   * Replaced whenever a page arrives. Anything selected that is no longer in
   * the order stays selected: a page can arrive while a selection is held, and
   * dropping it would make scrolling lose the user's work.
   */
  setOrder(order: readonly string[]): void {
    this.#order = order;
  }

  subscribe =
    (hash: string) =>
    (notify: () => void): (() => void) => {
      let listeners = this.#listeners.get(hash);
      if (listeners === undefined) {
        listeners = new Set();
        this.#listeners.set(hash, listeners);
      }
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
        if (listeners.size === 0) this.#listeners.delete(hash);
      };
    };

  stateOf = (hash: string): CellState =>
    (this.#selected.has(hash) ? SELECTED : 0) | (this.#focused === hash ? FOCUSED : 0);

  /**
   * A monotonic counter, bumped whenever the selection changes at all.
   *
   * Subscribed to for the *wake*, not for the value: a consumer that needs the
   * whole selection reads it afterwards. A count would be wrong here — one
   * deselected and another selected in the same gesture leaves the count equal
   * and the selection different — and a `Set` would be a new identity on every
   * read, which `useSyncExternalStore` would take for a change.
   */
  subscribeRevision = (notify: () => void): (() => void) => {
    this.#revisionListeners.add(notify);
    return () => this.#revisionListeners.delete(notify);
  };

  revision = (): number => this.#revision;

  get size(): number {
    return this.#selected.size;
  }

  get focused(): string | undefined {
    return this.#focused;
  }

  selected(): string[] {
    // In result order rather than insertion order, because that is the order
    // everything downstream — export, tagging, the inspector — reads them in.
    return this.#order.filter((hash) => this.#selected.has(hash));
  }

  /** Replaces the selection with one cell, and anchors from it. */
  click(hash: string): void {
    this.#change(() => {
      this.#selected = new Set([hash]);
      this.#focused = hash;
      this.#anchor = this.#indexOf(hash);
    });
  }

  /** `Ctrl`-click: adds or removes one, and re-anchors there. */
  toggle(hash: string): void {
    this.#change(() => {
      if (this.#selected.has(hash)) this.#selected.delete(hash);
      else this.#selected.add(hash);
      this.#focused = hash;
      this.#anchor = this.#indexOf(hash);
    });
  }

  /** `Shift`-click: everything from the anchor to here, replacing the rest. */
  extendTo(hash: string): void {
    const to = this.#indexOf(hash);
    if (to === undefined) return;
    const from = this.#anchor ?? to;
    const [low, high] = from <= to ? [from, to] : [to, from];
    this.#change(() => {
      this.#selected = new Set(this.#order.slice(low, high + 1));
      this.#focused = hash;
      // The anchor deliberately stays put, so a second Shift-click re-measures
      // from the same place rather than from the last one.
    });
  }

  /**
   * Everything currently loaded.
   *
   * `UI_SPEC.md` §6: over 900,000 unloaded rows this is a promise the grid
   * cannot keep, so it selects what it has and the status bar says how many.
   */
  selectLoaded(): void {
    this.#change(() => {
      this.#selected = new Set(this.#order);
    });
  }

  clear(): void {
    this.#change(() => {
      this.#selected = new Set();
      this.#anchor = undefined;
    });
  }

  /** Moves focus without touching the selection — they are separate. */
  focus(hash: string): void {
    this.#change(() => {
      this.#focused = hash;
    });
  }

  /** `Space`: toggles the focused cell, leaving focus where it is. */
  toggleFocused(): void {
    const hash = this.#focused;
    if (hash === undefined) return;
    this.#change(() => {
      if (this.#selected.has(hash)) this.#selected.delete(hash);
      else this.#selected.add(hash);
    });
  }

  #indexOf(hash: string): number | undefined {
    const at = this.#order.indexOf(hash);
    return at === -1 ? undefined : at;
  }

  /**
   * Applies a mutation and notifies only the cells whose state changed.
   *
   * The whole point of the file. A selection of one replacing a selection of
   * one wakes two cells, not the ten thousand on screen behind them.
   */
  #change(mutate: () => void): void {
    const before = new Map<string, CellState>();
    for (const hash of this.#listeners.keys()) before.set(hash, this.stateOf(hash));

    mutate();

    for (const [hash, was] of before) {
      if (this.stateOf(hash) === was) continue;
      for (const notify of this.#listeners.get(hash) ?? []) notify();
    }
    // Bumped whether or not a subscribed cell noticed: a cell scrolled out of
    // view has no listener, so the status bar cannot learn the count from the
    // cells.
    this.#revision += 1;
    for (const notify of this.#revisionListeners) notify();
  }
}
