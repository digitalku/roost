import { unlinkSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Blake3Hasher } from "@napi-rs/blake-hash";
import { IoError } from "../model/index.js";
import { lockDir } from "./dirs.js";

/**
 * Keeping two Roost processes off one library.
 *
 * SQLite in WAL mode tolerates concurrent processes, so this is not about
 * database corruption. It is about everything above the database that assumes
 * it is alone: a journal writer holding an open handle and a month boundary, an
 * import deduplicating against a batch only it can see, and a rebuild that
 * deletes `index.db` out from under whatever else is reading it.
 *
 * The mechanism is a PID file and it is **advisory**. A determined caller can
 * ignore it; its job is to catch the honest mistake of opening a library twice.
 *
 * The file lives in `stateDir()/locks`, keyed by a hash of the library's
 * canonical path — **not** inside the library, because the binding layout has
 * no room for a fifth entry, and because a pid only means something on the
 * machine that issued it.
 *
 * Keying on the path rather than on `library.json`'s id is deliberate: a user
 * who copies a library gets two directories carrying one id, and they are
 * separate libraries from that moment on.
 */

/** A held lock. Call {@link release} to give it up. */
export interface InstanceLock {
  readonly path: string;
  release(): Promise<void>;
}

/** What happened when a lock was requested. */
export type LockOutcome =
  | { readonly kind: "acquired"; readonly lock: InstanceLock }
  | { readonly kind: "busy"; readonly pid: number };

/**
 * Where the lock for `libraryRoot` lives. Creates nothing.
 *
 * The path is canonicalised first, so two routes to one library — a symlink, a
 * relative path, a bind mount — agree on the same lock.
 *
 * **The derivation matches the Rust implementation exactly**: BLAKE3 over the
 * canonical path's bytes, lowercase hex, `.pid`. That is what lets the two
 * builds lock each other out of a library rather than both believing they are
 * alone, and `platform.test.ts` pins it against three lock files `roost-old`
 * actually left behind.
 *
 * The one place they can disagree is a path that is not valid UTF-8: Rust
 * hashes the raw OS bytes, and Node has already lost them to replacement
 * characters by the time a string exists.
 */
export async function lockPathFor(libraryRoot: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(libraryRoot);
  } catch (cause) {
    throw new IoError("canonicalize", libraryRoot, cause);
  }

  // Hashed rather than encoded: a path can be longer than a filename may be,
  // and it carries separators that a filename may not.
  const hasher = new Blake3Hasher();
  hasher.update(Buffer.from(canonical, "utf8"));
  return join(lockDir(), `${hasher.digest("hex")}.pid`);
}

/**
 * Tries to take the lock for `libraryRoot`.
 *
 * A lock file left behind by a crash is **taken over**, not treated as held:
 * refusing to open a library because a previous run was killed is a worse
 * failure than the one this guards against.
 */
export async function acquireLock(libraryRoot: string): Promise<LockOutcome> {
  const path = await lockPathFor(libraryRoot);
  try {
    await mkdir(lockDir(), { recursive: true });
  } catch (cause) {
    throw new IoError("mkdir", lockDir(), cause);
  }
  return acquireLockAt(path);
}

/**
 * The mechanism, separated from where the file lives so it can be tested
 * without writing into the developer's real state directory.
 */
export async function acquireLockAt(path: string): Promise<LockOutcome> {
  const pid = await holder(path);

  // Our own pid in the file cannot mean another process holds the library: it
  // means this process already does. A desktop shell reopening the library it
  // currently has open would otherwise refuse itself forever.
  if (pid !== undefined && pid !== process.pid && processIsAlive(pid)) {
    return { kind: "busy", pid };
  }

  try {
    // Not an exclusive create: a stale file is expected and must be taken over,
    // and the liveness check above is what actually decides.
    await writeFile(path, String(process.pid), "utf8");
  } catch (cause) {
    throw new IoError("write", path, cause);
  }

  let released = false;
  // JavaScript has no destructor, so release is explicit — the same contract
  // `Journal.close()` carries. The exit hook is a safety net for the ordinary
  // path, not a substitute: it does not run on a signal or a crash, which is
  // exactly why a stale lock has to be recoverable in the first place.
  const onExit = (): void => {
    if (!released) {
      released = true;
      // The one synchronous call in this module, because an exit handler
      // cannot await and a promise scheduled here never runs.
      try {
        unlinkSync(path);
      } catch {
        // A stale lock is recoverable; a throw here would mask the real exit.
      }
    }
  };
  process.once("exit", onExit);

  return {
    kind: "acquired",
    lock: {
      path,
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        process.removeListener("exit", onExit);
        await rm(path, { force: true });
      },
    },
  };
}

/** The pid recorded in a lock file, if it holds one that parses. */
async function holder(path: string): Promise<number | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new IoError("read", path, cause);
  }

  const pid = Number(contents.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Whether a process is still running.
 *
 * Signal 0 checks for existence without delivering anything. `EPERM` means the
 * process exists and belongs to someone else, which is still "alive" — treating
 * it as dead would let two users fight over one library on a shared machine.
 *
 * Known limit, inherited rather than introduced: pids are reused, so a very old
 * lock file can name a live but unrelated process. The cost is refusing to open
 * a library until one file is deleted, which is the safe direction.
 */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
