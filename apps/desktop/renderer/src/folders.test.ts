import type { SidebarFolderRow } from "@roost/contract";
import { describe, expect, it } from "vitest";
import { childrenOf, found, parentOf } from "./folders.js";

/**
 * The two walks the depth-first tree makes possible (ADR-0043).
 *
 * The wire carries no parent id, deliberately — a folder's place in the tree is
 * the order the rows arrive in — so both of these are about reading a shape out
 * of a flat list, and both are wrong in the same way if the list is not
 * depth-first.
 */

function row(folder: number, name: string, depth: number): SidebarFolderRow {
  return {
    id: `folder:${folder}`,
    name,
    query: `infolder:"${name}"`,
    count: 0,
    depth,
    group: null,
    stars: null,
    folder,
    path: name,
    descendants: 0,
  };
}

/**
 * Design
 *   Icons
 *     Outline
 *   Logos
 * Scans
 */
const TREE: readonly SidebarFolderRow[] = [
  row(1, "Design", 0),
  row(2, "Icons", 1),
  row(3, "Outline", 2),
  row(4, "Logos", 1),
  row(5, "Scans", 0),
];

describe("the folders directly inside one", () => {
  it("takes the children and not the grandchildren", () => {
    expect(childrenOf(TREE, 1).map((child) => child.name)).toEqual(["Icons", "Logos"]);
  });

  it("stops at the end of the subtree rather than running into the next one", () => {
    // The row after `Logos` is `Scans`, which is a sibling of `Design` and no
    // child of anything here. Reading depth alone without stopping would take
    // it, because it is at depth 0 and every other test would still pass.
    expect(childrenOf(TREE, 4)).toEqual([]);
    expect(childrenOf(TREE, 2).map((child) => child.name)).toEqual(["Outline"]);
  });

  it("answers nothing for a folder that is not in the tree", () => {
    expect(childrenOf(TREE, 99)).toEqual([]);
  });
});

describe("the folder one level up", () => {
  it("walks back to the nearest shallower row", () => {
    expect(parentOf(TREE, 3)?.name).toBe("Icons");
    expect(parentOf(TREE, 4)?.name).toBe("Design");
  });

  it("has nothing above a top-level folder", () => {
    expect(parentOf(TREE, 1)).toBeUndefined();
    expect(parentOf(TREE, 5)).toBeUndefined();
  });
});

describe("searching the tree", () => {
  it("keeps a match's ancestors and leaves its subtree out", () => {
    const drawn = found(TREE, "icons");
    expect(drawn.map((entry) => entry.row.name)).toEqual(["Design", "Icons"]);
    expect(drawn[0]?.isContext).toBe(true);
    expect(drawn[1]?.isContext).toBe(false);
  });
});
