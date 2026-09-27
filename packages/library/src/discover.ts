import { opendir, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { mapWithConcurrency } from "./concurrency.js";

/**
 * Streams every importable file under `sources`.
 *
 * **Never collects the tree first.** A million-file import must not need a
 * million path strings resident before the first asset is written, so this is
 * an async generator all the way down and the caller consumes it as it walks
 * (`CLAUDE.md` §8).
 *
 * Depth-first with an explicit stack rather than recursion: a deep tree would
 * otherwise be bounded by the call stack, and a recursive async generator pays
 * a `yield*` delegation per level for every file underneath it.
 */
export async function* discover(
  sources: readonly string[],
  libraryRoot: string,
  includeHidden = false,
): AsyncGenerator<string> {
  // Importing a library into itself would walk `files/` and re-import every
  // object under a new name.
  const root = await realpath(libraryRoot).catch(() => resolve(libraryRoot));

  for (const source of sources) {
    const start = resolve(source);
    if (isInside(start, root)) continue;

    let entry: Awaited<ReturnType<typeof stat>>;
    try {
      entry = await stat(start);
    } catch {
      // A source that cannot be read at all is skipped rather than fatal: one
      // unreadable directory in a list of ten must not lose the other nine.
      continue;
    }

    if (entry.isFile()) {
      // A file named on the command line is imported even if it is hidden. The
      // user pointed at it; the rule is for what a walk turns up on its own.
      yield start;
      continue;
    }
    if (!entry.isDirectory()) continue;

    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;

      let dir: Awaited<ReturnType<typeof opendir>>;
      try {
        dir = await opendir(current);
      } catch {
        continue;
      }

      try {
        for await (const child of dir) {
          const path = join(current, child.name);
          if (!includeHidden && isHidden(child.name)) continue;
          if (isInside(path, root)) continue;
          // Symlinks are not followed, so a link back into the tree cannot make
          // the walk cycle, and a link into a library cannot smuggle it in.
          if (child.isDirectory()) stack.push(path);
          else if (child.isFile()) yield path;
        }
      } catch {
        // A directory that becomes unreadable mid-walk ends there.
      }
    }
  }
}

/** What a walk found, before anything is read (ADR-0055 §3.1). */
export interface Measured {
  readonly files: number;
  readonly bytes: number;
}

/** Paths stated per window of a {@link measure}, as the import drains its walk. */
const MEASURE_WINDOW = 500;

/** `stat`s in flight at once: eight took `/usr` from 4.1 s to 2.3 s (ADR-0055 §3.1). */
const MEASURE_CONCURRENCY = 8;

/**
 * Counts what {@link discover} would yield, and adds up its sizes.
 *
 * The first of an import's two walks, so that its bar has a total from the
 * start. It keeps two numbers and no paths, for the reason `discover` streams.
 * A file that cannot be stated is counted with no size: the import will find
 * it the same way, and fail it there, where the failure is reported.
 *
 * Stops between windows when `signal` is aborted, and answers what it had.
 */
export async function measure(
  sources: readonly string[],
  libraryRoot: string,
  includeHidden: boolean,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly onProgress?: ((measured: Measured) => void) | undefined;
  } = {},
): Promise<Measured> {
  let files = 0;
  let bytes = 0;
  const walker = discover(sources, libraryRoot, includeHidden);
  try {
    for (;;) {
      if (options.signal?.aborted === true) break;
      const window: string[] = [];
      while (window.length < MEASURE_WINDOW) {
        const next = await walker.next();
        if (next.done === true) break;
        window.push(next.value);
      }
      if (window.length === 0) break;
      const sizes = await mapWithConcurrency(window, MEASURE_CONCURRENCY, (path) =>
        stat(path).then(
          (info) => info.size,
          () => 0,
        ),
      );
      files += window.length;
      for (const size of sizes) bytes += size;
      options.onProgress?.({ files, bytes });
    }
  } finally {
    await walker.return(undefined);
  }
  return { files, bytes };
}

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

/**
 * Whether `path` is the library root or lives beneath it.
 *
 * The separator matters: a prefix test alone would also exclude a sibling
 * directory whose name merely starts with the library's, so `~/Photos` next to
 * a library at `~/Photo` would import nothing and say nothing.
 */
function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}
