import { afterEach, describe, expect, it } from "vitest";
import {
  CollectingLogSink,
  isEnabled,
  jsonLine,
  LOG_LEVELS,
  type LogRecord,
  logger,
  prettyLine,
  setLogLevel,
  setSink,
} from "./index.js";

const record = (over: Partial<LogRecord> = {}): LogRecord => ({
  ts: Date.UTC(2026, 7, 25, 9, 41, 12, 345),
  level: "info",
  scope: "import",
  message: "placed an original",
  fields: {},
  ...over,
});

afterEach(() => {
  setSink(undefined);
  setLogLevel("info");
});

describe("emitting", () => {
  it("drops everything until a binary installs a sink", () => {
    // A library must not decide where its own output goes. With no sink, the
    // level check short-circuits and nothing is even formatted.
    setLogLevel("trace");
    expect(isEnabled("error")).toBe(false);
    logger("db").error("this goes nowhere");
  });

  it("writes what a sink is installed for and nothing below it", () => {
    const sink = new CollectingLogSink();
    setSink(sink);
    setLogLevel("info");

    const log = logger("import");
    log.trace("skipped");
    log.debug("skipped");
    log.info("kept");
    log.warn("kept");
    log.error("kept");

    expect(sink.records.map((r) => r.level)).toEqual(["info", "warn", "error"]);
    expect(sink.records[0]?.scope).toBe("import");
  });

  it("merges a child's bound fields under the call's own", () => {
    const sink = new CollectingLogSink();
    setSink(sink);

    const log = logger("import", { run: "a" }).child({ file: "x.png" });
    log.info("first");
    log.info("second", { file: "y.png" });

    expect(sink.records[0]?.fields).toEqual({ run: "a", file: "x.png" });
    // The call site wins, so a bound default can be overridden where it matters.
    expect(sink.records[1]?.fields).toEqual({ run: "a", file: "y.png" });
  });

  it("does not let one child's fields leak into its parent", () => {
    const sink = new CollectingLogSink();
    setSink(sink);

    const parent = logger("db", { library: "main" });
    parent.child({ query: "one" }).info("child");
    parent.info("parent");

    expect(sink.records[1]?.fields).toEqual({ library: "main" });
  });

  it("reports enablement so a hot loop can skip building fields", () => {
    setSink(new CollectingLogSink());
    setLogLevel("warn");
    expect(isEnabled("debug")).toBe(false);
    expect(isEnabled("warn")).toBe(true);
    expect(isEnabled("error")).toBe(true);
  });

  it("orders every level", () => {
    expect(LOG_LEVELS).toEqual(["trace", "debug", "info", "warn", "error"]);
  });
});

describe("formatting", () => {
  it("writes one JSON object per line, fields flattened alongside", () => {
    const line = jsonLine(record({ fields: { file: "x.png", bytes: 12 } }));
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      ts: Date.UTC(2026, 7, 25, 9, 41, 12, 345),
      level: "info",
      scope: "import",
      message: "placed an original",
      file: "x.png",
      bytes: 12,
    });
  });

  it("puts the time, the level, and the scope where an eye expects them", () => {
    expect(prettyLine(record({ fields: { file: "x.png" } }))).toBe(
      "09:41:12.345 INFO  import: placed an original file=x.png\n",
    );
  });

  it("leaves no trailing space when there are no fields", () => {
    expect(prettyLine(record())).toBe("09:41:12.345 INFO  import: placed an original\n");
  });
});
