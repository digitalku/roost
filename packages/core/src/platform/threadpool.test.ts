import { availableParallelism } from "node:os";
import { describe, expect, it } from "vitest";
import { DEFAULT_THREAD_POOL, threadPoolEnv, threadPoolSize } from "./threadpool.js";

describe("sizing the pool a decoder runs on", () => {
  it("sizes a child's pool to the machine when nothing has been set", () => {
    const env = threadPoolEnv({ PATH: "/usr/bin" });

    expect(Number(env["UV_THREADPOOL_SIZE"])).toBe(Math.min(32, availableParallelism()));
    // The rest of the environment travels with it: a child that lost PATH would
    // be a child that cannot find ffmpeg.
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("leaves alone a value somebody set on purpose", () => {
    expect(threadPoolEnv({ UV_THREADPOOL_SIZE: "8" })["UV_THREADPOOL_SIZE"]).toBe("8");
  });

  it("treats an empty setting as no setting", () => {
    expect(threadPoolEnv({ UV_THREADPOOL_SIZE: "  " })["UV_THREADPOOL_SIZE"]).not.toBe("  ");
  });

  it("reports libuv's default when the variable says nothing usable", () => {
    // What this process actually got, which is what `roost doctor` prints.
    expect(threadPoolSize()).toBeGreaterThanOrEqual(DEFAULT_THREAD_POOL);
  });
});
