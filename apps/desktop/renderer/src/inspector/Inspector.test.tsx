import type { Outcome, RequestOf, RequestType, ResponseOf, WireAssetDetail } from "@roost/contract";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEngine, fakeDetail, install } from "../testing/fake-engine.js";
import { Inspector } from "./Inspector.js";

/**
 * The panel, driven the way a person drives it.
 *
 * The claim under test throughout is the one `UI_SPEC.md` makes: every edit
 * reads the record back. The fake engine normalises the same things the real
 * one does — a trimmed name, a dropped whitespace note, deduplicated tags — so
 * a component that displayed what it typed would show something the fake does
 * not hold, and these would fail.
 */

const HASH = fakeDetail(1).hash;

describe("the inspector", () => {
  let engine: FakeEngine;

  const show = (over: Parameters<typeof fakeDetail>[1] = {}, hash: string | undefined = HASH) => {
    engine = new FakeEngine({ details: [fakeDetail(1, over)] });
    install(engine);
    const view = render(<Inspector hashes={hash === undefined ? [] : [hash]} generation={0} />);
    return { user: userEvent.setup(), ...view };
  };

  beforeEach(() => {
    vi.useRealTimers();
  });

  it("lists the caption tracks, and detaching does not delete one", async () => {
    // Here rather than in the sidebar: a sidebar row is a query, and a query
    // cannot mean "the tracks of whatever is selected" (ADR-0025).
    const { user } = show({
      subtitles: [
        { hash: "f".repeat(64), lang: "id", label: null, name: "holiday.id.srt", servable: true },
      ],
    });

    const block = await screen.findByRole("region", { name: "Subtitles" });
    expect(block.textContent).toContain("holiday.id.srt");
    expect(block.textContent).toContain("id");

    // Opening and revealing act on the **track**, not on the asset it captions.
    await user.click(within(block).getByRole("button", { name: "Open" }));
    await user.click(within(block).getByRole("button", { name: "Show in file manager" }));
    await waitFor(() =>
      expect(engine.seen.filter((request) => request.type === "asset:openExternally")).toEqual([
        { type: "asset:openExternally", hash: "f".repeat(64) },
      ]),
    );
    expect(engine.seen.filter((request) => request.type === "asset:reveal")).toEqual([
      { type: "asset:reveal", hash: "f".repeat(64) },
    ]);

    // One gesture, one request: detach *and* trash, because somebody finished
    // with a track is finished with the file (ADR-0025, ADR-0022).
    await user.click(within(block).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(engine.seen.filter((request) => request.type === "asset:subtitleDelete")).toEqual([
        { type: "asset:subtitleDelete", hash: HASH, track: "f".repeat(64) },
      ]),
    );
    // The trash, not a permanent removal — `Delete` means the same thing here
    // as everywhere else, and asks nothing because it is reversible.
    expect(engine.seen.some((request) => request.type === "assets:remove")).toBe(false);
  });

  it("draws no subtitle block where nothing is attached", async () => {
    show();
    await screen.findByRole("region", { name: "Metadata" }).catch(() => undefined);
    expect(screen.queryByRole("region", { name: "Subtitles" })).toBeNull();
  });

  it("keeps its place when nothing is selected, and says why it is empty", () => {
    // It used to render nothing at all, which took the grid from four columns
    // to two and back on every click on the background — measured in a real
    // window, 1040px against 760px. The panel stays; what changes is what is
    // in it, and an empty *state* is not the shell of disabled controls the
    // old rule was avoiding (`UI_SPEC.md` §8).
    //
    // **Rendered directly rather than through `show`.** Its `hash` parameter
    // has a default, so `show({}, undefined)` selects the default rather than
    // an empty selection — which is why the test this replaces passed while
    // asserting something else entirely: it was reading the first render,
    // before the detail arrived, and would have passed with no selection logic
    // in the component at all (`TODO.md` §4, lesson 9).
    engine = new FakeEngine({});
    install(engine);
    render(<Inspector hashes={[]} generation={0} />);
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeDefined();
    expect(screen.getByText("Nothing selected")).toBeDefined();
    // Nothing editable: a control here would act on no asset at all.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("empties itself for an asset the library no longer holds, without vanishing", async () => {
    // A selection can outlive the asset it points at. An empty panel is the
    // answer to that, not an error — and not a missing panel either, or the
    // grid reflows behind a selection that is still there.
    engine = new FakeEngine({ details: [] });
    install(engine);
    render(<Inspector hashes={[HASH]} generation={0} />);
    await waitFor(() => expect(engine.seen.some((r) => r.type === "asset:detail")).toBe(true));
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeDefined();
    // Not the empty-selection wording: something *is* selected.
    expect(screen.queryByText("Nothing selected")).toBeNull();
  });

  it("shows what the library knows", async () => {
    show({ name: "photo.png", size: 2048, width: 800, height: 600, tags: ["wood"] });
    expect(await screen.findByRole("complementary", { name: "Inspector" })).toBeDefined();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("photo.png");
    expect(screen.getByText("2.0 KiB")).toBeDefined();
    expect(screen.getByText("800 × 600")).toBeDefined();
    expect(screen.getByText("wood")).toBeDefined();
    expect(screen.getByText(HASH)).toBeDefined();
  });

  it("tells a video's codec apart from its audio's", async () => {
    // Both rows said "Codec" — reported from a real library on 2026-09-01,
    // where a webm showed `av1` over `opus` with nothing to say which was
    // which. Qualifying only the audio one would have moved the ambiguity to
    // a file with a single track rather than removed it.
    show({
      props: {
        "video.codec": "av1",
        "video.fps": "29.97",
        "audio.codec": "opus",
        "audio.channels": "2",
      },
    });
    expect(await screen.findByText("Video codec")).toBeDefined();
    expect(screen.getByText("Audio codec")).toBeDefined();
    expect(screen.queryByText("Codec")).toBeNull();
    expect(screen.getByText("av1")).toBeDefined();
    expect(screen.getByText("opus")).toBeDefined();
  });

  it("shows the 512px preview, served over roost://", async () => {
    // Invariant 12 and ADR-0008. The 512 is generated on first use, so an
    // asset nobody has opened has none and the extension shows through — the
    // same placeholder the grid draws, for the same reason.
    show({ ext: "png" });
    await screen.findByRole("complementary");
    const image = document.querySelector<HTMLImageElement>(".inspector-preview .cell-image");
    expect(image?.getAttribute("src")).toBe(`roost://thumb/${HASH}@512`);
    expect(document.querySelector(".inspector-preview .cell-kind")?.textContent).toBe("png");
  });

  it("rates, and clears by clicking the star already set", async () => {
    const { user } = show();
    await screen.findByRole("button", { name: "4 stars" });

    await user.click(screen.getByRole("button", { name: "4 stars" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "4 stars" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );

    // `null` is unrated and is not zero (`DATA_MODEL.md`), and this gesture is
    // the only one that can say so without a second control.
    await user.click(screen.getByRole("button", { name: "4 stars" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "4 stars" }).getAttribute("aria-pressed")).toBe(
        "false",
      ),
    );
    const rates = engine.seen.filter((r) => r.type === "asset:rate");
    expect(rates.map((r) => (r as { rating: number | null }).rating)).toEqual([4, null]);
  });

  it("adds a tag on Enter and shows the tag the engine kept", async () => {
    const { user } = show({ tags: ["wood"] });
    await screen.findByLabelText("Add a tag");

    // The fake deduplicates the way the engine does, so what comes back is one
    // tag rather than two — which is the whole reason for the re-read.
    await user.type(screen.getByLabelText("Add a tag"), "  wood  {Enter}");
    await waitFor(() => expect(screen.getAllByText("wood")).toHaveLength(1));
    expect((screen.getByLabelText("Add a tag") as HTMLInputElement).value).toBe("");
  });

  it("removes a tag", async () => {
    const { user } = show({ tags: ["wood", "metal"] });
    await user.click(await screen.findByRole("button", { name: "Remove wood" }));
    await waitFor(() => expect(screen.queryByText("wood")).toBeNull());
    expect(screen.getByText("metal")).toBeDefined();
  });

  it("renames on blur, and shows the name the engine stored", async () => {
    const { user } = show({ name: "one.png" });
    const field = await screen.findByLabelText("Name");

    await user.clear(field);
    await user.type(field, "  two.png  ");
    await user.tab();

    // Trimmed by the engine. Displaying the draft would show two spaces that
    // the library does not hold.
    await waitFor(() => expect((field as HTMLInputElement).value).toBe("two.png"));
  });

  it("puts the stored name back on Escape", async () => {
    const { user } = show({ name: "one.png" });
    const field = (await screen.findByLabelText("Name")) as HTMLInputElement;
    await user.clear(field);
    await user.type(field, "typo{Escape}");
    expect(field.value).toBe("one.png");
    expect(engine.seen.some((r) => r.type === "asset:rename")).toBe(false);
  });

  it("saves a note on blur, and drops one that is only whitespace", async () => {
    const { user } = show();
    const note = await screen.findByLabelText("Note");

    await user.type(note, "   ");
    await user.tab();
    await waitFor(() => expect(engine.seen.some((r) => r.type === "asset:note")).toBe(true));
    // An empty note badge that is on forever and says nothing is worse than no
    // badge, so the engine stores `null` — and the panel shows what it stored.
    await waitFor(() => expect((note as HTMLTextAreaElement).value).toBe(""));
  });

  /**
   * Where the file came from (ADR-0030).
   *
   * Three claims in one test, because they are one behaviour: the value is
   * stored as typed, the open button appears only for what the desktop should
   * be handed, and clicking it asks main rather than fetching anything.
   */
  it("saves a source and offers to open it only when it is an http(s) link", async () => {
    const { user } = show();
    const field = await screen.findByLabelText("Source");

    // A bare hostname is a perfectly good answer to "where did this come from",
    // so it is stored — and it is *not* offered as a link, because handing an
    // arbitrary string to the desktop's URL handler on a click is not a thing
    // to do. A control that cannot be operated is worse than an absent one.
    await user.type(field, "instagram.com/p/xyz");
    await user.tab();
    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "asset:source")[0]).toMatchObject({
        url: "instagram.com/p/xyz",
      }),
    );
    expect(screen.queryByRole("button", { name: "Open source in browser" })).toBeNull();

    await user.clear(field);
    await user.type(field, "https://example.com/a{Enter}");
    // Enter is the save: one value and no paragraphs, so there is no second
    // line for it to make.
    const open = await screen.findByRole("button", { name: "Open source in browser" });

    await user.click(open);
    expect(engine.seen.filter((r) => r.type === "link:open")).toEqual([
      { type: "link:open", url: "https://example.com/a" },
    ]);
  });

  it("hands the file to the desktop when asked", async () => {
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Open externally" }));
    // `CONCEPT.md` §5: a format Roost cannot draw must not be a dead end.
    expect(engine.seen.filter((r) => r.type === "asset:openExternally")).toHaveLength(1);
  });

  it("re-reads when something outside it changed the library", async () => {
    engine = new FakeEngine({ details: [fakeDetail(1, { rating: 2 })] });
    install(engine);
    const { rerender } = render(<Inspector hashes={[HASH]} generation={0} />);
    await screen.findByRole("button", { name: "4 stars" });
    const before = engine.seen.filter((r) => r.type === "asset:detail").length;

    rerender(<Inspector hashes={[HASH]} generation={1} />);
    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "asset:detail").length).toBeGreaterThan(before),
    );
  });
});

describe("what a re-read must and must not overwrite", () => {
  it("adopts a normalised name even when the stored value did not change", async () => {
    // The subtle half of "every edit reads the record back". `one.png  ` is
    // stored as `one.png`, which is what was already there — so watching the
    // value would see no change and the field would go on showing a trailing
    // space the library does not hold, visible only after a reload.
    const engine = new FakeEngine({ details: [fakeDetail(1, { name: "one.png" })] });
    install(engine);
    render(<Inspector hashes={[HASH]} generation={0} />);
    const user = userEvent.setup();

    const field = (await screen.findByLabelText("Name")) as HTMLInputElement;
    await user.type(field, "  ");
    expect(field.value).toBe("one.png  ");
    await user.tab();

    await waitFor(() => expect(field.value).toBe("one.png"));
  });

  it("does not stomp a half-typed note when something else changed the library", async () => {
    const engine = new FakeEngine({ details: [fakeDetail(1)] });
    install(engine);
    const { rerender } = render(<Inspector hashes={[HASH]} generation={0} />);
    const user = userEvent.setup();

    const note = (await screen.findByLabelText("Note")) as HTMLTextAreaElement;
    await user.type(note, "half a th");

    // An edit elsewhere re-reads this asset too. Losing what is being typed
    // because an unrelated asset was tagged is the bug this guards.
    rerender(<Inspector hashes={[HASH]} generation={1} />);
    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "asset:detail").length).toBe(2),
    );
    expect(note.value).toBe("half a th");
  });
});

/**
 * A selection of several assets.
 *
 * The bug this covers was reported from real use on 2026-08-30: selecting five
 * assets and adding a tag tagged one of them. **Every assertion here counts the
 * hashes that were sent**, because the broken version would have passed any
 * test that only asked whether the tag arrived.
 */
describe("the inspector over several assets", () => {
  let engine: FakeEngine;

  const THREE = [0, 1, 2].map((index) => fakeDetail(index).hash);

  const show = (details: readonly Partial<WireAssetDetail>[]) => {
    engine = new FakeEngine({
      details: details.map((over, index) => fakeDetail(index, over)),
    });
    install(engine);
    const view = render(<Inspector hashes={THREE} generation={0} />);
    return { user: userEvent.setup(), ...view };
  };

  /** The hashes the last request of `type` carried. */
  const sentTo = (type: string): readonly string[] => {
    const last = [...engine.seen].reverse().find((request) => request.type === type);
    return (last as { hashes?: readonly string[] } | undefined)?.hashes ?? [];
  };

  it("adds a tag to every selected asset, not to one of them", async () => {
    const { user } = show([{}, {}, {}]);
    await screen.findByText("3 assets");

    await user.type(screen.getByLabelText("Add a tag"), "wood{Enter}");

    await waitFor(() => expect(sentTo("asset:tagAdd")).toHaveLength(3));
    expect(sentTo("asset:tagAdd")).toEqual(THREE);
  });

  it("rates every selected asset", async () => {
    const { user } = show([{}, {}, {}]);
    await screen.findByText("3 assets");

    await user.click(screen.getByRole("button", { name: "4 stars" }));

    await waitFor(() => expect(sentTo("asset:rate")).toEqual(THREE));
  });

  it("says the rating is mixed, and a click sets rather than clears", async () => {
    // Clicking the star they already share clears it — but a selection that
    // disagrees has no shared rating to clear, so the same click must set.
    const { user } = show([{ rating: 4 }, { rating: 2 }, { rating: 4 }]);
    expect(await screen.findByText("mixed")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "4 stars" }));

    await waitFor(() => expect(engine.seen.some((r) => r.type === "asset:rate")).toBe(true));
    const request = [...engine.seen].reverse().find((r) => r.type === "asset:rate");
    expect((request as { rating: number | null }).rating).toBe(4);
  });

  it("clears the rating they all share, the way one asset does", async () => {
    const { user } = show([{ rating: 3 }, { rating: 3 }, { rating: 3 }]);
    await screen.findByText("3 assets");
    expect(screen.queryByText("mixed")).toBeNull();

    await user.click(screen.getByRole("button", { name: "3 stars" }));

    await waitFor(() => expect(engine.seen.some((r) => r.type === "asset:rate")).toBe(true));
    const request = [...engine.seen].reverse().find((r) => r.type === "asset:rate");
    expect((request as { rating: number | null }).rating).toBeNull();
  });

  it("draws a tag some of them carry apart from one they all carry", async () => {
    show([{ tags: ["wood", "wip"] }, { tags: ["wood"] }, { tags: ["wood"] }]);
    await screen.findByText("3 assets");

    const shared = screen.getByText("wood").closest("li");
    const partial = screen.getByText("wip").closest("li");
    expect(shared?.hasAttribute("data-partial")).toBe(false);
    expect(partial?.hasAttribute("data-partial")).toBe(true);
  });

  it("removes a tag from the whole selection", async () => {
    const { user } = show([{ tags: ["wood"] }, { tags: ["wood"] }, { tags: ["wood"] }]);
    await screen.findByText("3 assets");

    await user.click(screen.getByRole("button", { name: "Remove wood" }));

    await waitFor(() => expect(sentTo("asset:tagRemove")).toEqual(THREE));
  });

  it("offers no name, no note, and no preview", async () => {
    // Each of the three would be wrong in its own way: a name is unique to one
    // asset, a note written across twelve would destroy eleven, and one
    // asset's picture over controls that edit all of them is the misreading
    // this whole panel exists to correct.
    show([{}, {}, {}]);
    await screen.findByText("3 assets");

    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByLabelText("Note")).toBeNull();
    expect(document.querySelector(".inspector-preview")).toBeNull();
  });

  it("asks once for the whole selection rather than once per asset", async () => {
    // A selection is routinely hundreds of rows. One detail request each would
    // be hundreds of round trips for a panel showing a summary.
    show([{}, {}, {}]);
    await screen.findByText("3 assets");

    expect(engine.seen.filter((r) => r.type === "asset:summary")).toHaveLength(1);
    expect(engine.seen.filter((r) => r.type === "asset:detail")).toHaveLength(0);
  });

  it("ignores an answer the selection has already moved past", async () => {
    // A marquee sweep changes the selection on every frame it crosses a cell,
    // so several reads are in flight at once and they resolve in whatever
    // order they finish. Without a guard the panel settles on the summary of a
    // selection the drag left behind — which reads as the count sticking.
    const engine = new FakeEngine({ details: [0, 1, 2].map((index) => fakeDetail(index)) });
    const real = engine.bridge();
    const held: (() => void)[] = [];
    install(engine);
    Object.defineProperty(window, "roost", {
      configurable: true,
      writable: true,
      value: {
        ...real,
        invoke: function invoke<T extends RequestType>(
          request: RequestOf<T>,
        ): Promise<Outcome<ResponseOf<T>>> {
          const answer = real.invoke(request);
          if (request.type !== "asset:summary") return answer;
          return new Promise((resolve) => {
            held.push(() => void answer.then(resolve));
          });
        },
      },
    });

    const view = render(<Inspector hashes={THREE.slice(0, 2)} generation={0} />);
    await waitFor(() => expect(held).toHaveLength(1));
    view.rerender(<Inspector hashes={THREE} generation={0} />);
    await waitFor(() => expect(held).toHaveLength(2));

    // The newer read answers first, the older one after it.
    await act(async () => {
      held[1]?.();
    });
    expect(screen.getByText("3 assets")).toBeDefined();

    await act(async () => {
      held[0]?.();
    });
    expect(screen.getByText("3 assets")).toBeDefined();
  });
});
