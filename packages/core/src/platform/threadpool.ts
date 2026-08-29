import { availableParallelism } from "node:os";

/**
 * libuv's threadpool, and the one honest thing that can be done about it.
 *
 * `sharp` decodes and encodes on that pool, and the default of four is a
 * ceiling on every derive pass: measured at **205 thumbnails/sec at the default
 * against 252–327/sec at the core count**, on the same 1,301-image corpus with
 * a warm cache.
 *
 * **It cannot be raised from inside the process that wants it.** libuv reads
 * `UV_THREADPOOL_SIZE` once and creates the pool on first use, and by the time
 * an entry point runs, module loading has already used it. Setting the variable
 * at the top of `main.ts` measured **181/sec against 205/sec for the plain
 * default** — noise around no effect at all, which is exactly what a placebo
 * looks like when it is measured instead of assumed.
 *
 * `ARCHITECTURE.md` §3.3 said the engine raised it at start. Nothing did, and
 * nothing could. What works is setting it for a process that has not started
 * yet, which is what {@link threadPoolEnv} is for: main forks the engine, so
 * main is where this is decided.
 *
 * **It is not a general setting.** Image work does real CPU work on those
 * threads; a `stat` or a `rename` does not, and the import pipeline measured
 * *slower* at 32 workers with the pool widened (`import.ts`).
 */

/** The most the pool is widened to. libuv's own ceiling is 1024. */
const MAX_THREADS = 32;

/** libuv's default, and what a process gets when nothing has been set. */
export const DEFAULT_THREAD_POOL = 4;

/** What this process's pool was sized at, as far as the environment says. */
export function threadPoolSize(): number {
  const set = Number.parseInt(process.env["UV_THREADPOOL_SIZE"] ?? "", 10);
  return Number.isInteger(set) && set > 0 ? set : DEFAULT_THREAD_POOL;
}

/**
 * The environment to fork a decoding process with.
 *
 * A value the user already set is kept: someone who set this was tuning
 * something, and a library that overrode them would be the reason their tuning
 * did nothing.
 */
export function threadPoolEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const existing = base["UV_THREADPOOL_SIZE"];
  if (existing !== undefined && existing.trim() !== "") return { ...base };

  const size = Math.max(DEFAULT_THREAD_POOL, Math.min(MAX_THREADS, availableParallelism()));
  return { ...base, UV_THREADPOOL_SIZE: String(size) };
}
