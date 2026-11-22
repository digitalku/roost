import { describe, expect, it } from "vitest";
import { deletedFolderLine, leftFolderLine } from "./trash-actions.js";

describe("what the status bar says after a Delete inside a folder (ADR-0067 §3.1)", () => {
  it("names the one other folder a file is still in, or counts them", () => {
    expect(leftFolderLine(0, 1, "Design", ["Portfolio"])).toBe(
      "Removed 1 asset from Design. It is still in Portfolio",
    );
    expect(leftFolderLine(0, 1, "Design", ["A", "B", "C"])).toBe(
      "Removed 1 asset from Design. It is still in 3 other folders",
    );
    // A path the window does not know is not guessed at.
    expect(leftFolderLine(0, 1, "Design", [undefined])).toBe(
      "Removed 1 asset from Design. It is still in another folder",
    );
  });

  it("says both halves of a mixed selection", () => {
    expect(leftFolderLine(5, 0, "Design", [])).toBe("Moved 5 assets to the trash");
    expect(leftFolderLine(0, 5, "Design", [])).toBe(
      "Removed 5 assets from Design. They are all still in other folders",
    );
    expect(leftFolderLine(3, 2, "Design", [])).toBe(
      "Moved 3 assets to the trash. 2 are still in other folders, so they were only removed from Design",
    );
    expect(leftFolderLine(3, 1, "Design", ["Portfolio"])).toBe(
      "Moved 3 assets to the trash. 1 is still in another folder, so it was only removed from Design",
    );
  });

  it("says what a folder delete spared (ADR-0067 §3.2)", () => {
    expect(deletedFolderLine("Design", 0, 0)).toBe(
      "Deleted Design. The assets in it are still in the library.",
    );
    expect(deletedFolderLine("Design", 8, 2)).toBe(
      "Deleted Design, and moved 8 assets to the trash. 2 stayed in other folders",
    );
    expect(deletedFolderLine("Design", 8, 0)).toBe(
      "Deleted Design, and moved 8 assets to the trash",
    );
  });
});
