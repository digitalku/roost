import { describe, expect, it } from "vitest";
import { isContentHash, parseContentHash, shardOf } from "./content-hash.js";
import { InvalidContentHashError } from "./error.js";

const VALID = "a".repeat(64);

describe("isContentHash", () => {
  it("accepts 64 lowercase hex characters", () => {
    expect(isContentHash(VALID)).toBe(true);
    expect(isContentHash("0123456789abcdef".repeat(4))).toBe(true);
  });

  it("rejects the wrong length", () => {
    expect(isContentHash("a".repeat(63))).toBe(false);
    expect(isContentHash("a".repeat(65))).toBe(false);
    expect(isContentHash("")).toBe(false);
  });

  it("rejects uppercase rather than folding it", () => {
    // Two spellings of one hash would be two keys and one file: the hash is
    // also the on-disk filename, and a case-insensitive filesystem would
    // collide them.
    expect(isContentHash("A".repeat(64))).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isContentHash(`g${"a".repeat(63)}`)).toBe(false);
    expect(isContentHash(`${"a".repeat(63)} `)).toBe(false);
  });

  it("is not fooled by a newline, which a loose regex would allow", () => {
    // `/^[0-9a-f]{64}$/` without care matches "…\n" because `$` also matches
    // before a trailing newline. It does not here, and this is the test that
    // says so.
    expect(isContentHash(`${"a".repeat(64)}\n`)).toBe(false);
  });
});

describe("parseContentHash", () => {
  it("returns the hash when it is valid", () => {
    expect(parseContentHash(VALID)).toBe(VALID);
  });

  it("throws a coded error, carrying a bounded prefix of the input", () => {
    const bad = "Z".repeat(200);
    try {
      parseContentHash(bad);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidContentHashError);
      const wire = (error as InvalidContentHashError).toWire();
      expect(wire.code).toBe("invalid_content_hash");
      expect(wire.detail.length).toBe(200);
      expect(String(wire.detail.prefix)).toHaveLength(16);
    }
  });
});

describe("shardOf", () => {
  it("is the first two characters, and nothing more", () => {
    expect(shardOf(parseContentHash(`3f${"0".repeat(62)}`))).toBe("3f");
  });

  it("returns a directory name, never a path", () => {
    // Turning a hash into a path is reserved to a Storage implementation
    // (ARCHITECTURE.md invariant 2). If a separator ever appears here, that
    // rule has been broken in the one place it is easiest to break.
    expect(shardOf(parseContentHash(VALID))).not.toContain("/");
  });
});
