/**
 * The three ways a time is written in the window, and the one place they live.
 *
 * A moment somebody chose (`timecode`), where the playhead is (`clock`), and how
 * long the file is (`duration`) are different facts, and they are written
 * differently on purpose — but they share one formatter, because two copies of
 * `m:ss` are two copies that come to disagree.
 */

/**
 * A moment inside a medium, as a person reads it.
 *
 * `1:31.5`, and `1:02:03.4` for something long enough to need hours. Always one
 * decimal, never none: the point of a timed comment is that it is precise to a
 * fraction of a second, and `1:31` beside `1:32` reads as though the moments
 * were rounded to the second (ADR-0023).
 *
 * Separate from the inspector's `duration`, which rounds a *length* to the
 * second — a running time is a fact about the file and a moment is a place in
 * it, and showing tenths of a second of running time would be noise.
 *
 * Tenths rather than the CLI's milliseconds (`1:31.500`): the CLI prints a
 * moment so that it can be typed back in, and this one is read.
 */
export function timecode(ms: number): string {
  const tenths = Math.floor((ms % 1000) / 100);
  return `${hms(Math.floor(ms / 1000))}.${tenths}`;
}

/**
 * Where the player is, to the second — `16:12`, `1:10:00`.
 *
 * The transport carried tenths here until 2026-09-06, on the reasoning above,
 * and the reasoning did not transfer: a *comment* is worth a tenth because
 * somebody chose that moment and will click back to it, while a playhead is
 * simply passing through. The digit changed ten times a second under a number
 * nobody reads that fast, which is noise, and the user asked for it gone.
 *
 * Floored, not rounded: at 16:12.6 you are in the twelfth second, and a clock
 * that says 16:13 is a clock running ahead of the picture.
 */
export function clock(ms: number): string {
  return hms(Math.floor(ms / 1000));
}

/**
 * How long the whole thing is — `3:07`, `1:10:01`.
 *
 * Rounded rather than floored, because this is a length rather than a place:
 * a file of 1:10:00.8 is a file of about 1:10:01, and saying 1:10:00 loses the
 * last second of it. The inspector's Duration row is this same function, so the
 * two places a running time appears cannot drift apart by a second.
 */
export function duration(ms: number): string {
  return hms(Math.round(ms / 1000));
}

/** Whole seconds as `m:ss`, growing an hours field only when there is one. */
function hms(total: number): string {
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number): string => String(value).padStart(2, "0");
  // Minutes are padded once hours are shown, so `1:02:03` cannot be read as one
  // hour and two seconds.
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
