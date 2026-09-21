/**
 * What an import did with the file it was given (RL-26).
 *
 * Version 2 has one storage mode: the bytes live under `files/`, always
 * (RL-19). The question a library still has to answer is what happened to the
 * source — moved out of where it was, or copied and left there — and RL-26
 * requires the person to be told which, because a move is not undoable by
 * looking at the library.
 *
 * It is also `watch_add`'s `take`: nobody is at the screen when a watched
 * folder catches a file, so the answer is decided once, when the root is
 * registered.
 */
export const TAKES = ["move", "copy"] as const;

export type Take = (typeof TAKES)[number];

export function isTake(value: string): value is Take {
  return (TAKES as readonly string[]).includes(value);
}

/**
 * How the bytes actually got there, for the log and the benchmarks.
 *
 * Not journalled and not part of the format: RL-22 makes every fact about the
 * bytes derived, and this is a fact about the *filesystem call* rather than
 * about the file. It is kept because the three differ by orders of magnitude
 * and a slow import is otherwise unexplainable.
 *
 * `rename` is a move within one filesystem — free. `reflink` is a
 * copy-on-write clone, which RL-26 permits because the result is an
 * independent file; a **hardlink is not**, and there is no value for one here,
 * because editing the library's file would edit the user's file outside it.
 */
export const PLACEMENTS = ["rename", "reflink", "copy"] as const;

export type Placement = (typeof PLACEMENTS)[number];

export function isPlacement(value: string): value is Placement {
  return (PLACEMENTS as readonly string[]).includes(value);
}
