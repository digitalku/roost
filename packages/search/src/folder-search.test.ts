import { describe, expect, it } from "vitest";
import { folderSearch } from "./folder-search.js";

describe("folderSearch (ADR-0057)", () => {
  it("reads words as a search across the library", () => {
    expect(folderSearch("highlights")).toEqual({ words: ["highlights"], within: null });
    expect(folderSearch('kucing "oak wood"')).toEqual({
      words: ["kucing", "oak wood"],
      within: null,
    });
  });

  it("reads words typed inside a folder, at either depth", () => {
    expect(folderSearch("infolder:Design logo")).toEqual({ words: ["logo"], within: "Design" });
    expect(folderSearch('logo folder:"Design/Brand"')).toEqual({
      words: ["logo"],
      within: "Design/Brand",
    });
  });

  it("opens parentheses that only group words", () => {
    expect(folderSearch("a (b c)")).toEqual({ words: ["a", "b", "c"], within: null });
  });

  it("is not a search for any other shape", () => {
    for (const query of [
      "",
      "infolder:Design",
      "kucing rating:5",
      "kucing tag:cat",
      "kucing ext:png",
      "kucing is:trashed",
      "-kucing",
      "kucing OR anjing",
      "folder:A folder:B kucing",
      "rating:>=",
    ]) {
      expect(folderSearch(query), query).toBeUndefined();
    }
  });
});
