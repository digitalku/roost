import { describe, expect, it } from "vitest";
import { normaliseReason } from "./jobs.js";

/**
 * Turning a backend's complaint into something that groups.
 *
 * The whole point is that thirty-six broken videos are **one** row in the list
 * and not thirty-six: ffmpeg names the file it was given, so the messages
 * differ in exactly the part that is not about the fault.
 */
describe("normalising a failure message", () => {
  it("takes the path out, so the same fault is one group", () => {
    const first = normaliseReason(
      "ffmpeg: /photos/a.mov: Invalid data found when processing input",
    );
    const second = normaliseReason(
      "ffmpeg: /videos/b.mov: Invalid data found when processing input",
    );

    expect(first).toBe(second);
    expect(first).toBe("ffmpeg: … Invalid data found when processing input");
  });

  it("keeps numbers, because an exit code is what the message is about", () => {
    // 137 is a kill and 1 is a refusal. Folding them together would hide the
    // difference between a machine out of memory and a file it will not read.
    expect(normaliseReason("ffmpeg: exited with 137")).not.toBe(
      normaliseReason("ffmpeg: exited with 1"),
    );
  });

  it("takes a content hash out, which is a path by another name", () => {
    expect(normaliseReason(`open failed on ${"a".repeat(64)}.png: ENOENT`)).toBe(
      "open failed on … ENOENT",
    );
  });

  it("collapses two elisions into one, so a message keeps its shape", () => {
    expect(normaliseReason("copy /a/one.png /b/two.png failed")).toBe("copy … failed");
  });

  it("reads the first line and nothing after it", () => {
    expect(normaliseReason("Decode failed\n  at Object.<anonymous>\n  at run")).toBe(
      "Decode failed",
    );
  });

  it("says so when the backend said nothing", () => {
    // `jobs.reason` is nullable, and a row with no reason must still group
    // somewhere rather than opening an empty row in the dialog.
    expect(normaliseReason("")).toBe("The backend said nothing");
  });

  it("cuts a message that would not fit a line", () => {
    const long = normaliseReason(`sharp: ${"very ".repeat(80)}wrong`);

    expect(long.length).toBeLessThanOrEqual(161);
    expect(long.endsWith("…")).toBe(true);
  });

  it("leaves a Windows path out too", () => {
    expect(normaliseReason("ffmpeg: C:\\Users\\me\\a.mov: Invalid data")).toBe(
      "ffmpeg: … Invalid data",
    );
  });
});
