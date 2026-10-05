import { describe, expect, it } from "vitest";
import { ID_ALPHABET, ID_LENGTH } from "./asset-id.js";
import { shuffleFor } from "./sort.js";

describe("shuffleFor", () => {
  it("reorders the whole alphabet and reads a character the id has", () => {
    for (const seed of [0, 1, 7, 999_999, 2 ** 32 + 5, Number.MAX_SAFE_INTEGER]) {
      const { at, alphabet } = shuffleFor(seed);
      expect([...alphabet].sort()).toEqual([...ID_ALPHABET].sort());
      expect(at).toBeGreaterThanOrEqual(1);
      expect(at).toBeLessThanOrEqual(ID_LENGTH);
    }
  });

  it("is the same shuffle every time it is asked for one seed", () => {
    // What a cursor rests on, and what lets `roost query --seed` be repeated.
    expect(shuffleFor(42)).toEqual(shuffleFor(42));
  });

  it("uses every character of the id across seeds, not one of them", () => {
    const places = new Set(Array.from({ length: 500 }, (_, seed) => shuffleFor(seed).at));
    expect(places.size).toBe(ID_LENGTH);
  });
});
