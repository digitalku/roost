import type { JournalNotice } from "@roost/library";
import { describe, expect, it } from "vitest";
import { noticeLines } from "./open.js";

/**
 * What the CLI says about a journal it could not fully read (RL-26a, RL-28).
 *
 * The requirement is that the **person** be told, not only a log — so every
 * command that opens a library says it, and the saying lives at the open rather
 * than in each command.
 */

describe("the journal notice", () => {
  it("says nothing when there is nothing to say", () => {
    expect(noticeLines({ skipped: [], dangling: 0 })).toEqual([]);
  });

  it("names the build that wrote what this one skipped", () => {
    const notice: JournalNotice = {
      skipped: [
        { op: "win.shell_pin", count: 2, platform: "win", platformLabel: "Roost for Windows" },
      ],
      dangling: 0,
    };

    const lines = noticeLines(notice);
    expect(lines[0]).toContain("win.shell_pin");
    expect(lines[0]).toContain("Roost for Windows");
    // Said because the list reads like lost work and none of it is lost.
    expect(lines.join(" ")).toContain("still in the journal");
  });

  it("calls an unprefixed operation the format's rather than a platform's", () => {
    // RL-29 draws exactly this line: a core operation this build does not know
    // comes from a later revision and may have others depending on it; a
    // prefixed one is another operating system's and is safe to ignore forever.
    const lines = noticeLines({
      skipped: [{ op: "lightbox_create", count: 1, platform: null, platformLabel: null }],
      dangling: 0,
    });
    expect(lines[0]).toContain("a later revision of the library format");
  });

  it("mentions a dangling reference without advice, and never alone as a headline", () => {
    const lines = noticeLines({ skipped: [], dangling: 3 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("3 record(s)");
  });
});
