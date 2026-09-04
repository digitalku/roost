import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ledger } from "./checks.mjs";
import { freePort } from "./window.mjs";

const exitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  // `report()` is meant to set this, which in a test run would fail the run.
  process.exitCode = exitCode;
});

function silently(run) {
  const lines = [];
  vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
  const value = run();
  return { lines, value };
}

describe("ledger", () => {
  it("counts what passed and what did not", () => {
    const { lines } = silently(() => {
      const { check, report } = ledger();
      check("one", true);
      check("two", false, "saw nothing");
      report();
    });
    expect(lines).toContain("  ok    one");
    expect(lines).toContain("  FAIL  two   saw nothing");
    expect(lines.at(-1)).toBe("1 of 2 checks failed");
  });

  it("fails the process when a check fails, and only then", () => {
    silently(() => {
      const { check, report } = ledger();
      check("one", true);
      report();
    });
    expect(process.exitCode).toBeUndefined();

    silently(() => {
      const { check, report } = ledger();
      check("one", false);
      report();
    });
    expect(process.exitCode).toBe(1);
  });

  it("reports every check when they all pass", () => {
    const { lines } = silently(() => {
      const { check, report } = ledger();
      check("one", true);
      check("two", true);
      report();
    });
    expect(lines.at(-1)).toBe("all 2 checks passed");
  });

  it("keeps the first section flush and separates the rest", () => {
    const { lines } = silently(() => {
      const { check, section } = ledger();
      section("first");
      check("one", true);
      section("second");
    });
    expect(lines[0]).toBe("first");
    expect(lines[2]).toBe("\nsecond");
  });
});

describe("freePort", () => {
  // The reason this exists: `9500 + pid % 100` collided between two scripts for
  // any two processes a hundred apart, and the second one then attached to the
  // first one's window and asserted against the wrong application.
  //
  // What is asserted is that the port is free, not that two calls differ: once
  // the probe socket is closed the kernel may hand the same number back, and a
  // test that forbids it would fail for the right reason on the wrong day.
  it("hands out a port that can then be listened on", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(1024);
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    await new Promise((resolve) => server.close(resolve));
  });
});
