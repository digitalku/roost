import { describe, expect, it } from "vitest";
import { isKind, KINDS } from "./kind.js";
import { isLinkMethod, isStorageMode, LINK_METHODS, STORAGE_MODES } from "./storage.js";

describe("kinds", () => {
  it("recognises its own members and nothing else", () => {
    for (const kind of KINDS) expect(isKind(kind)).toBe(true);
    expect(isKind("image/png")).toBe(false);
    expect(isKind("")).toBe(false);
  });

  it("has an `other`, because a format Roost cannot draw still imports", () => {
    expect(isKind("other")).toBe(true);
  });
});

describe("storage modes", () => {
  it("recognises its own members and nothing else", () => {
    for (const mode of STORAGE_MODES) expect(isStorageMode(mode)).toBe(true);
    expect(isStorageMode("linked")).toBe(false);
  });

  it("spells the referenced mode the way the spec does", () => {
    // The concept document once called this "linked". The schema's CHECK
    // constraint says `referenced`, and the schema is what a library carries.
    expect(STORAGE_MODES).toEqual(["managed", "referenced"]);
  });
});

describe("link methods", () => {
  it("lists them in the order the spec tries them", () => {
    // reflink first: it is the only one that is both free and independent of
    // later edits to the user's file (RL-15).
    expect(LINK_METHODS).toEqual(["reflink", "hardlink", "copy"]);
  });

  it("recognises its own members and nothing else", () => {
    for (const method of LINK_METHODS) expect(isLinkMethod(method)).toBe(true);
    expect(isLinkMethod("symlink")).toBe(false);
  });
});
