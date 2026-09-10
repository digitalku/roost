import { describe, expect, it, vi } from "vitest";
import { sound } from "./sound.js";

/**
 * The remembered loudness (ADR-0024 §9).
 *
 * A module singleton, so every test here puts it back where it found it — the
 * store is one fact about the window and the tests share it.
 */

describe("the remembered loudness", () => {
  const reset = () => sound.remember({ volume: 100, muted: false });

  it("hands a new element what the library remembered", () => {
    sound.remember({ volume: 35, muted: true });
    expect(sound.current()).toEqual({ volume: 35, muted: true });
    reset();
  });

  it("says nothing when it is seeded", () => {
    // A listener here writes `settings.json`. Announcing a seed would write
    // back the value that had just been read, once per library opened.
    const wrote = vi.fn();
    const stop = sound.onChange(wrote);
    sound.remember({ volume: 20, muted: false });
    expect(wrote).not.toHaveBeenCalled();
    stop();
    reset();
  });

  it("passes a change on, once", () => {
    const wrote = vi.fn();
    const stop = sound.onChange(wrote);
    sound.changed({ volume: 40, muted: false });
    expect(wrote.mock.calls).toEqual([[{ volume: 40, muted: false }]]);
    expect(sound.current()).toEqual({ volume: 40, muted: false });
    stop();
    reset();
  });

  it("drops a value it already holds, which is what stops the echo", () => {
    // Applying the remembered volume to a new element makes the element emit
    // `volumechange`. Without this, opening a video would write the file.
    sound.remember({ volume: 40, muted: false });
    const wrote = vi.fn();
    const stop = sound.onChange(wrote);
    sound.changed({ volume: 40, muted: false });
    expect(wrote).not.toHaveBeenCalled();

    // Muting alone is a change, and so is the volume alone.
    sound.changed({ volume: 40, muted: true });
    expect(wrote).toHaveBeenCalledTimes(1);
    stop();
    reset();
  });

  it("keeps a hand-edited value inside what the element will accept", () => {
    // `HTMLMediaElement.volume` throws outside 0–1, so a settings.json somebody
    // typed 400 into must not reach the assignment.
    sound.remember({ volume: 400, muted: false });
    expect(sound.current().volume).toBe(100);
    sound.remember({ volume: -5, muted: false });
    expect(sound.current().volume).toBe(0);
    sound.remember({ volume: Number.NaN, muted: false });
    expect(sound.current().volume).toBe(100);
    reset();
  });

  it("stops telling a listener that has gone", () => {
    const wrote = vi.fn();
    sound.onChange(wrote)();
    sound.changed({ volume: 10, muted: false });
    expect(wrote).not.toHaveBeenCalled();
    reset();
  });
});
