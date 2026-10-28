import { describe, expect, it } from "vitest";
import { folderSearch } from "./folder-search.js";

const bare = (value: string) => ({ value, exact: false });

describe("folderSearch (ADR-0057)", () => {
  it("reads words as a search across the library", () => {
    expect(folderSearch("highlights")).toEqual({ words: [bare("highlights")], within: null });
    expect(folderSearch('kucing "oak wood"')).toEqual({
      words: [bare("kucing"), { value: "oak wood", exact: true }],
      within: null,
    });
  });

  it("reads words typed inside a folder, at either depth", () => {
    expect(folderSearch("infolder:Design logo")).toEqual({
      words: [bare("logo")],
      within: "Design",
    });
    expect(folderSearch('logo folder:"Design/Brand"')).toEqual({
      words: [bare("logo")],
      within: "Design/Brand",
    });
  });

  it("opens parentheses that only group words", () => {
    expect(folderSearch("a (b c)")).toEqual({
      words: [bare("a"), bare("b"), bare("c")],
      within: null,
    });
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
