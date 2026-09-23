import { type AssetId, parseAssetId } from "@roost/core";
import { describe, expect, it } from "vitest";
import { Wanted } from "./wanted.js";

const id = (n: number): AssetId => parseAssetId(`A${String(n).padStart(11, "0")}`);

describe("what is on screen waiting", () => {
  it("hands out the most recently asked for first", () => {
    const wanted = new Wanted();
    wanted.add([id(1), id(2)]);
    wanted.add([id(3)]);

    expect([wanted.take(), wanted.take(), wanted.take(), wanted.take()]).toEqual([
      id(3),
      id(2),
      id(1),
      undefined,
    ]);
  });

  it("moves an id asked for again to the front", () => {
    const wanted = new Wanted();
    wanted.add([id(1), id(2), id(1)]);

    expect(wanted.size).toBe(2);
    expect(wanted.take()).toBe(id(1));
  });

  it("forgets the oldest past its capacity, so a fling costs a screen", () => {
    const wanted = new Wanted(2);
    wanted.add([id(1), id(2), id(3)]);

    expect(wanted.size).toBe(2);
    expect([wanted.take(), wanted.take(), wanted.take()]).toEqual([id(3), id(2), undefined]);
  });
});
