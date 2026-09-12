/**
 * Numbers as this window says them.
 *
 * One copy, because there were three: the grid cell, the inspector, and the
 * status line all count bytes, and three implementations of one convention is
 * how two of them come to disagree about what a megabyte is.
 */

/**
 * A count, grouped in English (`UI_SPEC.md` §2.3).
 *
 * Pinned to `en-US` rather than left to `toLocaleString()` with no argument,
 * which follows the machine. The interface has one language (`CLAUDE.md` §2)
 * and the thousands separator is part of it: on a machine set to Indonesian,
 * an English sentence reading *"1.234 assets"* says one and a bit.
 *
 * It is also what makes the rendering assertable. Three renderer tests were
 * pinning the en-US spelling and passing only because CI ran in that locale,
 * which is how this was found.
 *
 * **A date is not covered by this** and still follows the machine, deliberately:
 * the order of a day and a month is not a separator, and nobody has decided it.
 */
export function counted(value: number): string {
  return value.toLocaleString("en-US");
}

/** Binary multiples, the way `STORAGE_SPEC.md` and the CLI both count. */
export function bytes(size: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
