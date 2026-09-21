import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type AssetId, FILES_DIR, logger } from "@roost/core";
import type { Library } from "./library.js";
import { idFromPath } from "./locate.js";
import { refreshAsset } from "./refresh.js";

/**
 * Watching `files/` for the saves other applications make (ADR-0047 §2).
 *
 * The cost that makes this affordable is RL-8's sharding. `files/` is one level
 * deep with at most 1 024 directories, and a recursive watch costs a descriptor
 * **per directory** rather than per file — so a million-asset library is about
 * 1 025 inotify watches, well inside the usual `max_user_watches` of 8 192.
 *
 * `fs.watch(dir, { recursive: true })` has worked on Linux since Node 20 and
 * both runtimes here are past it (ADR-0011), so this adds no dependency.
 *
 * **A watcher is an optimisation over a sweep, not a guarantee.** Every
 * platform drops events under load, and the recursive implementation on Linux
 * is a userspace walk that can miss a directory created while it is walking.
 * `catchUp` on open is the backstop and `roost thumb` is the manual one.
 */

const log = logger("watch");

/**
 * How long an id must be quiet before its file is read.
 *
 * An application writing a large file produces events throughout the write, and
 * re-deriving from a half-written file is work that will be undone by the event
 * that follows it. Restarted by each event for that id, so a slow write is one
 * derive at the end rather than one per chunk.
 */
const QUIET_MS = 400;

export interface WatchOptions {
  readonly signal?: AbortSignal;
  /** Fired after an asset's file turned out to have changed. */
  readonly onChanged?: (id: AssetId) => void;
  /** Overrides the debounce. Tests use it; nothing else should. */
  readonly quietMs?: number;
}

export interface FileWatcher {
  /** Stops watching. Safe to call twice. */
  close(): void;
  /** Resolves once every pending change has been handled. For tests. */
  settled(): Promise<void>;
}

/**
 * Starts watching a library's `files/` directory.
 *
 * Returns immediately; nothing here blocks an open. A platform whose `fs.watch`
 * refuses recursion is logged and left alone rather than fatal — the library
 * still works, it just catches up at the next open, which is precisely what
 * `ops/REGISTRY.md` calls conforming.
 */
export async function watchFiles(
  library: Library,
  options: WatchOptions = {},
): Promise<FileWatcher> {
  const dir = join(library.root, FILES_DIR);
  // A library with nothing imported yet has no files/ to watch, and watching
  // the root instead would wake on every journal append and every index write.
  await mkdir(dir, { recursive: true }).catch(() => {});

  const quiet = options.quietMs ?? QUIET_MS;
  const timers = new Map<AssetId, NodeJS.Timeout>();
  const inFlight = new Set<Promise<void>>();
  let closed = false;

  const handle = (id: AssetId): void => {
    const existing = timers.get(id);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
      timers.delete(id);
      if (closed) return;

      const work = refreshAsset(library, id)
        .then((outcome) => {
          if (outcome.kind === "changed") options.onChanged?.(id);
        })
        .catch((error: unknown) => {
          // A library closed underneath a pending timer is the ordinary way
          // this fails, and it is not worth an error line.
          log.debug("could not refresh a changed file", { asset: id, error: String(error) });
        })
        .finally(() => {
          inFlight.delete(work);
        });
      inFlight.add(work);
    }, quiet);

    // Node keeps the process alive for a pending timer, and a CLI command that
    // happens to watch should still exit when its work is done.
    timer.unref?.();
    timers.set(id, timer);
  };

  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(dir, { recursive: true }, (_event, filename) => {
      if (filename === null || closed) return;
      const id = idFromPath(filename);
      // RL-11: a name that is not an id is somebody else's lock file. Not
      // adopted, not deleted, and here not even woken up for.
      if (id !== undefined) handle(id);
    });
    watcher.on("error", (error) => {
      log.warn("the file watcher stopped", { error: String(error) });
    });
  } catch (error) {
    log.warn("this platform will not watch files/ recursively; catching up at open instead", {
      error: String(error),
    });
  }

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    watcher?.close();
  };

  options.signal?.addEventListener("abort", close, { once: true });

  return {
    close,
    async settled(): Promise<void> {
      // Two rounds: a timer that fires during the first wait adds work the
      // first `Promise.all` has already snapshotted.
      for (let round = 0; round < 2; round += 1) {
        await new Promise((resume) => setTimeout(resume, quiet + 20));
        await Promise.all([...inFlight]);
      }
    },
  };
}
