import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { exitQuietlyOnBrokenPipe } from "./pipe.js";

describe("a closed pipe", () => {
  it("ends the process quietly", () => {
    const stream = new EventEmitter();
    const exits: number[] = [];
    exitQuietlyOnBrokenPipe([stream], (code) => exits.push(code));

    stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    expect(exits).toEqual([0]);
  });

  it("leaves any other stream error to fail loudly", () => {
    // Stdout that cannot be written to for some other reason is a real problem,
    // and a handler that swallowed it would lose output without saying so.
    const stream = new EventEmitter();
    const exits: number[] = [];
    exitQuietlyOnBrokenPipe([stream], (code) => exits.push(code));

    expect(() => {
      stream.emit("error", Object.assign(new Error("no space left"), { code: "ENOSPC" }));
    }).toThrow("no space left");
    expect(exits).toEqual([]);
  });
});
