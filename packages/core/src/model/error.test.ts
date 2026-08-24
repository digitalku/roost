import { describe, expect, it } from "vitest";
import {
  fromWire,
  InvalidContentHashError,
  isWireError,
  RoostError,
  toWire,
  UnsupportedPlatformError,
} from "./error.js";

describe("the wire format", () => {
  it("exists because structuredClone discards an Error subclass", () => {
    // This is the whole justification for WireError, so it is asserted rather
    // than described. If a future runtime starts preserving own properties on
    // cloned errors, this test fails and the wire format can be reconsidered.
    const original = new InvalidContentHashError("nope");
    const cloned = structuredClone(original) as Partial<InvalidContentHashError>;

    expect(cloned).toBeInstanceOf(Error);
    expect(cloned).not.toBeInstanceOf(RoostError);
    expect(cloned.code).toBeUndefined();
    expect(cloned.detail).toBeUndefined();
  });

  it("survives structuredClone intact, which is the point", () => {
    const wire = new InvalidContentHashError("nope").toWire();
    const cloned = structuredClone(wire);

    expect(cloned).toEqual(wire);
    expect(isWireError(cloned)).toBe(true);
  });

  it("round-trips through fromWire, keeping the code and the detail", () => {
    const original = new UnsupportedPlatformError("trash");
    const restored = fromWire(structuredClone(original.toWire()));

    expect(restored).toBeInstanceOf(RoostError);
    expect(restored.code).toBe("unsupported_platform");
    expect(restored.message).toBe(original.message);
    expect(restored.detail).toEqual(original.detail);
  });
});

describe("isWireError", () => {
  it("rejects anything that is not one", () => {
    expect(isWireError(null)).toBe(false);
    expect(isWireError("invalid_content_hash")).toBe(false);
    expect(isWireError({ message: "no code", detail: {} })).toBe(false);
    expect(isWireError({ code: "not_a_real_code", message: "x", detail: {} })).toBe(false);
    expect(isWireError({ code: "remote", message: "x" })).toBe(false);
  });
});

describe("toWire", () => {
  it("passes a RoostError through with its code", () => {
    expect(toWire(new UnsupportedPlatformError("reveal")).code).toBe("unsupported_platform");
  });

  it("reduces an ordinary Error to a remote error rather than losing it", () => {
    const wire = toWire(new TypeError("undefined is not a function"));
    expect(wire.code).toBe("remote");
    expect(wire.message).toBe("undefined is not a function");
  });

  it("survives a thrown non-error, because handlers catch unknown", () => {
    expect(toWire("something went wrong").message).toBe("something went wrong");
    expect(toWire(undefined).message).toBe("undefined");
  });
});

describe("RoostError", () => {
  it("names itself after its subclass, for the benefit of a log reader", () => {
    expect(new UnsupportedPlatformError("trash").name).toBe("UnsupportedPlatformError");
  });
});
