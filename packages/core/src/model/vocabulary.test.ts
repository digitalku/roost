import { describe, expect, it } from "vitest";
import {
  ID_ALPHABET,
  ID_LENGTH,
  isAssetId,
  mintAssetId,
  parseAssetId,
  shardOf,
} from "./asset-id.js";
import { isKind, KINDS } from "./kind.js";
import { isPlacement, isTake, PLACEMENTS, TAKES } from "./take.js";

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

describe("asset ids", () => {
  it("is Crockford base32 without I, L, O and U (RL-14)", () => {
    // Not a spelling preference. `I`, `L` and `O` read as `1`, `1` and `0`, and
    // `U` is out so that a random id never spells something unfortunate.
    expect(ID_ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
    expect(ID_ALPHABET).toHaveLength(32);
    for (const letter of "ILOU") expect(ID_ALPHABET).not.toContain(letter);
  });

  it("is twelve characters, upper case, and nothing else", () => {
    expect(ID_LENGTH).toBe(12);
    expect(isAssetId("K7QM4X2AJH9F")).toBe(true);
    // Lower case is not an id: Windows compares filenames without regard to
    // case, so two ids differing only in case would be one file.
    expect(isAssetId("k7qm4x2ajh9f")).toBe(false);
    expect(isAssetId("K7QM4X2AJH9")).toBe(false);
    expect(isAssetId("K7QM4X2AJH9FF")).toBe(false);
    expect(isAssetId("K7QM4X2AJH9I")).toBe(false);
    expect(isAssetId("")).toBe(false);
    // A version 1 hash is not an id, which is what stops one reaching a query
    // that would answer nothing.
    expect(isAssetId("a".repeat(64))).toBe(false);
  });

  it("shards on the first two characters, and hands back a name (RL-8)", () => {
    expect(shardOf(parseAssetId("K7QM4X2AJH9F"))).toBe("K7");
    // A directory name, never a path: turning an id into a path is reserved to
    // a `Storage` implementation (invariant 2).
    expect(shardOf(parseAssetId("K7QM4X2AJH9F"))).not.toContain("/");
  });

  it("mints ids that are valid, distinct, and spread across the shards", () => {
    const minted = Array.from({ length: 200 }, () => mintAssetId());
    for (const id of minted) expect(isAssetId(id)).toBe(true);
    expect(new Set(minted).size).toBe(200);
    // Not a distribution test — 200 draws over 1 024 buckets proves nothing
    // about uniformity — but a time-ordered id (RL-14a forbids one) would put
    // every one of these in a handful of shards, which this does catch.
    expect(new Set(minted.map(shardOf)).size).toBeGreaterThan(100);
  });

  it("mints another when the library already holds the one it drew (RL-15)", () => {
    const taken = new Set([mintAssetId()]);
    const first = [...taken][0] as string;
    let asked = 0;
    const next = mintAssetId((id) => {
      asked += 1;
      return asked === 1 ? true : taken.has(id);
    });
    expect(next).not.toBe(first);
    expect(asked).toBeGreaterThan(1);
  });
});

describe("what an import does with the file it was given", () => {
  it("has two answers, and RL-26 requires the person be told which", () => {
    expect(TAKES).toEqual(["move", "copy"]);
    for (const take of TAKES) expect(isTake(take)).toBe(true);
    // Version 1's storage modes are not takes: there is one storage mode now
    // (RL-19), and the question moved from *where do the bytes live* to *what
    // happened to the file they came from*.
    expect(isTake("managed")).toBe(false);
    expect(isTake("referenced")).toBe(false);
  });

  it("lists placements in the order the importer tries them", () => {
    // A rename first where it can (a move within one filesystem is free), then
    // a copy-on-write clone, then a full copy. **No hardlink**: RL-26 forbids
    // one, because editing the library's file would edit the user's.
    expect(PLACEMENTS).toEqual(["rename", "reflink", "copy"]);
    for (const placement of PLACEMENTS) expect(isPlacement(placement)).toBe(true);
    expect(isPlacement("hardlink")).toBe(false);
  });
});
