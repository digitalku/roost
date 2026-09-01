import type { CommentRow } from "@roost/core";
import { addComment, comments as listComments, removeComment, setComment } from "@roost/library";
import { resolveAll, short } from "../assets.js";
import { EXIT, type Streams, usage } from "../io.js";
import { withLibrary } from "../open.js";

/**
 * Comments, which carry a moment (ADR-0023).
 *
 * The CLI has a verb for every user-authored mutation, so that nothing is
 * writable only from the window (ADR-0005) — and so that the rebuild test has a
 * way to author one without a GUI.
 */

/** What `--at` accepts, and what a listing prints back. */
const TIMECODE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/;
const MILLISECONDS = /^(\d+)ms$/;
const SECONDS = /^(\d+(?:\.\d+)?)s?$/;

export async function comment(
  root: string,
  needle: string,
  words: readonly string[],
  at: string | undefined,
  streams: Streams,
): Promise<number> {
  const moment = at === undefined ? null : parseMoment(at);
  if (moment === undefined) {
    return usage(streams, "comment", `${at} is not a moment — try 1:31.5, 91.5s, or 91500ms`);
  }

  return withLibrary(root, async (library) => {
    const hashes = resolveAll(library, [needle]);
    const hash = hashes[0];
    if (hash === undefined) throw new Error("resolveAll returned nothing for one argument");
    const id = await addComment(library, hash, moment, words.join(" "));
    streams.out(
      moment === null
        ? `Commented on ${short(hash)} (#${id})`
        : `Commented on ${short(hash)} at ${timecode(moment)} (#${id})`,
    );
    return EXIT.ok;
  });
}

export async function listOn(root: string, needle: string, streams: Streams): Promise<number> {
  return withLibrary(root, async (library) => {
    const hashes = resolveAll(library, [needle]);
    const hash = hashes[0];
    if (hash === undefined) throw new Error("resolveAll returned nothing for one argument");
    const found = listComments(library, hash);
    if (found.length === 0) {
      streams.out(`No comments on ${short(hash)}`);
      return EXIT.ok;
    }
    for (const row of found) streams.out(line(row));
    return EXIT.ok;
  });
}

export async function edit(
  root: string,
  id: string,
  words: readonly string[],
  at: string | undefined,
  streams: Streams,
): Promise<number> {
  const which = parseId(id);
  if (which === undefined) return usage(streams, "comment", `${id} is not a comment id`);
  const moment = at === undefined ? null : parseMoment(at);
  if (moment === undefined) {
    return usage(streams, "comment", `${at} is not a moment — try 1:31.5, 91.5s, or 91500ms`);
  }

  return withLibrary(root, async (library) => {
    await setComment(library, which, moment, words.join(" "));
    streams.out(`Edited comment #${which}`);
    return EXIT.ok;
  });
}

export async function drop(root: string, id: string, streams: Streams): Promise<number> {
  const which = parseId(id);
  if (which === undefined) return usage(streams, "comment", `${id} is not a comment id`);

  return withLibrary(root, async (library) => {
    await removeComment(library, which);
    streams.out(`Removed comment #${which}`);
    return EXIT.ok;
  });
}

function line(row: CommentRow): string {
  const when = row.atMs === null ? "—".padStart(10) : timecode(row.atMs).padStart(10);
  return `${String(row.id).padStart(5)}  ${when}  ${row.body}`;
}

function parseId(value: string): number | undefined {
  // Digits only: `Number("1e0")` is 1, and an id typed that way is a mistake
  // rather than a request — the same rule `rate` applies to its stars.
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

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
function parseMoment(value: string): number | undefined {
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
function timecode(ms: number): string {
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
