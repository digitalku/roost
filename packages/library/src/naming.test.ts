import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidLibraryNameError } from "./error.js";
import {
  checkLibraryName,
  hasLibrarySuffix,
  LIBRARY_SUFFIX,
  libraryDirectory,
  libraryNameFromPath,
  withLibrarySuffix,
} from "./naming.js";

describe("what a library directory is called", () => {
  it("adds the suffix once, however many times it is asked", () => {
    // `roost init ~/Photos` and `roost init ~/Photos.roost` must land in the
    // same place, or the CLI has two spellings for one library.
    expect(withLibrarySuffix("/home/you/Photos")).toBe("/home/you/Photos.roost");
    expect(withLibrarySuffix("/home/you/Photos.roost")).toBe("/home/you/Photos.roost");
    expect(withLibrarySuffix(withLibrarySuffix("/home/you/Photos"))).toBe("/home/you/Photos.roost");
  });

  it("does not read a bare suffix as a suffixed name", () => {
    // A directory literally called `.roost` is a hidden directory, not a
    // library called nothing.
    expect(hasLibrarySuffix(".roost")).toBe(false);
    expect(withLibrarySuffix(".roost")).toBe(".roost" + LIBRARY_SUFFIX);
  });

  it("reads the display name back off the path", () => {
    expect(libraryNameFromPath("/home/you/Holiday Photos.roost")).toBe("Holiday Photos");
    // A library made before this rule, or by the Rust build, has no suffix and
    // still has a name.
    expect(libraryNameFromPath("/home/you/Holiday Photos")).toBe("Holiday Photos");
  });

  it("puts a named library inside the location that was chosen", () => {
    // `join` rather than a literal: the separator belongs to the platform, and
    // the assertion is the trimmed name and the suffix.
    const inPictures = join("/home/you/Pictures", "Holiday.roost");
    expect(libraryDirectory("/home/you/Pictures", "Holiday")).toBe(inPictures);
    expect(libraryDirectory("/home/you/Pictures", "  Holiday  ")).toBe(inPictures);
  });

  it("refuses a name that would mean something to the filesystem", () => {
    // Refused rather than sanitised: a name quietly turned into a different
    // name is a library the user cannot find again.
    const refused = [
      "",
      "   ",
      "..",
      ".",
      ".hidden",
      "a/b",
      "a" + String.fromCharCode(92) + "b",
      "../escape",
      "with" + String.fromCharCode(10) + "newline",
      "bell" + String.fromCharCode(7),
    ];

    for (const name of refused) {
      expect(() => checkLibraryName(name)).toThrow(InvalidLibraryNameError);
      expect(() => libraryDirectory("/home/you", name)).toThrow(InvalidLibraryNameError);
    }
  });

  it("accepts the names people actually use", () => {
    for (const name of ["Holiday", "Holiday Photos", "2026-08", "Kerja & Arsip", "写真"]) {
      expect(checkLibraryName(name)).toBe(name);
    }
  });

  it("never lets a name climb out of the location it was given", () => {
    // The property behind the list above: whatever the name, the result stays
    // one level under the parent.
    // Normalised, because `libraryDirectory` joins and a join rewrites the
    // separators of what it was given.
    const under = join("/home/you/Pictures") + sep;
    for (const name of ["Holiday", "Holiday Photos", "2026-08", "写真"]) {
      const made = libraryDirectory("/home/you/Pictures", name);
      expect(made.startsWith(under)).toBe(true);
      expect(made.slice(under.length)).not.toContain(sep);
    }
  });
});
