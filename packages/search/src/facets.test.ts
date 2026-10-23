import { describe, expect, it } from "vitest";
import {
  type Facets,
  joinQuery,
  NO_FACETS,
  placeFolder,
  splitQuery,
  subfolderSections,
  withSubfolders,
} from "./facets.js";
import { parse } from "./parser.js";

/**
 * The bar over the grid is a view of the query (ADR-0035), so what is under
 * test throughout is that reading and writing agree: a query the bar can
 * represent must survive a round trip, and one it cannot must be left alone.
 */

const facets = (over: Partial<Facets> = {}): Facets => ({ ...NO_FACETS, ...over });

describe("reading a query", () => {
  it("finds nothing in an empty query", () => {
    const nothing = { place: "", facets: NO_FACETS, subfolders: null, representable: true };
    expect(splitQuery("")).toEqual(nothing);
    expect(splitQuery("   ")).toEqual(nothing);
  });

  it("takes one tag, one rating, one extension", () => {
    expect(splitQuery("tag:wood").facets.tags).toEqual(["wood"]);
    expect(splitQuery("rating:4").facets.stars).toEqual([4]);
    expect(splitQuery("is:unrated").facets.unrated).toBe(true);
    expect(splitQuery("ext:png").facets.exts).toEqual(["png"]);
  });

  it("takes several of one facet out of an OR", () => {
    const split = splitQuery("(tag:wood OR tag:metal)");
    expect(split.facets.tags).toEqual(["wood", "metal"]);
    expect(split.place).toBe("");
    expect(split.representable).toBe(true);
  });

  it("reads unrated as part of the rating facet without making it a rating", () => {
    const split = splitQuery("(rating:5 OR is:unrated)");
    expect(split.facets.stars).toEqual([5]);
    expect(split.facets.unrated).toBe(true);
  });

  it("keeps everything else in the place, spelled the way it was typed", () => {
    // The reason the place is a slice of the source and not a reprinted tree:
    // the AST holds 2mb as 2097152 and the date as two timestamps, so anything
    // that printed the tree back would return a query nobody wrote.
    const split = splitQuery('beach size:>2mb created:2024-03-01 folder:"Design/Icons" tag:wood');
    expect(split.place).toBe('beach size:>2mb created:2024-03-01 folder:"Design/Icons"');
    expect(split.facets.tags).toEqual(["wood"]);
    expect(split.representable).toBe(true);
  });

  it("leaves a negated tag alone", () => {
    // `-tag:wip` means "not this", and the bar has no way to draw that. It
    // stays in the place, where somebody can read it.
    const split = splitQuery("-tag:wip tag:wood");
    expect(split.place).toBe("-tag:wip");
    expect(split.facets.tags).toEqual(["wood"]);
  });

  it("leaves a rating range alone", () => {
    // The bar's rows are one rating each, as the sidebar's were. `rating:>=4`
    // is a different question and stays where it can be read.
    const split = splitQuery("rating:>=4");
    expect(split.place).toBe("rating:>=4");
    expect(split.facets.stars).toEqual([]);
  });

  it("reads two tag terms as the all rule", () => {
    // ADR-0035 §7. `tag:a tag:b` asks for both, and until 2026-09-08 the bar
    // refused it rather than turn the AND into an OR. The refusal is now the
    // feature: the two shapes the splitter already told apart are the two rules.
    const split = splitQuery("tag:a tag:b");
    expect(split.representable).toBe(true);
    expect(split.facets.tags).toEqual(["a", "b"]);
    expect(split.facets.tagRule).toBe("all");
    expect(split.place).toBe("");
  });

  it("reads one OR of tags as the any rule", () => {
    const split = splitQuery("(tag:a OR tag:b)");
    expect(split.facets.tagRule).toBe("any");
    expect(split.facets.tags).toEqual(["a", "b"]);
  });

  it("says any for a single tag, which is the same query either way", () => {
    // Nothing in `tag:a` distinguishes the rules, so the window remembers the
    // choice and this reports the one that spells it (ADR-0035 §7.2).
    expect(splitQuery("tag:a").facets.tagRule).toBe("any");
    expect(splitQuery("").facets.tagRule).toBe("any");
  });

  it("refuses a tag facet that is half an OR and half an AND", () => {
    // `(tag:a OR tag:b) tag:c` is neither rule, and picking one would ask a
    // different question than the one that was typed.
    const split = splitQuery("(tag:a OR tag:b) tag:c");
    expect(split.representable).toBe(false);
    expect(split.facets.tags).toEqual([]);
    expect(split.place).toBe("(tag:a OR tag:b) tag:c");
  });

  it("still refuses two ratings and two extensions", () => {
    // An asset has one of each, so both match nothing — and a bar drawing them
    // as chosen would describe an empty grid as a filter (ADR-0035 §7.1).
    const ratings = splitQuery("rating:5 rating:3");
    expect(ratings.representable).toBe(false);
    expect(ratings.place).toBe("rating:5 rating:3");

    const exts = splitQuery("ext:png ext:jpg");
    expect(exts.representable).toBe(false);
    expect(exts.place).toBe("ext:png ext:jpg");
  });

  it("refuses a top-level OR", () => {
    const split = splitQuery("tag:wood OR ext:png");
    expect(split.representable).toBe(false);
    expect(split.facets).toEqual(NO_FACETS);
    expect(split.place).toBe("tag:wood OR ext:png");
  });

  it("refuses an OR that mixes two facets", () => {
    const split = splitQuery("(tag:wood OR ext:png)");
    expect(split.facets).toEqual(NO_FACETS);
    expect(split.place).toBe("(tag:wood OR ext:png)");
  });

  it("treats a query that does not parse as all place, and raises nothing", () => {
    // The grid is already saying the query is broken; a filter bar is not the
    // control that should say it a second time.
    expect(splitQuery('tag:"unclosed').representable).toBe(false);
    expect(splitQuery("colour:red").facets).toEqual(NO_FACETS);
    expect(splitQuery("colour:red").place).toBe("colour:red");
  });
});

describe("writing a query", () => {
  it("writes nothing for no facets and no place", () => {
    expect(joinQuery("", NO_FACETS)).toBe("");
  });

  it("writes one term per facet, ORed within and ANDed across", () => {
    expect(joinQuery("", facets({ tags: ["wood"] }))).toBe("tag:wood");
    expect(joinQuery("", facets({ tags: ["wood", "metal"] }))).toBe("(tag:wood OR tag:metal)");
    expect(joinQuery("", facets({ exts: ["png", "jpg"], stars: [5] }))).toBe(
      "rating:5 (ext:png OR ext:jpg)",
    );
  });

  it("writes the all rule as a term each", () => {
    expect(joinQuery("", facets({ tags: ["wood", "metal"], tagRule: "all" }))).toBe(
      "tag:wood tag:metal",
    );
    // One tag spells the same query under either rule, which is exactly why the
    // rule cannot be read back from it.
    expect(joinQuery("", facets({ tags: ["wood"], tagRule: "all" }))).toBe("tag:wood");
    expect(joinQuery("", facets({ tags: [], tagRule: "all" }))).toBe("");
  });

  it("quotes a value that needs it, and never by concatenating", () => {
    expect(joinQuery("", facets({ tags: ["brand assets"] }))).toBe('tag:"brand assets"');
  });

  it("puts the stars in the order the rating rows were drawn in", () => {
    expect(joinQuery("", facets({ stars: [3, 5, 1], unrated: true }))).toBe(
      "(rating:5 OR rating:3 OR rating:1 OR is:unrated)",
    );
  });

  it("keeps the place first and in its own words", () => {
    expect(joinQuery("beach size:>2mb", facets({ tags: ["wood"] }))).toBe(
      "beach size:>2mb tag:wood",
    );
  });

  it("fences a place that ORs at the top level", () => {
    // `a OR b tag:wood` parses as `a OR (b AND tag:wood)`. The OR the bar could
    // not read is exactly the one that has to be fenced before anything is
    // ANDed onto it.
    const query = joinQuery("tag:a OR tag:b", facets({ exts: ["png"] }));
    expect(query).toBe("(tag:a OR tag:b) ext:png");
    expect(() => parse(query)).not.toThrow();
  });

  it("leaves a place alone when nothing is chosen", () => {
    expect(joinQuery("tag:a OR tag:b", NO_FACETS)).toBe("tag:a OR tag:b");
  });
});

describe("reading and writing agree", () => {
  const roundTrips = [
    "",
    "tag:wood",
    "(tag:wood OR tag:metal)",
    "rating:5",
    "(rating:5 OR rating:3 OR is:unrated)",
    "ext:png",
    "(ext:png OR ext:jpg)",
    'beach size:>2mb folder:"Design/Icons" tag:wood',
    "-tag:wip rating:2 ext:pdf",
    "tag:wood tag:metal",
    "beach tag:wood tag:metal rating:5",
  ];

  for (const query of roundTrips) {
    it(`survives a round trip: ${query === "" ? "(empty)" : query}`, () => {
      const split = splitQuery(query);
      expect(split.representable).toBe(true);
      expect(joinQuery(split.place, split.facets)).toBe(query);
    });
  }

  it("returns the query it started from when a facet is turned off and on again", () => {
    const start = "beach tag:wood rating:5 (ext:png OR ext:jpg)";
    const split = splitQuery(start);
    const off = joinQuery(split.place, { ...split.facets, stars: [] });
    expect(off).toBe("beach tag:wood (ext:png OR ext:jpg)");
    const back = splitQuery(off);
    expect(joinQuery(back.place, { ...back.facets, stars: [5] })).toBe(start);
  });

  it("puts a place a sidebar row supplies in front of the facets it keeps", () => {
    // ADR-0035 §6: a sidebar row replaces every conjunct the bar does not own
    // and leaves the ones it does.
    const split = splitQuery("beach ext:png rating:5");
    expect(joinQuery('folder:"Design/Logos"', split.facets)).toBe(
      'folder:"Design/Logos" rating:5 ext:png',
    );
  });
});

describe("the depth a query names", () => {
  it("reads the folder term's depth, and nothing when there is no folder", () => {
    expect(splitQuery("folder:Design").subfolders).toBe(true);
    expect(splitQuery("infolder:Design").subfolders).toBe(false);
    // Nothing to reflect: the checkbox then shows the library's setting, which
    // is what the next folder opened will use (ADR-0036).
    expect(splitQuery("tag:wood").subfolders).toBe(null);
    expect(splitQuery("").subfolders).toBe(null);
  });

  it("refuses to answer for two folders, as it refuses two ratings", () => {
    expect(splitQuery("folder:Design infolder:Icons").subfolders).toBe(null);
    // And for shapes the checkbox has no answer for.
    expect(splitQuery("-folder:Design").subfolders).toBe(null);
    expect(splitQuery("(folder:Design OR folder:Icons)").subfolders).toBe(null);
  });

  it("keeps the folder term where it was, rather than absorbing it", () => {
    // A folder is where you are looking, not a filter over it (ADR-0035 §6).
    expect(splitQuery("folder:Design tag:wood").place).toBe("folder:Design");
  });

  it("rewrites the folder term to the other depth, and leaves the rest alone", () => {
    expect(withSubfolders("folder:Design tag:wood", false)).toBe("infolder:Design tag:wood");
    expect(withSubfolders("infolder:Design tag:wood", true)).toBe("folder:Design tag:wood");
    // A path with a space in it has to come back out through `quoteValue`.
    expect(withSubfolders('folder:"Old logos"', false)).toBe('infolder:"Old logos"');
  });

  it("returns a query with no folder in it byte for byte", () => {
    // Rewriting nothing must not reformat what somebody typed.
    for (const query of ["tag:wood   rating:4", "", "-folder:Design", "a OR b"]) {
      expect(withSubfolders(query, false)).toBe(query);
      expect(withSubfolders(query, true)).toBe(query);
    }
  });
});

describe("placeFolder (ADR-0035 §8)", () => {
  it("reads a place that is one folder term, at either depth", () => {
    expect(placeFolder("infolder:Design")).toEqual({ field: "infolder", value: "Design" });
    expect(placeFolder('folder:"Trip 2024/Day 1"')).toEqual({
      field: "folder",
      value: "Trip 2024/Day 1",
    });
    expect(placeFolder("  folder:Design  ")).toEqual({ field: "folder", value: "Design" });
    // The same term, fenced: it asks for the same place.
    expect(placeFolder("(folder:Design)")).toEqual({ field: "folder", value: "Design" });
  });

  it("reads no other place as a folder", () => {
    for (const place of [
      "",
      "tag:wood",
      "folder:Design tag:wood",
      "folder:A folder:B",
      "folder:A OR folder:B",
      "-folder:Design",
      "folder:",
    ]) {
      expect(placeFolder(place), place).toBeUndefined();
    }
  });
});

describe("subfolderSections (ADR-0059)", () => {
  it("reads a folder with its subfolders as its own assets, then the rest", () => {
    expect(subfolderSections("folder:Design")).toEqual({
      own: "infolder:Design",
      beneath: "folder:Design -infolder:Design",
    });
    expect(subfolderSections('rating:5 folder:"Trip 2024"')).toEqual({
      own: 'rating:5 infolder:"Trip 2024"',
      beneath: 'rating:5 folder:"Trip 2024" -infolder:"Trip 2024"',
    });
  });

  it("splits nothing else", () => {
    for (const query of [
      "",
      "infolder:Design",
      "tag:wood",
      "folder:A folder:B",
      "folder:A OR tag:b",
      "-folder:Design",
      "(folder:Design rating:5)",
    ]) {
      expect(subfolderSections(query), query).toBeUndefined();
    }
  });
});
