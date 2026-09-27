import { type AssetId, type ContentHash, parseAssetId, parseContentHash } from "@roost/core";
import { describe, expect, it } from "vitest";
import { type Claimed, type Claims, claim } from "./claims.js";

const HASH: ContentHash = parseContentHash("a".repeat(64));

function claimIn(claims: Claims, minted: Set<AssetId>, held?: AssetId): Promise<Claimed> {
  return claim(
    HASH,
    claims,
    minted,
    () => held,
    () => false,
  );
}

function claimant(claimed: Claimed): Extract<Claimed, { id: AssetId }> {
  if ("held" in claimed) throw new Error("expected a claim, got a duplicate");
  return claimed;
}

describe("claiming a hash in a batch", () => {
  it("answers what the library already holds, and claims nothing", async () => {
    const claims: Claims = new Map();
    const held = parseAssetId("K7QM4X2AJH9F");
    expect(await claimIn(claims, new Set(), held)).toEqual({ held });
    expect(claims.size).toBe(0);
  });

  it("makes an identical file wait, and a duplicate of the file once it is placed", async () => {
    const claims: Claims = new Map();
    const minted = new Set<AssetId>();
    const first = claimant(await claimIn(claims, minted));
    expect(minted.has(first.id)).toBe(true);

    const second = claimIn(claims, minted);
    first.settle(true);
    expect(await second).toEqual({ held: first.id });
  });

  it("hands the bytes to the next file when the one that claimed them never arrives", async () => {
    // ADR-0055 §3.5: stopped or failed, the first file is in no batch, so an
    // identical one must claim the bytes rather than be counted its duplicate.
    const claims: Claims = new Map();
    const minted = new Set<AssetId>();
    const first = claimant(await claimIn(claims, minted));
    const second = claimIn(claims, minted);
    const third = claimIn(claims, minted);

    first.settle(false);
    const results = await Promise.race([
      Promise.all([second, third]).then(() => "both answered"),
      new Promise((resolve) => setTimeout(() => resolve("stuck"), 100)),
    ]);
    // The second file claimed the bytes and has not settled, so the third
    // waits on it in turn rather than claiming them a second time.
    expect(results).toBe("stuck");

    const next = claimant(await second);
    expect(next.id).not.toBe(first.id);
    next.settle(true);
    expect(await third).toEqual({ held: next.id });
  });
});
