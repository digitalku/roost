import type { CommentRow } from "@roost/core";
import { addComment, comments as listComments, removeComment, setComment } from "@roost/library";
import { resolveAll, short } from "../assets.js";
import { EXIT, type Streams, usage } from "../io.js";
import { parseMoment, timecode } from "../moment.js";
import { withLibrary } from "../open.js";

/**
 * Comments, which carry a moment (ADR-0023).
 *
 * The CLI has a verb for every user-authored mutation, so that nothing is
 * writable only from the window (ADR-0005) — and so that the rebuild test has a
 * way to author one without a GUI.
 */

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
