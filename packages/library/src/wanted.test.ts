import { type AssetId, parseAssetId } from "@roost/core";
import { describe, expect, it } from "vitest";
import { Requested, Wanted } from "./wanted.js";

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

describe("what a paused queue still works", () => {
  it("serves an opened file ahead of an import, and an import in its own order", () => {
    // ADR-0049: the file somebody is looking at now goes first; an import is
    // worked in the order it arrived.
    const requested = new Requested();
    requested.queue([id(1), id(2), id(3)]);
    requested.open(id(9));
    expect(requested.size).toBe(4);

    expect(requested.take()).toBe(id(9));
    expect(requested.take()).toBe(id(1));
    requested.open(id(8));
    expect([requested.take(), requested.take(), requested.take()]).toEqual([id(8), id(2), id(3)]);
    expect(requested.take()).toBeUndefined();
    expect(requested.size).toBe(0);
  });

  it("hands out a large import without walking it per claim", () => {
    // A hundred thousand ids is an ordinary import; a `Wanted` would walk its
    // map for every one of them.
    const requested = new Requested();
    requested.queue(Array.from({ length: 100_000 }, (_, n) => id(n)));
    let taken = 0;
    const started = performance.now();
    while (requested.take() !== undefined) taken += 1;
    expect(taken).toBe(100_000);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
