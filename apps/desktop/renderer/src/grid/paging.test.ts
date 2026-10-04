import { describe, expect, it } from "vitest";
import { fakeAsset } from "../testing/fake-engine.js";
import { without } from "./paging.js";

describe("taking rows out of a listing in two parts (ADR-0059)", () => {
  const assets = Array.from({ length: 5 }, (_, i) => fakeAsset(i));
  const id = (i: number): string => fakeAsset(i).id;
  const held = { assets, beneath: { first: id(3), count: 4 } };

  it("leaves the divider where it was when a row above it goes", () => {
    expect(without(held, new Set([id(0)])).beneath).toEqual({ first: id(3), count: 4 });
  });

  it("moves it to the next row beneath when its own row goes, and counts one fewer", () => {
    expect(without(held, new Set([id(3)])).beneath).toEqual({ first: id(4), count: 3 });
  });

  it("waits for the next page when every row beneath it here went, and more are coming", () => {
    expect(without(held, new Set([id(3), id(4)])).beneath).toEqual({ first: null, count: 2 });
  });

  it("takes it away once none of the rows beneath are left at all", () => {
    const all = { assets, beneath: { first: id(3), count: 2 } };
    expect(without(all, new Set([id(3), id(4)])).beneath).toBeNull();
  });
});
