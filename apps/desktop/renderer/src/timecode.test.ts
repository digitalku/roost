import { describe, expect, it } from "vitest";
import { timecode } from "./timecode.js";

describe("a moment as a person reads it", () => {
  it("keeps one decimal, always", () => {
    // The point of a timed comment is that it is precise to a fraction of a
    // second. `1:31` beside `1:32` reads as though the moments had been rounded
    // to the second, and a column of them would not line up (ADR-0023).
    expect(timecode(91_500)).toBe("1:31.5");
    expect(timecode(91_000)).toBe("1:31.0");
    expect(timecode(0)).toBe("0:00.0");
  });

  it("grows an hours field only when there is one", () => {
    expect(timecode(600_000)).toBe("10:00.0");
    expect(timecode(3_723_400)).toBe("1:02:03.4");
    // Minutes are padded once hours are shown, so `1:02:03.4` cannot be read as
    // one hour and two seconds.
    expect(timecode(3_601_000)).toBe("1:00:01.0");
  });

  it("truncates rather than rounds", () => {
    // A marker at 59.999s that read `1:00.0` would point past the second it is
    // in, and clicking it would land after the frame somebody meant.
    expect(timecode(59_999)).toBe("0:59.9");
    expect(timecode(999)).toBe("0:00.9");
  });
});
