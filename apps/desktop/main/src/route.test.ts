import { describe, expect, it } from "vitest";
import { parseRoostUrl } from "./route.js";

const HASH = "a".repeat(64);

/** The reason, or `null` when it parsed — so a table can assert both. */
function reasonFor(url: string): string | null {
  const checked = parseRoostUrl(url);
  return checked.ok ? null : checked.reason;
}

describe("parsing a roost:// URL", () => {
  it("reads the two routes ADR-0008 defines", () => {
    expect(parseRoostUrl(`roost://thumb/${HASH}@256`)).toEqual({
      ok: true,
      value: { kind: "thumb", hash: HASH, size: 256 },
    });
    expect(parseRoostUrl(`roost://thumb/${HASH}@512`)).toEqual({
      ok: true,
      value: { kind: "thumb", hash: HASH, size: 512 },
    });
    expect(parseRoostUrl(`roost://original/${HASH}`)).toEqual({
      ok: true,
      value: { kind: "original", hash: HASH },
    });
  });

  it("serves only the sizes the schema stores", () => {
    // A free-form size would be a request to generate a thumbnail nobody
    // stored, on main's thread, for a URL a renderer bug could mint by the
    // thousand.
    expect(reasonFor(`roost://thumb/${HASH}@257`)).toMatch(/no such thumbnail size/);
    expect(reasonFor(`roost://thumb/${HASH}@`)).toMatch(/no such thumbnail size/);
    expect(reasonFor(`roost://thumb/${HASH}`)).toMatch(/needs a @<size>/);
  });

  it("refuses anything that is not a content hash", () => {
    for (const bad of [
      "..",
      "../../etc/passwd",
      HASH.toUpperCase(),
      `${HASH}a`,
      HASH.slice(0, 63),
      "",
    ]) {
      expect(reasonFor(`roost://original/${bad}`)).toBe("not a content hash");
    }
  });

  it("refuses a traversal however it is spelled", () => {
    // The hash pattern is the path safety here: 64 lowercase hex characters
    // cannot contain a separator, encoded or not, so nothing downstream has to
    // re-check what this rejected.
    expect(reasonFor("roost://original/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd")).toBe("not a content hash");
    expect(reasonFor(`roost://original/${HASH}%2F..%2F${HASH}`)).toBe("not a content hash");
    expect(reasonFor("roost://original/../../etc/passwd")).toBe("not a content hash");
  });

  it("refuses a route nobody registered, and a scheme that is not ours", () => {
    expect(reasonFor(`roost://export/${HASH}`)).toMatch(/no such route/);
    expect(reasonFor(`file:///${HASH}`)).toMatch(/expected roost:/);
    expect(reasonFor("not a url at all")).toBe("not a URL");
  });
});

describe("parsing a page URL", () => {
  const HASH = "a".repeat(64);

  it("reads the hash, the page, and the width", () => {
    const route = parseRoostUrl(`roost://page/${HASH}/3@1024`);

    expect(route).toEqual({
      ok: true,
      value: { kind: "page", hash: HASH, index: 3, width: 1024 },
    });
  });

  it("refuses a width nobody registered", () => {
    // The same rule a thumbnail size follows, and for a sharper reason: pages
    // are rendered on demand, in the process that draws the window, so a
    // free-form width would let a renderer bug ask for a ten-thousand-pixel
    // page.
    expect(parseRoostUrl(`roost://page/${HASH}/0@4000`).ok).toBe(false);
  });

  it("refuses a page number that is not one", () => {
    expect(parseRoostUrl(`roost://page/${HASH}/-1@512`).ok).toBe(false);
    expect(parseRoostUrl(`roost://page/${HASH}/1.5@512`).ok).toBe(false);
    expect(parseRoostUrl(`roost://page/${HASH}/999999@512`).ok).toBe(false);
  });

  it("refuses a traversal dressed as a hash, like every other route", () => {
    expect(parseRoostUrl("roost://page/../../etc/passwd/0@512").ok).toBe(false);
  });

  it("needs both halves of the address", () => {
    expect(parseRoostUrl(`roost://page/${HASH}@512`).ok).toBe(false);
    expect(parseRoostUrl(`roost://page/${HASH}/0`).ok).toBe(false);
  });
});
