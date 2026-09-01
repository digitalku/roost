import type { AssetKind, WireAssetDetail, WireComment } from "@roost/contract";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEngine, fakeDetail, install } from "../testing/fake-engine.js";
import { PreviewPane } from "./PreviewPane.js";

const HASH = fakeDetail(1).hash;

describe("the preview pane", () => {
  let engine: FakeEngine;
  let closed: number;
  let steps: number[];

  const show = (kind: AssetKind, ext = "png", over: Partial<WireAssetDetail> = {}) => {
    engine = new FakeEngine({
      details: [fakeDetail(1, { kind, ext, name: `one.${ext}`, ...over })],
    });
    install(engine);
    render(
      <PreviewPane
        hash={HASH}
        generation={0}
        onClose={() => {
          closed += 1;
        }}
        onStep={(delta) => steps.push(delta)}
      />,
    );
    return userEvent.setup();
  };

  beforeEach(() => {
    closed = 0;
    steps = [];
  });

  it("renders an image over roost://original, which is the whole file", async () => {
    show("image");
    const image = (await screen.findByRole("img", { name: "one.png" })) as HTMLImageElement;
    // Not the thumbnail: the preview is the asset, and the protocol streams it
    // rather than sending bytes through a message (ADR-0008, invariant 12).
    expect(image.getAttribute("src")).toBe(`roost://original/${HASH}`);
  });

  it("renders an SVG through the same img, which is what sandboxes it", async () => {
    show("image", "svg");
    const image = (await screen.findByRole("img", { name: "one.svg" })) as HTMLImageElement;
    expect(image.getAttribute("src")).toBe(`roost://original/${HASH}`);
    // No <object>, no <iframe>, no inline markup: scripts in an image do not
    // run, and neither do its external references.
    expect(document.querySelector("iframe, object, embed")).toBeNull();
  });

  it("renders a video with controls, so it can seek", async () => {
    show("video", "mp4");
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    const video = document.querySelector("video");
    expect(video?.getAttribute("src")).toBe(`roost://original/${HASH}`);
    // Seeking is what the range support in ADR-0008 exists for.
    expect(video?.hasAttribute("controls")).toBe(true);
  });

  it("renders audio with controls", async () => {
    show("audio", "mp3");
    await waitFor(() => expect(document.querySelector("audio")).not.toBeNull());
    expect(document.querySelector("audio")?.getAttribute("src")).toBe(`roost://original/${HASH}`);
  });

  it("offers the desktop's own application for anything it cannot draw", async () => {
    // `CONCEPT.md` §5: a library is not only a media collection, and a format
    // Roost cannot draw must not be a dead end.
    const user = show("document", "pdf");
    const open = await screen.findByRole("button", { name: "Open externally" });
    expect(screen.getByText(/cannot show a pdf yet/)).toBeDefined();
    // The thumbnail is still shown, so the fallback is not a blank page.
    expect(document.querySelector(".preview-fallback .cell-image")?.getAttribute("src")).toBe(
      `roost://thumb/${HASH}@512`,
    );

    await user.click(open);
    expect(engine.seen.filter((r) => r.type === "asset:openExternally")).toHaveLength(1);
  });

  it("steps through the list with the arrow keys, in both axes", async () => {
    const user = show("image");
    await screen.findByRole("img", { name: "one.png" });

    await user.keyboard("{ArrowRight}{ArrowDown}{ArrowLeft}{ArrowUp}");
    // Down and right both mean "next" here: the preview is a list, not a grid,
    // and someone reaching for either expects the same thing.
    expect(steps).toEqual([1, 1, -1, -1]);
  });

  it("closes on Escape and on the button", async () => {
    const user = show("image");
    await screen.findByRole("img", { name: "one.png" });

    await user.keyboard("{Escape}");
    expect(closed).toBe(1);

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(closed).toBe(2);
  });

  it("takes focus when it opens, so the arrow keys work without a click", async () => {
    show("image");
    await screen.findByRole("img", { name: "one.png" });
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("replaces the media element when the asset changes", async () => {
    // A <video> given a new `src` keeps the previous one's playback state, so
    // stepping would show a paused frame from the asset before it.
    engine = new FakeEngine({
      details: [
        fakeDetail(1, { kind: "video", ext: "mp4" }),
        fakeDetail(2, { kind: "video", ext: "mp4" }),
      ],
    });
    install(engine);
    const { rerender } = render(
      <PreviewPane hash={HASH} generation={0} onClose={vi.fn()} onStep={vi.fn()} />,
    );
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    const first = document.querySelector("video");

    const second = fakeDetail(2).hash;
    rerender(<PreviewPane hash={second} generation={0} onClose={vi.fn()} onStep={vi.fn()} />);
    await waitFor(() =>
      expect(document.querySelector("video")?.getAttribute("src")).toBe(
        `roost://original/${second}`,
      ),
    );
    expect(document.querySelector("video")).not.toBe(first);
  });
});

describe("the comment markers under the player", () => {
  const HOUR = 3_600_000;

  const showVideo = (comments: readonly WireComment[], durationMs: number | null = HOUR) => {
    const engine = new FakeEngine({
      details: [fakeDetail(1, { kind: "video", ext: "mp4", durationMs, comments })],
    });
    install(engine);
    render(<PreviewPane hash={HASH} generation={0} onClose={vi.fn()} onStep={vi.fn()} />);
    return { engine, user: userEvent.setup() };
  };

  it("places a tick along the medium's own timeline", async () => {
    showVideo([
      { id: 7, atMs: HOUR / 4, body: "the cut lands early", createdAt: 1, updatedAt: null },
    ]);

    const tick = await screen.findByRole("button", {
      name: "Play from 15:00.0: the cut lands early",
    });
    // A quarter of the way in, and centred on the moment rather than starting
    // at it — a 3px tick drawn from the offset would sit consistently late.
    expect((tick as HTMLElement).style.left).toBe("25%");
  });

  it("seeks the player, which is the whole point of the strip", async () => {
    const { user } = showVideo([
      { id: 7, atMs: 91_500, body: "the cut lands early", createdAt: 1, updatedAt: null },
    ]);

    await user.click(
      await screen.findByRole("button", { name: "Play from 1:31.5: the cut lands early" }),
    );
    // The native control bar cannot carry marks of ours, so the strip drives
    // the element directly (ADR-0023 §6).
    expect(document.querySelector("video")?.currentTime).toBe(91.5);
  });

  it("leaves untimed comments off it", async () => {
    // They are about the asset rather than about a moment in it, and a tick at
    // zero would say something the comment does not. The inspector's list holds
    // both.
    showVideo([{ id: 7, atMs: null, body: "the export is 8-bit", createdAt: 1, updatedAt: null }]);

    await waitFor(() => expect(document.querySelector(".preview-markers")).not.toBeNull());
    expect(document.querySelectorAll(".preview-marker")).toHaveLength(0);
  });

  it("draws the strip with nothing on it, so the first comment moves nothing", async () => {
    showVideo([]);
    await waitFor(() => expect(document.querySelector(".preview-markers")).not.toBeNull());
  });

  it("places nothing while the duration is unknown", async () => {
    // `durationMs` is null until the probe has been over the file, and happy-dom
    // reports the element's own duration as NaN — which is what an element that
    // has loaded no media really does say. A marker at 0% would be a guess.
    showVideo(
      [{ id: 7, atMs: 91_500, body: "the cut lands early", createdAt: 1, updatedAt: null }],
      null,
    );

    await waitFor(() => expect(document.querySelector(".preview-markers")).not.toBeNull());
    expect(document.querySelectorAll(".preview-marker")).toHaveLength(0);
  });

  it("places the ticks once the probe answers, even if the element never loads", async () => {
    // Found in a real window on 2026-09-02, against a video Chromium refused to
    // decode: the library knew the duration and the strip stayed empty. The
    // duration was seeded into state from the first detail, so a preview opened
    // before the derive pass had been over the file held `null` for as long as
    // it stayed open — and `loadedmetadata` never fires to correct it when the
    // element itself will not load. It is derived from the prop now.
    const engine = new FakeEngine({
      details: [
        fakeDetail(1, {
          kind: "video",
          ext: "mp4",
          durationMs: null,
          comments: [{ id: 7, atMs: HOUR / 2, body: "halfway", createdAt: 1, updatedAt: null }],
        }),
      ],
    });
    install(engine);
    const view = render(
      <PreviewPane hash={HASH} generation={0} onClose={vi.fn()} onStep={vi.fn()} />,
    );
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    expect(document.querySelectorAll(".preview-marker")).toHaveLength(0);

    const held = engine.details.get(HASH);
    if (held === undefined) throw new Error("the fake lost the asset");
    engine.details.set(HASH, { ...held, durationMs: HOUR });
    view.rerender(<PreviewPane hash={HASH} generation={1} onClose={vi.fn()} onStep={vi.fn()} />);

    await screen.findByRole("button", { name: "Play from 30:00.0: halfway" });
  });

  it("re-reads when the library changes, so a comment written beside it appears", async () => {
    // The inspector is on screen next to the preview and edits the same asset.
    // Without the re-read the strip would be right only until somebody used the
    // panel beside it.
    const engine = new FakeEngine({
      details: [fakeDetail(1, { kind: "video", ext: "mp4", durationMs: HOUR })],
    });
    install(engine);
    const view = render(
      <PreviewPane hash={HASH} generation={0} onClose={vi.fn()} onStep={vi.fn()} />,
    );
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    expect(document.querySelectorAll(".preview-marker")).toHaveLength(0);

    await engine
      .bridge()
      .invoke({ type: "comment:add", hash: HASH, atMs: HOUR / 2, body: "halfway" });
    view.rerender(<PreviewPane hash={HASH} generation={1} onClose={vi.fn()} onStep={vi.fn()} />);

    await screen.findByRole("button", { name: "Play from 30:00.0: halfway" });
  });

  it("keeps playing through a re-read of the same asset", async () => {
    // Blanking the pane on every announced change would restart a video that is
    // playing — and a library announces a change on every edit anywhere in it.
    const engine = new FakeEngine({
      details: [fakeDetail(1, { kind: "video", ext: "mp4", durationMs: HOUR })],
    });
    install(engine);
    const view = render(
      <PreviewPane hash={HASH} generation={0} onClose={vi.fn()} onStep={vi.fn()} />,
    );
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    const playing = document.querySelector("video");

    view.rerender(<PreviewPane hash={HASH} generation={1} onClose={vi.fn()} onStep={vi.fn()} />);
    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "asset:detail")).toHaveLength(2),
    );
    expect(document.querySelector("video")).toBe(playing);
  });
});

describe("a document with pages to turn", () => {
  const showDocument = (pageCount: number | null) => {
    const engine = new FakeEngine({
      details: [fakeDetail(1, { kind: "document", ext: "pdf", name: "report.pdf", pageCount })],
    });
    install(engine);
    render(
      <PreviewPane hash={HASH} generation={0} onClose={() => undefined} onStep={() => undefined} />,
    );
    return userEvent.setup();
  };

  it("renders a page over roost://page, rather than the file itself", async () => {
    showDocument(3);

    const page = (await screen.findByRole("img", { name: "Page 1 of 3" })) as HTMLImageElement;
    // A rendering per page, made on demand by main: a library that stored one
    // per page would be storing a picture nobody asked for.
    expect(page.getAttribute("src")).toBe(`roost://page/${HASH}/0@1024`);
  });

  it("turns pages, and stops at both ends", async () => {
    const user = showDocument(2);

    await screen.findByRole("img", { name: "Page 1 of 2" });
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await user.click(screen.getByRole("button", { name: "Next" }));
    const page = (await screen.findByRole("img", { name: "Page 2 of 2" })) as HTMLImageElement;
    expect(page.getAttribute("src")).toBe(`roost://page/${HASH}/1@1024`);
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("falls back to the thumbnail for a document nobody has counted yet", async () => {
    // `pageCount` is null until the derive pass has been over it, and a pager
    // with one page in it would be a lie about a fifty-page document.
    showDocument(null);

    await waitFor(() => expect(screen.queryByText("Open externally")).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });
});

describe("a font", () => {
  it("shows the specimen the derive pass drew, and what the font calls itself", async () => {
    const engine = new FakeEngine({
      details: [
        fakeDetail(1, {
          kind: "font",
          ext: "ttf",
          name: "Timber.ttf",
          props: { "font.family": "Timber Sans", "font.style": "Italic" },
        }),
      ],
    });
    install(engine);
    render(
      <PreviewPane hash={HASH} generation={0} onClose={() => undefined} onStep={() => undefined} />,
    );

    const specimen = (await screen.findByRole("img", {
      name: "Specimen of Timber Sans",
    })) as HTMLImageElement;
    // A stored thumbnail, drawn from outlines by the engine — the window never
    // loads a font to show one (ADR-0015).
    expect(specimen.getAttribute("src")).toBe(`roost://thumb/${HASH}@512`);
    expect(screen.getByText("Timber Sans · Italic")).toBeDefined();
  });
});
