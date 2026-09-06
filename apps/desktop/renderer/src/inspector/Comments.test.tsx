import type { WireComment } from "@roost/contract";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { playhead } from "../preview/playhead.js";
import { FakeEngine, fakeDetail, install } from "../testing/fake-engine.js";
import { Inspector } from "./Inspector.js";

/**
 * Comments, driven through the panel that holds them (ADR-0023).
 *
 * Through the `Inspector` rather than the component alone, because the claim
 * worth testing is the round trip: the request the window sends, and the list it
 * draws from what the engine answers with afterwards. A component rendered on
 * its own with a list handed to it would prove neither.
 *
 * The fake engine mints ids and orders the list the way the repository does —
 * `ORDER BY at_ms IS NULL, at_ms, id` — so an edit that named the wrong comment
 * would show up here rather than in a window.
 */

const HASH = fakeDetail(1).hash;

/** Comments do not touch the tag field; it needs a vocabulary all the same. */
const VOCABULARY: readonly { name: string; group: string | null; count: number | null }[] = [];

describe("comments", () => {
  let engine: FakeEngine;
  let detach: (() => void) | undefined;

  const show = (comments: readonly WireComment[] = []) => {
    engine = new FakeEngine({ details: [fakeDetail(1, { comments })] });
    install(engine);
    render(<Inspector hashes={[HASH]} generation={0} vocabulary={VOCABULARY} folders={[]} />);
    return userEvent.setup();
  };

  /**
   * A real `<video>`, standing in for a preview that is open.
   *
   * happy-dom keeps `currentTime` but reports `duration` as `NaN`, which is
   * what the element does before any media has loaded — so this is the state
   * the strip's fallback to the probed duration exists for.
   */
  const playing = (at: number): HTMLVideoElement => {
    const video = document.createElement("video");
    video.currentTime = at;
    detach = playhead.attach(video);
    return video;
  };

  afterEach(() => {
    detach?.();
    detach = undefined;
  });

  const commented = (): WireComment[] => [...(engine.details.get(HASH)?.comments ?? [])];

  it("writes one about the whole asset when nothing is playing", async () => {
    const user = show();
    await screen.findByLabelText("Add a comment");

    await user.type(screen.getByLabelText("Add a comment"), "the logo is off-centre{Enter}");

    await waitFor(() => expect(commented()).toHaveLength(1));
    // `null`, not zero: a comment about the asset is not a comment at its first
    // millisecond, and a `.zip` can carry one (ADR-0023).
    expect(commented()[0]).toMatchObject({ atMs: null, body: "the logo is off-centre" });
    expect(screen.getByText("the logo is off-centre")).toBeDefined();
  });

  it("stamps the moment at the first keystroke, not at the send", async () => {
    const video = playing(91.5);
    const user = show();
    const field = await screen.findByLabelText("Add a comment");

    await user.type(field, "the cut");
    // What the field promises before anything is sent.
    expect(screen.getByText("1:31.5")).toBeDefined();

    // The film goes on while the sentence is finished. "At this point, …" is
    // what a person means, so the moment they started typing is the one kept.
    video.currentTime = 140;
    await user.type(field, " lands early{Enter}");

    await waitFor(() => expect(commented()).toHaveLength(1));
    expect(commented()[0]).toMatchObject({ atMs: 91_500, body: "the cut lands early" });
  });

  it("writes about the whole asset while a player is on screen, if asked", async () => {
    playing(91.5);
    const user = show();
    await user.type(await screen.findByLabelText("Add a comment"), "the export is 8-bit");

    await user.click(screen.getByLabelText("Comment on the whole asset instead"));
    expect(screen.queryByText("1:31.5")).toBeNull();

    await user.type(screen.getByLabelText("Add a comment"), "{Enter}");
    await waitFor(() => expect(commented()).toHaveLength(1));
    expect(commented()[0]?.atMs).toBeNull();
  });

  it("sends nothing for a body with only spaces in it", async () => {
    const user = show();
    await user.type(await screen.findByLabelText("Add a comment"), "   {Enter}");

    expect(engine.seen.some((request) => request.type === "comment:add")).toBe(false);
  });

  it("seeks the player from a timed comment", async () => {
    const video = playing(0);
    const user = show([
      { id: 7, atMs: 91_500, body: "the cut lands early", createdAt: 1, updatedAt: null },
    ]);

    await user.click(await screen.findByRole("button", { name: "Play from 1:31.5" }));
    expect(video.currentTime).toBe(91.5);
  });

  it("shows the moment as text when there is nothing to seek", async () => {
    // No preview open. A control that does nothing when pressed is worse than
    // no control: it says the timecode is a way to get somewhere.
    show([{ id: 7, atMs: 91_500, body: "the cut lands early", createdAt: 1, updatedAt: null }]);

    await screen.findByText("1:31.5");
    expect(screen.queryByRole("button", { name: "Play from 1:31.5" })).toBeNull();
  });

  it("edits in place, so the comment keeps its id", async () => {
    const user = show([{ id: 7, atMs: 91_500, body: "the cut", createdAt: 1, updatedAt: null }]);

    await user.click(await screen.findByLabelText("Edit comment"));
    await user.clear(screen.getByLabelText("Edit comment"));
    await user.type(screen.getByLabelText("Edit comment"), "the cut lands two frames early{Enter}");

    await waitFor(() => expect(commented()[0]?.body).toBe("the cut lands two frames early"));
    // The same id, and still one comment: re-adding would mint another and
    // move it to the end of every list ordered by creation.
    expect(commented()).toHaveLength(1);
    expect(commented()[0]?.id).toBe(7);
    expect(engine.seen.filter((request) => request.type === "comment:add")).toHaveLength(0);
  });

  it("keeps the moment when only the words change", async () => {
    const user = show([{ id: 7, atMs: 91_500, body: "the cut", createdAt: 1, updatedAt: null }]);

    await user.click(await screen.findByLabelText("Edit comment"));
    await user.type(screen.getByLabelText("Edit comment"), " is late{Enter}");

    await waitFor(() => expect(commented()[0]?.body).toBe("the cut is late"));
    expect(commented()[0]?.atMs).toBe(91_500);
  });

  it("cancels on Escape without sending anything", async () => {
    const user = show([{ id: 7, atMs: null, body: "the cut", createdAt: 1, updatedAt: null }]);

    await user.click(await screen.findByLabelText("Edit comment"));
    await user.type(screen.getByLabelText("Edit comment"), " is late{Escape}");

    await screen.findByText("the cut");
    expect(engine.seen.some((request) => request.type === "comment:set")).toBe(false);
  });

  it("removes one, and the list closes over it", async () => {
    const user = show([
      { id: 7, atMs: null, body: "the first", createdAt: 1, updatedAt: null },
      { id: 8, atMs: null, body: "the second", createdAt: 2, updatedAt: null },
    ]);

    const rows = await screen.findAllByLabelText("Remove comment");
    await user.click(rows[0] as HTMLElement);

    await waitFor(() => expect(commented()).toHaveLength(1));
    expect(commented()[0]?.id).toBe(8);
    expect(screen.queryByText("the first")).toBeNull();
  });

  it("draws timed comments before untimed ones, in timeline order", async () => {
    show([
      { id: 7, atMs: null, body: "about the file", createdAt: 1, updatedAt: null },
      { id: 8, atMs: 120_000, body: "later", createdAt: 2, updatedAt: null },
      { id: 9, atMs: 1_000, body: "earlier", createdAt: 3, updatedAt: null },
    ]);

    // The order the repository answers in, which is what makes the list read as
    // a timeline rather than as a log of when somebody typed.
    await screen.findByText("earlier");
    const bodies = [...document.querySelectorAll(".comment-body")].map((node) => node.textContent);
    expect(bodies).toEqual(["earlier", "later", "about the file"]);
  });

  it("does not carry a half-typed comment to the next asset", async () => {
    // The composer is keyed on the hash. Without that, selecting another asset
    // would leave the draft — and the moment — sitting in the field, ready to
    // be sent against something it was not written about.
    engine = new FakeEngine({ details: [fakeDetail(1), fakeDetail(2)] });
    install(engine);
    const user = userEvent.setup();
    const view = render(
      <Inspector hashes={[HASH]} generation={0} vocabulary={VOCABULARY} folders={[]} />,
    );
    await user.type(await screen.findByLabelText("Add a comment"), "half a thought");

    view.rerender(
      <Inspector
        hashes={[fakeDetail(2).hash]}
        generation={0}
        vocabulary={VOCABULARY}
        folders={[]}
      />,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Add a comment") as HTMLInputElement).value).toBe(""),
    );
  });
});
