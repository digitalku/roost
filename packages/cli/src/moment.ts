/**
 * A moment on the command line, in the spellings a person reaches for.
 *
 * Shared by `comment --at` and `poster --at`, which are two verbs pointing at
 * the same kind of number — a second copy of this would drift the first time
 * one of them learned a new spelling.
 */

/** What `--at` accepts, and what a listing prints back. */
const TIMECODE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/;
const MILLISECONDS = /^(\d+)ms$/;
const SECONDS = /^(\d+(?:\.\d+)?)s?$/;

/**
 * `--at`, in any of the three spellings a person reaches for.
 *
 * `undefined` means "not a moment"; `null` is not returned here, because an
 * absent `--at` never reaches this function.
 *
 * Milliseconds are what the format stores, so `91500ms` is exact and the other
 * two are rounded to the nearest millisecond — a frame is 41 ms at 24fps, so
 * rounding is well below anything a person is pointing at.
 */
export function parseMoment(value: string): number | undefined {
  const clock = TIMECODE.exec(value);
  if (clock !== null) {
    const [, hours, minutes, secs, fraction] = clock;
    const ms = (fraction ?? "").padEnd(3, "0");
    return (
      Number(hours ?? 0) * 3_600_000 + Number(minutes) * 60_000 + Number(secs) * 1000 + Number(ms)
    );
  }

  const exact = MILLISECONDS.exec(value);
  if (exact !== null) return Number(exact[1]);

  const plain = SECONDS.exec(value);
  if (plain !== null) return Math.round(Number(plain[1]) * 1000);

  return undefined;
}

/** `1:31.500`, which is what the timecode above reads back. */
export function timecode(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const fraction = String(ms % 1000).padStart(3, "0");
  const tail = `${String(seconds).padStart(2, "0")}.${fraction}`;
  return hours === 0
    ? `${minutes}:${tail}`
    : `${hours}:${String(minutes).padStart(2, "0")}:${tail}`;
}
