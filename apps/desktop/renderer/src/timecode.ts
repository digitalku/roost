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
  const total = Math.floor(ms / 1000);
  const tenths = Math.floor((ms % 1000) / 100);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const tail = `${hours > 0 ? pad(minutes) : minutes}:${pad(seconds)}.${tenths}`;
  return hours > 0 ? `${hours}:${tail}` : tail;
}
