import { describe, expect, it } from "vitest";
import { bytes, rate, row, seconds } from "./format.js";

describe("sizes", () => {
  it("divides by 1024 and says MiB", () => {
    // The Rust CLI divides by 1024 twice and prints `MB`, so one library reads
    // as `445.3 MB` there and `467.0 MB` from a naive `bytes / 1e6`. Neither is
    // wrong and they do not disagree — 445.3 MiB *is* 467.0 MB — but two
    // implementations describing one library must not look like they do. The
    // exact strings are the test, because a unit label alone passes either way.
    expect(bytes(0)).toBe("0 B");
    expect(bytes(999)).toBe("999 B");
    expect(bytes(1023)).toBe("1023 B");
    expect(bytes(1024)).toBe("1.0 KiB");
    expect(bytes(1024 * 1024)).toBe("1.0 MiB");
    expect(bytes(467_000_000)).toBe("445.4 MiB");
    expect(bytes(1024 ** 4)).toBe("1.0 TiB");
  });
});

describe("times and rates", () => {
  it("keeps two decimals of a second, and rounds a rate to whole units", () => {
    expect(seconds(1060)).toBe("1.06s");
    expect(rate(19001, 1060)).toBe("17925");
  });

  it("declines to divide by no time at all", () => {
    // A command that finished inside the clock's resolution has no rate, and
    // `Infinity files/sec` helps nobody.
    expect(rate(10, 0)).toBe("—");
  });
});

describe("alignment", () => {
  it("indents two spaces per level and pads the label", () => {
    expect(row("assets", 3)).toBe("  assets      3");
    expect(row("managed", 2, 2)).toBe("    managed     2");
  });
});
