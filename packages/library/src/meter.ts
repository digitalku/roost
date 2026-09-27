/**
 * Counting bytes for a progress bar: a transfer's (ADR-0054 §3.9) and an
 * import's (ADR-0055).
 */

/**
 * The size from which a file is copied a chunk at a time, so that its copy can
 * be counted and stopped part way.
 *
 * Below it the kernel's `copyFile` is faster by about a quarter where memory is
 * the limit (`BENCHMARKS.md`, 2026-09-27), and a file that small finishes too
 * soon for the bar to need it counted as it goes. It is also where a transfer
 * starts taking large files in turn: eight videos of several gigabytes at once
 * make a hard disk seek between eight places for the whole run.
 */
export const LARGE_FILE = 64 * 1024 * 1024;

/** One file's part of a {@link ByteMeter}. */
export interface MeterShare {
  /** Counts bytes as they are read or written. */
  readonly count: (bytes: number) => void;
  /**
   * Squares the file off, so a file skipped, merged, reflinked or failed still
   * brings the count to where it would have been.
   */
  readonly finish: () => void;
}

/**
 * Bytes dealt with, out of a total known in advance.
 *
 * Every byte is counted twice — read to be hashed, then written — and what is
 * reported is half the sum, so the count runs from zero to the total and means
 * "this much of the data has been dealt with". A file whose write is skipped
 * (a duplicate, a rename, a reflink) is counted as though it had happened, by
 * {@link MeterShare.finish}.
 */
export class ByteMeter {
  readonly total: number;
  readonly #onChange: (() => void) | undefined;
  #work = 0;

  constructor(total: number, onChange?: () => void) {
    this.total = total;
    this.#onChange = onChange;
  }

  /** Bytes dealt with so far, never past the total. */
  get done(): number {
    return Math.min(Math.floor(this.#work / 2), this.total);
  }

  /** One file's share: counts as it goes, and squares off at the end. */
  file(size: number): MeterShare {
    let counted = 0;
    const budget = size * 2;
    return {
      count: (bytes) => {
        // Capped, because a file that grew since it was measured would
        // otherwise carry the bar past the end.
        const add = Math.min(bytes, budget - counted);
        if (add <= 0) return;
        counted += add;
        this.#work += add;
        this.#onChange?.();
      },
      finish: () => {
        this.#work += budget - counted;
        counted = budget;
        this.#onChange?.();
      },
    };
  }
}
