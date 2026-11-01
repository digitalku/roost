import { describe, expect, it } from "vitest";
import { fakeAsset } from "../testing/fake-engine.js";
import { redrawnCard, without } from "./paging.js";

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

describe("a redraw reaching a card it holds (ADR-0064)", () => {
  const card = { ...fakeAsset(0), derivedAt: 5, width: 40, height: 30 };
  const same = { id: card.id, derivedAt: 5, undrawn: card.undrawn, chosen: card.chosenThumbnail };

  it("takes a new shape when a refresh sends one", () => {
    const patched = redrawnCard(card, { ...same, derivedAt: 6, width: 30, height: 40 });
    expect([patched.derivedAt, patched.width, patched.height]).toEqual([6, 30, 40]);
  });

  it("keeps its shape when a redraw measured none", () => {
    const patched = redrawnCard(card, { ...same, derivedAt: 6 });
    expect([patched.width, patched.height]).toEqual([40, 30]);
  });

  it("is the same card when nothing moved, so the grid does not render again", () => {
    expect(redrawnCard(card, same)).toBe(card);
  });
});
