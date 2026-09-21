import { describe, expect, it } from "vitest";
import { parseRoostUrl } from "./route.js";

const ID = "K7QM4X2AJH9F";

/** The reason, or `null` when it parsed — so a table can assert both. */
function reasonFor(url: string): string | null {
  const checked = parseRoostUrl(url);
  return checked.ok ? null : checked.reason;
}

describe("parsing a roost:// URL", () => {
  it("reads the two routes ADR-0008 defines", () => {
    expect(parseRoostUrl(`roost://thumb/${ID}@256`)).toEqual({
      ok: true,
      value: { kind: "thumb", id: ID, size: 256 },
    });
    expect(parseRoostUrl(`roost://thumb/${ID}@512`)).toEqual({
      ok: true,
      value: { kind: "thumb", id: ID, size: 512 },
    });

    expect(parseRoostUrl(`roost://file/${ID}`)).toEqual({
      ok: true,
      value: { kind: "file", id: ID },
    });
  });

  it("ignores a query, which is a cache key rather than an address", () => {
    // A pinned frame changes a thumbnail's pixels without changing its id
    // (ADR-0024 stage 4), so the renderer puts the moment in the query — the
    // response stays `immutable`, and a new frame is a new address. Nothing
    // here reads it: what is addressed is still the id and the size.
    expect(parseRoostUrl(`roost://thumb/${ID}@256?at=91500`)).toEqual({
      ok: true,
      value: { kind: "thumb", id: ID, size: 256 },
    });
  });

  it("serves only the sizes the schema stores", () => {
    // A free-form size would be a request to generate a thumbnail nobody
    // stored, on main's thread, for a URL a renderer bug could mint by the
    // thousand.
    expect(reasonFor(`roost://thumb/${ID}@257`)).toMatch(/no such thumbnail size/);
    expect(reasonFor(`roost://thumb/${ID}@`)).toMatch(/no such thumbnail size/);
    expect(reasonFor(`roost://thumb/${ID}`)).toMatch(/needs a @<size>/);
  });

  it("refuses anything that is not an asset id", () => {
    for (const bad of ["..", "../../etc/passwd", ID.toLowerCase(), `${ID}a`, ID.slice(0, 11), ""]) {
      expect(reasonFor(`roost://file/${bad}`)).toBe("not an asset id");
    }
  });

  it("refuses a traversal however it is spelled", () => {
    // The id pattern is the path safety here: twelve characters of Crockford
    // base32 (RL-14) cannot contain a separator, encoded or not, so nothing
    // downstream has to re-check what this rejected.
    expect(reasonFor("roost://file/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd")).toBe("not an asset id");
    expect(reasonFor(`roost://file/${ID}%2F..%2F${ID}`)).toBe("not an asset id");
    expect(reasonFor("roost://file/../../etc/passwd")).toBe("not an asset id");
  });

  it("refuses a route nobody registered, and a scheme that is not ours", () => {
    expect(reasonFor(`roost://export/${ID}`)).toMatch(/no such route/);
    expect(reasonFor(`file:///${ID}`)).toMatch(/expected roost:/);
    expect(reasonFor("not a url at all")).toBe("not a URL");
  });
});

describe("parsing a page URL", () => {
  it("reads the id, the page, and the width", () => {
    const route = parseRoostUrl(`roost://page/${ID}/3@1024`);

    expect(route).toEqual({
      ok: true,
      value: { kind: "page", id: ID, index: 3, width: 1024 },
    });
  });

  it("refuses a width nobody registered", () => {
    // The same rule a thumbnail size follows, and for a sharper reason: pages
    // are rendered on demand, in the process that draws the window, so a
    // free-form width would let a renderer bug ask for a ten-thousand-pixel
    // page.
    expect(parseRoostUrl(`roost://page/${ID}/0@4000`).ok).toBe(false);
  });

  it("refuses a page number that is not one", () => {
    expect(parseRoostUrl(`roost://page/${ID}/-1@512`).ok).toBe(false);
    expect(parseRoostUrl(`roost://page/${ID}/1.5@512`).ok).toBe(false);
    expect(parseRoostUrl(`roost://page/${ID}/999999@512`).ok).toBe(false);
  });

  it("refuses a traversal dressed as an id, like every other route", () => {
    expect(parseRoostUrl("roost://page/../../etc/passwd/0@512").ok).toBe(false);
  });

  it("needs both halves of the address", () => {
    expect(parseRoostUrl(`roost://page/${ID}@512`).ok).toBe(false);
    expect(parseRoostUrl(`roost://page/${ID}/0`).ok).toBe(false);
  });
});

describe("a rendition's address", () => {
  it("takes an id and nothing else", () => {
    // A route of its own because what comes back is not the file's bytes
    // (ADR-0040 §7): HEIC assembled, a RAW's embedded JPEG, a TIFF re-encoded.
    expect(parseRoostUrl(`roost://render/${ID}`)).toEqual({
      ok: true,
      value: { kind: "render", id: ID },
    });
  });

  it("refuses anything that is not an id", () => {
    expect(parseRoostUrl("roost://render/../../etc/passwd").ok).toBe(false);
  });
});
