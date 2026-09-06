/**
 * Numbers as this window says them.
 *
 * One copy, because there were three: the grid cell, the inspector, and the
 * status line all count bytes, and three implementations of one convention is
 * how two of them come to disagree about what a megabyte is.
 */

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
