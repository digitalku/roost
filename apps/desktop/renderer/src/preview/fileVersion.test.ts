import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFileVersion } from "./fileVersion.js";

const ONE = "a".repeat(12);
const TWO = "b".repeat(12);

describe("the version in a file's address", () => {
  it("carries the hash, and a new one when the bytes change", () => {
    // A photograph flipped in another editor stayed unflipped in the preview
    // until a restart: `roost://file/<id>` is `immutable`, so an address that
    // does not move is one Chromium never asks about again (2026-11-24).
    const { result, rerender } = renderHook(({ hash }) => useFileVersion(ONE, hash), {
      initialProps: { hash: "h1" as string | null },
    });
    expect(result.current).toBe("?h=h1");

    rerender({ hash: "h2" });
    expect(result.current).toBe("?h=h2");
  });

  it("adopts the first hash without moving, so a video opened early keeps playing", () => {
    const { result, rerender } = renderHook(({ hash }) => useFileVersion(ONE, hash), {
      initialProps: { hash: null as string | null },
    });
    expect(result.current).toBe("");

    // The derive the opening asked for: the bytes are the ones already playing.
    rerender({ hash: "h1" });
    expect(result.current).toBe("");

    // A save elsewhere.
    rerender({ hash: "h2" });
    expect(result.current).toBe("?h=h2");
  });

  it("keeps its address when a derive clears the hash", () => {
    const { result, rerender } = renderHook(({ hash }) => useFileVersion(ONE, hash), {
      initialProps: { hash: "h1" as string | null },
    });
    rerender({ hash: null });
    expect(result.current).toBe("?h=h1");
  });

  it("starts again for another asset", () => {
    const { result, rerender } = renderHook(({ id, hash }) => useFileVersion(id, hash), {
      initialProps: { id: ONE, hash: "h1" as string | null },
    });
    // Stepping to one not yet derived must not carry the last one's hash, nor
    // move when its own first hash arrives.
    rerender({ id: TWO, hash: null });
    expect(result.current).toBe("");
    rerender({ id: TWO, hash: "h9" });
    expect(result.current).toBe("");
  });
});
