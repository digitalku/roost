import type { WireJournalNotice } from "@roost/contract";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { JournalNotice } from "./JournalNotice.js";

/**
 * Telling the person what another build wrote and this one cannot show
 * (`UI_SPEC.md` §3.14).
 *
 * The library format requires it in as many words: skipping an operation is
 * safe, because the journal is append-only and the record is still there when
 * the library opens elsewhere — but *silently* skipping is a library that
 * quietly means less than it says, and only the person can act on that.
 */

function notice(over: Partial<WireJournalNotice> = {}): WireJournalNotice {
  return { skipped: [], dangling: 0, ...over };
}

describe("the journal notice", () => {
  it("says nothing when there is nothing to say", () => {
    const { container } = render(<JournalNotice notice={notice()} />);
    expect(container.textContent).toBe("");
  });

  it("says nothing about a dangling reference alone", () => {
    // A record naming something another build deleted is the ordinary result of
    // one library edited from two of them. The format calls it a diagnostic
    // rather than news, and a line about it would be a line nobody can act on.
    const { container } = render(<JournalNotice notice={notice({ dangling: 4 })} />);
    expect(container.textContent).toBe("");
  });

  it("names the build when everything skipped came from one", async () => {
    render(
      <JournalNotice
        notice={notice({
          skipped: [
            { op: "win.shell_pin", count: 2, platform: "win", platformLabel: "Roost for Windows" },
          ],
        })}
      />,
    );

    const line = screen.getByRole("button", { name: /Roost for Windows/ });
    expect(line.textContent).toBe("2 only Roost for Windows shows");

    await userEvent.click(line);
    // The reassurance first: a list of skipped records reads like lost work.
    expect(screen.getByText(/still in the library's journal/)).toBeDefined();
    expect(screen.getByText("win.shell_pin")).toBeDefined();
  });

  it("falls back to a count when several builds wrote them", async () => {
    render(
      <JournalNotice
        notice={notice({
          skipped: [
            { op: "mac.quicklook_tag", count: 1, platform: "mac", platformLabel: "Roost for Mac" },
            { op: "lightbox_create", count: 3, platform: null, platformLabel: null },
          ],
        })}
      />,
    );

    const line = screen.getByRole("button", { name: /not shown/ });
    expect(line.textContent).toBe("4 not shown");

    await userEvent.click(line);
    expect(screen.getByText(/written by Roost for Mac/)).toBeDefined();
    // A core operation has no prefix, so it belongs to the format rather than
    // to a platform — which is exactly the distinction the prefix exists to
    // draw, and the one a message has to get right.
    expect(screen.getByText(/later revision of the library format/)).toBeDefined();
  });
});
