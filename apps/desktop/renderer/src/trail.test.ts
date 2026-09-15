import { describe, expect, it } from "vitest";
import { canTravel, NO_TRAIL, record, type Trail, travel } from "./trail.js";

/** A step that has to exist, without an `as` cast standing in for the check. */
function must(held: Trail | undefined): Trail {
  if (held === undefined) throw new Error("expected somewhere to travel to");
  return held;
}

/**
 * Where the window has been (ADR-0044).
 *
 * Everything here is about a place rather than a query: the filter bar's chips
 * are not in this list, by the user's choosing on 2026-09-13, and the reason
 * they are not is that only the place is passed in.
 */

describe("recording where the window has been", () => {
  it("pushes a place, and hands back the same trail when nothing moved", () => {
    const one = record(NO_TRAIL, "infolder:Design", "control");
    expect(one).toEqual({ entries: ["", "infolder:Design"], at: 1, typed: false });

    // The identity matters, not just the value: this is called from the effect
    // that reads every split — a facet ticked, a count still in flight — and a
    // fresh object each time would be a render each time.
    expect(record(one, "infolder:Design", "control")).toBe(one);
  });

  it("drops the forward stack the moment somewhere new is chosen", () => {
    let held = record(NO_TRAIL, "infolder:Design", "control");
    held = record(held, "infolder:Design/Icons", "control");
    const back = travel(held, -1);
    expect(back?.at).toBe(1);

    const elsewhere = record(must(back), "tag:brand", "control");
    expect(elsewhere.entries).toEqual(["", "infolder:Design", "tag:brand"]);
    expect(canTravel(elsewhere, 1)).toBe(false);
  });

  it("makes one entry of a query that is typed, not one per idle", () => {
    // The field applies on a 250ms idle (`UI_SPEC.md` §5), so this is what
    // arrives when somebody types a folder name at a normal speed.
    let held = record(NO_TRAIL, "infolder:Des", "field");
    held = record(held, "infolder:Desi", "field");
    held = record(held, "infolder:Design", "field");

    expect(held.entries).toEqual(["", "infolder:Design"]);
    expect(canTravel(held, -1)).toBe(true);
  });

  it("does not swallow a click that follows typing", () => {
    // The hazard the source exists for: `infolder:Design/Icons` is a prefix
    // edit of `infolder:Design` and is also the descent a folder tile makes.
    // Coalescing by shape rather than by source would lose exactly this.
    let held = record(NO_TRAIL, "infolder:Design", "field");
    held = record(held, "infolder:Design/Icons", "control");

    expect(held.entries).toEqual(["", "infolder:Design", "infolder:Design/Icons"]);
  });

  it("starts a new entry for the next thing typed after a journey", () => {
    let held = record(NO_TRAIL, "infolder:Design", "field");
    held = must(travel(held, -1));
    held = record(held, "tag:brand", "field");

    // Arriving somewhere by walking is a visit, so the typed place pushes
    // rather than overwriting what the walk landed on.
    expect(held.entries).toEqual(["", "tag:brand"]);
  });
});

describe("travelling", () => {
  it("has nothing behind the first entry and nothing ahead of the last", () => {
    expect(travel(NO_TRAIL, -1)).toBeUndefined();
    expect(travel(NO_TRAIL, 1)).toBeUndefined();
    expect(canTravel(NO_TRAIL, -1)).toBe(false);
  });

  it("walks back and forward over the same list", () => {
    let held = record(NO_TRAIL, "infolder:Design", "control");
    held = record(held, "infolder:Design/Icons", "control");

    const back = must(travel(held, -1));
    expect(back.at).toBe(1);
    const forward = must(travel(back, 1));
    expect(forward.entries[forward.at]).toBe("infolder:Design/Icons");
  });
});
