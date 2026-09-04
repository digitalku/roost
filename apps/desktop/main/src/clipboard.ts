import { fileURLToPath } from "node:url";

/**
 * Reading what a desktop leaves on the clipboard (ADR-0026 §5).
 *
 * Pure, and therefore testable: the Electron `clipboard` is main's, but what
 * its strings *mean* is a parsing problem that has nothing to do with Electron
 * — and the shapes here are exactly the ones that differ between desktops.
 */

/**
 * File paths from a clipboard's URI list.
 *
 * Two spellings, because two desktops disagree. `text/uri-list` is the standard
 * one, where `#` starts a comment. GNOME writes `x-special/gnome-copied-files`
 * with an **operation on the first line** — `copy` or `cut` — and URIs after
 * it, so a parser that took every line would import a file called `copy`.
 *
 * Anything that is not a `file://` URI is dropped rather than guessed at: a
 * `http://` URI on the clipboard is a link, and links are not fetched here
 * (invariant 7).
 */
export function pathsFromUriList(list: string): string[] {
  const paths: string[] = [];
  for (const line of list.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    // GNOME's operation line, and anything else that is not a URI at all.
    if (!trimmed.startsWith("file://")) continue;
    try {
      const path = fileURLToPath(trimmed);
      // `file://` and `file:///` both resolve to the root, and an import of the
      // root is a walk of the whole filesystem. Never what a paste meant, and
      // far too expensive to find out by trying.
      if (path === "/") continue;
      paths.push(path);
    } catch {
      // A URI this platform cannot spell as a path is one file skipped, not a
      // paste that fails.
    }
  }
  return paths;
}

/**
 * Whether pasted text is a link rather than words.
 *
 * The distinction matters because the two are different gestures: text becomes
 * a draft, and a link becomes nothing at all — invariant 7 permits exactly one
 * network operation, an explicit user-initiated import from a URL, and a fetch
 * triggered by `Ctrl+V` is what that rule exists to forbid.
 *
 * Whitespace disqualifies it: a sentence with a URL in it is a sentence.
 */
export function isHttpUrl(text: string): boolean {
  if (text === "" || /\s/.test(text)) return false;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** `2026-09-04 14.22.08` — sorts, and contains nothing a filesystem minds. */
export function pastedName(now: Date, ext: string): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  return `Pasted ${stamp}.${ext}`;
}
