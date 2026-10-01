import { type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type AssetId, FILES_DIR, logger, makeDirectoryInside } from "@roost/core";
import type { Library } from "./library.js";
import { idFromPath } from "./locate.js";
import { refreshAsset } from "./refresh.js";

/**
 * Watching `files/` for the saves other applications make (ADR-0047 §2).
 *
 * The cost that makes this affordable is RL-8's sharding. `files/` is one level
 * deep with at most 1 024 directories, and inotify costs a descriptor **per
 * directory** rather than per file — so a million-asset library is about 1 025
 * watches, well inside the usual `max_user_watches` of 8 192.
 *
 * **On Linux those watches are placed here, one per directory, and not by
 * `fs.watch(dir, { recursive: true })`.** Node's recursive watch on Linux is a
 * userspace walk, and it walks every *file* synchronously before it returns:
 * measured on 2026-09-24 at 1 334 ms on Node 22 and 1 116 ms on Electron's Node
 * 24 over 100 000 files, with the event loop blocked for all of it. That is the
 * engine unable to answer `library:open`, or anything after it, for a second
 * at a hundred thousand assets and ten at a million. One level of sharding
 * needs no walk: list `files/`, watch each directory in it, and watch `files/`
 * itself for the directories created later. macOS and Windows recurse in the
 * kernel, so they keep the one recursive watch.
 *
 * **A watcher is an optimisation over a sweep, not a guarantee.** Every
 * platform drops events under load, and a directory created between the list
 * and its watch is caught only by the files it is found holding afterwards.
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
  await makeDirectoryInside(library.root, dir).catch(() => {});

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

  const onEvent = (filename: string | null): void => {
    if (filename === null || closed) return;
    const id = idFromPath(filename);
    // RL-11: a name that is not an id is somebody else's lock file. Not
    // adopted, not deleted, and here not even woken up for.
    if (id !== undefined) handle(id);
  };

  const watchers = new Map<string, FSWatcher>();
  const stopped = (name: string, error: unknown): void => {
    log.warn("the file watcher stopped", { directory: name, error: String(error) });
    watchers.get(name)?.close();
    watchers.delete(name);
  };

  /** Watches one shard directory, and says whether that took. */
  const watchShard = (name: string): boolean => {
    if (closed || watchers.has(name)) return false;
    try {
      const watcher = watch(join(dir, name), (_event, filename) => onEvent(filename));
      watcher.on("error", (error) => stopped(name, error));
      watchers.set(name, watcher);
      return true;
    } catch {
      // Gone between the listing and the watch, or not a directory at all —
      // a stray file in `files/` is somebody else's (RL-11) and not ours to
      // watch.
      return false;
    }
  };

  try {
    if (process.platform === "linux") {
      const root = watch(dir, (_event, name) => {
        if (name === null || closed || watchers.has(name)) return;
        // A shard directory appearing, most likely — or a stray file, which
        // `fs.watch` would watch just as happily. A new directory's first files
        // may have landed before its watch did, so they are handed over as
        // changes: a refresh that finds nothing different costs a `stat`.
        const path = join(dir, name);
        void stat(path)
          .then(async (found) => {
            if (!found.isDirectory() || !watchShard(name)) return;
            for (const file of await readdir(path)) onEvent(file);
          })
          .catch(() => {});
      });
      root.on("error", (error) => stopped(".", error));
      watchers.set(".", root);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) watchShard(entry.name);
      }
    } else {
      const recursive = watch(dir, { recursive: true }, (_event, filename) => onEvent(filename));
      recursive.on("error", (error) => stopped(".", error));
      watchers.set(".", recursive);
    }
  } catch (error) {
    log.warn("this platform will not watch files/; catching up at open instead", {
      error: String(error),
    });
  }

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
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
