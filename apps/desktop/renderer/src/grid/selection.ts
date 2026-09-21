/**
 * Selection and focus, held outside the cell tree.
 *
 * `UI_SPEC.md` §6 is explicit about why: selecting one cell must not re-render
 * ten thousand others. React state one level above the grid would do exactly
 * that, and a context whose value changes on selection would do it twice. So
 * this is a plain store, cells subscribe to their own id, and a click
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
    (id: string) =>
    (notify: () => void): (() => void) => {
      let listeners = this.#listeners.get(id);
      if (listeners === undefined) {
        listeners = new Set();
        this.#listeners.set(id, listeners);
      }
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
        if (listeners.size === 0) this.#listeners.delete(id);
      };
    };

  stateOf = (id: string): CellState =>
    (this.#selected.has(id) ? SELECTED : 0) | (this.#focused === id ? FOCUSED : 0);

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
    return this.#order.filter((id) => this.#selected.has(id));
  }

  /** Replaces the selection with one cell, and anchors from it. */
  click(id: string): void {
    this.#change(() => {
      this.#selected = new Set([id]);
      this.#focused = id;
      this.#anchor = this.#indexOf(id);
    });
  }

  /** `Ctrl`-click: adds or removes one, and re-anchors there. */
  toggle(id: string): void {
    this.#change(() => {
      if (this.#selected.has(id)) this.#selected.delete(id);
      else this.#selected.add(id);
      this.#focused = id;
      this.#anchor = this.#indexOf(id);
    });
  }

  /** `Shift`-click: everything from the anchor to here, replacing the rest. */
  extendTo(id: string): void {
    const to = this.#indexOf(id);
    if (to === undefined) return;
    const from = this.#anchor ?? to;
    const [low, high] = from <= to ? [from, to] : [to, from];
    this.#change(() => {
      this.#selected = new Set(this.#order.slice(low, high + 1));
      this.#focused = id;
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

  /**
   * What a marquee sweep is holding, as one replacement.
   *
   * Applied per frame rather than per pointer event, and only when the swept
   * set has actually changed — so a drag across four hundred cells wakes each
   * of them once, on the frame it was crossed, rather than on every move.
   *
   * `base` is the selection the drag started from, passed when the gesture is
   * additive (`Ctrl` held): the sweep adds to it rather than toggling through
   * it, because a rect that grows and shrinks over the same cell would
   * otherwise flip it on and off as the pointer wobbled.
   *
   * Focus and the anchor are deliberately left alone. They are separate from
   * the selection (`UI_SPEC.md` §6), and moving the ring per frame would drag
   * the viewport along with it — the grid scrolls focus back into view.
   */
  sweep(ids: readonly string[], base?: ReadonlySet<string>): void {
    this.#change(() => {
      this.#selected = base === undefined ? new Set(ids) : new Set([...base, ...ids]);
    });
  }

  clear(): void {
    this.#change(() => {
      this.#selected = new Set();
      this.#anchor = undefined;
    });
  }

  /**
   * What `clear` is, plus the focus: the rows themselves are gone.
   *
   * The two are separate gestures. Clicking the grid's background clears a
   * selection and leaves the ring where it was, because the cell it names is
   * still on screen and the arrow keys carry on from there. A new query takes
   * the cell away — and a ring left pointing at it is a focus nothing can see:
   * `Enter` opens an asset that is not in the result, and the preview goes on
   * drawing one.
   */
  reset(): void {
    this.#change(() => {
      this.#selected = new Set();
      this.#anchor = undefined;
      this.#focused = undefined;
    });
  }

  /**
   * Marks one thing that is not an asset: the ring moves to it and the
   * selection empties (ADR-0043).
   *
   * A folder tile is drawn in the grid and is **not a result**, so it must
   * never enter the selection — what `selected()` returns is read by the
   * inspector, the trash and every edit, and a folder id among those ids
   * would be an edit aimed at nothing. The store stays ignorant of folders:
   * this is `click` without the one line that selects, and the order it is
   * given holds assets alone, so an id marked here is simply not in it.
   */
  focusOnly(id: string): void {
    this.#change(() => {
      this.#selected = new Set();
      this.#focused = id;
      this.#anchor = undefined;
    });
  }

  /** Moves focus without touching the selection — they are separate. */
  focus(id: string): void {
    this.#change(() => {
      this.#focused = id;
    });
  }

  /** `Space`: toggles the focused cell, leaving focus where it is. */
  toggleFocused(): void {
    const id = this.#focused;
    if (id === undefined) return;
    this.#change(() => {
      if (this.#selected.has(id)) this.#selected.delete(id);
      else this.#selected.add(id);
    });
  }

  #indexOf(id: string): number | undefined {
    const at = this.#order.indexOf(id);
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
    for (const id of this.#listeners.keys()) before.set(id, this.stateOf(id));

    mutate();

    for (const [id, was] of before) {
      if (this.stateOf(id) === was) continue;
      for (const notify of this.#listeners.get(id) ?? []) notify();
    }
    // Bumped whether or not a subscribed cell noticed: a cell scrolled out of
    // view has no listener, so the status bar cannot learn the count from the
    // cells.
    this.#revision += 1;
    for (const notify of this.#revisionListeners) notify();
  }
}
