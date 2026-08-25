import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileSink, teeSink } from "./file.js";
import { CollectingLogSink, type LogRecord } from "./index.js";

const record = (message: string): LogRecord => ({
  ts: Date.UTC(2026, 7, 26, 12, 0, 0),
  level: "info",
  scope: "test",
  message,
  fields: { count: 2 },
});

describe("the file sink", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-log-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes one JSON object per line, and writes it now", async () => {
    // Synchronously, on purpose: a buffered stream loses its tail when the
    // process dies, and the process dying is the case a log exists for. So the
    // line is readable before anything is closed.
    const sink = fileSink(dir, () => new Date(Date.UTC(2026, 7, 26)));
    sink.write(record("first"));

    const written = await readFile(join(dir, "roost-2026-08-26.log"), "utf8");
    expect(JSON.parse(written.trim())).toEqual({
      ts: Date.UTC(2026, 7, 26, 12, 0, 0),
      level: "info",
      scope: "test",
      message: "first",
      count: 2,
    });

    sink.close();
  });

  it("starts a new file when the day changes", async () => {
    let today = new Date(Date.UTC(2026, 7, 26));
    const sink = fileSink(dir, () => today);

    sink.write(record("yesterday"));
    today = new Date(Date.UTC(2026, 7, 27));
    sink.write(record("today"));
    sink.close();

    expect(await readFile(join(dir, "roost-2026-08-26.log"), "utf8")).toContain("yesterday");
    expect(await readFile(join(dir, "roost-2026-08-27.log"), "utf8")).toContain("today");
  });

  it("does not take the application down when it cannot write", () => {
    const sink = fileSink(dir);
    sink.close();
    // Closed, so the descriptor is gone and the next write reopens it. Even a
    // directory that vanished must not throw into the caller: there is nowhere
    // to report a logging failure to except the log.
    expect(() => sink.write(record("after close"))).not.toThrow();
  });
});

describe("the tee sink", () => {
  it("writes to every sink, in order", () => {
    const first = new CollectingLogSink();
    const second = new CollectingLogSink();

    teeSink(first, second).write(record("both"));

    expect(first.records.map((r) => r.message)).toEqual(["both"]);
    expect(second.records.map((r) => r.message)).toEqual(["both"]);
  });
});
