/**
 * Turning numbers into lines a person reads.
 *
 * **Sizes are MiB, and say so.** The Rust CLI divides by 1024 twice and prints
 * `MB`, so the same library reads as `445.3 MB` there and `467.0 MB` from a
 * naive `bytes / 1e6`. Neither number is wrong and they do not disagree — 445.3
 * MiB *is* 467.0 MB — but two implementations describing one library must not
 * look like they disagree about its size. Same divisor, honest label.
 */

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

export function bytes(count: number): string {
  let value = count;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} ${UNITS[0]}` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

export function rate(count: number, ms: number): string {
  return ms <= 0 ? "—" : `${Math.round((count / ms) * 1000)}`;
}

/**
 * A count with its noun, pluralised by adding an `s` unless told otherwise.
 *
 * Only the regular case is handled, because only the regular case appears here:
 * a summary line reading "1 subtitles" is the kind of small wrongness that
 * makes a report look machine-generated.
 */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A label-and-value line, aligned. Two spaces of indent per level. */
export function row(label: string, value: string | number, indent = 1, width = 12): string {
  return `${"  ".repeat(indent)}${label.padEnd(width)}${value}`;
}
