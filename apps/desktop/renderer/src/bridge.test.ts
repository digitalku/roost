import { beforeEach, describe, expect, it } from "vitest";
import { bridge, onEvent } from "./bridge.js";
import { FakeEngine, install } from "./testing/fake-engine.js";

/**
 * The renderer's side of the door.
 *
 * Tested apart from any component, because what it does — validating an event
 * before believing it — is invisible from a component that would ignore the bad
 * one anyway. The rule is that a message is checked at the end that receives it,
 * and the type on the other side of `contextBridge` was erased two processes
 * ago.
 */

describe("the bridge", () => {
  let engine: FakeEngine;

  beforeEach(() => {
    engine = new FakeEngine();
    install(engine);
  });

  it("passes an event this build understands", () => {
    const seen: unknown[] = [];
    onEvent((event) => seen.push(event));

    engine.emit({ type: "library:changed" });

    expect(seen).toEqual([{ type: "library:changed" }]);
  });

  it("drops anything else, and does not throw doing it", () => {
    const seen: unknown[] = [];
    onEvent((event) => seen.push(event));

    for (const payload of [
      { type: "library:exploded" },
      { type: 7 },
      "not even an object",
      null,
      undefined,
      [{ type: "library:changed" }],
    ]) {
      expect(() => engine.emit(payload)).not.toThrow();
    }

    expect(seen).toEqual([]);
  });

  it("stops listening when the subscription is released", () => {
    const seen: unknown[] = [];
    const stop = onEvent((event) => seen.push(event));

    engine.emit({ type: "library:changed" });
    stop();
    engine.emit({ type: "library:changed" });

    // A component that unmounted and kept receiving would set state on a tree
    // that is gone, which React reports as a warning and nobody reads.
    expect(seen).toHaveLength(1);
  });

  it("says where it is when the page is not running inside Roost", () => {
    // A browser pointed at the dev server is a real thing to do by accident,
    // and "cannot read properties of undefined" says nothing about why.
    Reflect.deleteProperty(window, "roost");
    expect(() => bridge()).toThrow("not running inside Roost");
  });
});
