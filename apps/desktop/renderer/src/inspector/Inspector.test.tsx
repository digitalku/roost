import { render, screen, waitFor } from "@testing-library/react";
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
    const view = render(<Inspector hash={hash} generation={0} />);
    return { user: userEvent.setup(), ...view };
  };

  beforeEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when nothing is focused", () => {
    show({}, undefined);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("renders nothing for an asset the library no longer holds", async () => {
    // A selection can outlive the asset it points at. An empty panel is the
    // answer to that, not an error.
    engine = new FakeEngine({ details: [] });
    install(engine);
    render(<Inspector hash={HASH} generation={0} />);
    await waitFor(() => expect(engine.seen.some((r) => r.type === "asset:detail")).toBe(true));
    expect(screen.queryByRole("complementary")).toBeNull();
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

  it("toggles the favourite", async () => {
    const { user } = show();
    const star = await screen.findByRole("button", { name: "Favorite" });
    expect(star.getAttribute("aria-pressed")).toBe("false");

    await user.click(star);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Favorite" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
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

  it("hands the file to the desktop when asked", async () => {
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Open externally" }));
    // `CONCEPT.md` §5: a format Roost cannot draw must not be a dead end.
    expect(engine.seen.filter((r) => r.type === "asset:openExternally")).toHaveLength(1);
  });

  it("re-reads when something outside it changed the library", async () => {
    engine = new FakeEngine({ details: [fakeDetail(1, { rating: 2 })] });
    install(engine);
    const { rerender } = render(<Inspector hash={HASH} generation={0} />);
    await screen.findByRole("button", { name: "4 stars" });
    const before = engine.seen.filter((r) => r.type === "asset:detail").length;

    rerender(<Inspector hash={HASH} generation={1} />);
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
    render(<Inspector hash={HASH} generation={0} />);
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
    const { rerender } = render(<Inspector hash={HASH} generation={0} />);
    const user = userEvent.setup();

    const note = (await screen.findByLabelText("Note")) as HTMLTextAreaElement;
    await user.type(note, "half a th");

    // An edit elsewhere re-reads this asset too. Losing what is being typed
    // because an unrelated asset was tagged is the bug this guards.
    rerender(<Inspector hash={HASH} generation={1} />);
    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "asset:detail").length).toBe(2),
    );
    expect(note.value).toBe("half a th");
  });
});
