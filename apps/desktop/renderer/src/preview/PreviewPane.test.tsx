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

  const show = (
    kind: AssetKind,
    ext = "png",
    over: Partial<WireAssetDetail> = {},
    options: ConstructorParameters<typeof FakeEngine>[0] = {},
  ) => {
    engine = new FakeEngine({
      details: [fakeDetail(1, { kind, ext, name: `one.${ext}`, ...over })],
      ...options,
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

  it("hands a text file to the application that owns it", async () => {
    // A viewer and an editor were built on 2026-09-03 and withdrawn on
    // 2026-09-04: showing a text file means owning an editor to go with it, and
    // an external editor is enough. So a `.txt` reaches the same place every
    // format Roost cannot draw does.
    show("other", "txt");
    expect(await screen.findByRole("button", { name: "Open externally" })).toBeDefined();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("hangs a caption track on the video, and never turns it on by itself", async () => {
    show("video", "mp4", {
      durationMs: 60_000,
      subtitles: [
        { hash: "f".repeat(64), lang: "id", label: null, name: "film.srt", servable: true },
        // Needs ffmpeg, so no `<track>` — one pointed at a URL answering 415 is
        // an empty track with no error anywhere (ADR-0025).
        { hash: "9".repeat(64), lang: null, label: null, name: "film.ass", servable: false },
      ],
    });
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());

    const tracks = [...document.querySelectorAll("track")];
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.getAttribute("src")).toBe(`roost://subtitle/${"f".repeat(64)}`);
    expect(tracks[0]?.getAttribute("srclang")).toBe("id");
    // A subtitle that turns itself on is the thing people go looking for the
    // button to turn off.
    expect(tracks[0]?.hasAttribute("default")).toBe(false);
    expect(await screen.findByRole("button", { name: "Subtitles" })).toBeDefined();
  });

  it("offers to add one even where nothing is attached", async () => {
    // The moment somebody notices there are no subtitles is the moment they
    // want to add one, so the menu is worth opening then (ADR-0025).
    const user = show(
      "video",
      "mp4",
      { durationMs: 60_000 },
      {
        subtitleDialog: ["/home/you/holiday.srt"],
      },
    );
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());

    await user.click(await screen.findByRole("button", { name: "Subtitles" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add subtitle…" }));

    // The subtitle chooser, not the import one: that offers folders and says
    // "Import" on its button, and a folder is not something this can use.
    expect(engine.seen.map((request) => request.type)).toContain("dialog:chooseSubtitle");
    expect(engine.seen.some((request) => request.type === "dialog:chooseImport")).toBe(false);
    // What comes back is imported and attached in one request: apart, the two
    // leave a track attached to nothing.
    await waitFor(() =>
      expect(engine.seen.map((request) => request.type)).toContain("asset:addSubtitle"),
    );
    const sent = engine.seen.find((request) => request.type === "asset:addSubtitle");
    expect(sent).toMatchObject({ hash: HASH, paths: ["/home/you/holiday.srt"] });
  });

  it("renders a video under a transport of ours, not the browser's bar", async () => {
    show("video", "mp4");
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    const video = document.querySelector("video");
    expect(video?.getAttribute("src")).toBe(`roost://original/${HASH}`);
    // `controls` off is the whole of ADR-0024: the native bar is a closed
    // widget, so a comment mark could only ever sit beside the timeline.
    expect(video?.hasAttribute("controls")).toBe(false);
    expect(screen.getByRole("slider", { name: "Timeline" })).toBeDefined();
  });

  it("gives audio the same transport", async () => {
    // Two implementations of one control is how they come to disagree, and an
    // audio file has the same timeline and the same comments (ADR-0024).
    show("audio", "mp3");
    await waitFor(() => expect(document.querySelector("audio")).not.toBeNull());
    expect(document.querySelector("audio")?.getAttribute("src")).toBe(`roost://original/${HASH}`);
    expect(document.querySelector("audio")?.hasAttribute("controls")).toBe(false);
    expect(screen.getByRole("slider", { name: "Timeline" })).toBeDefined();
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

describe("the transport", () => {
  const HOUR = 3_600_000;

  const showVideo = (
    comments: readonly WireComment[] = [],
    durationMs: number | null = HOUR,
    props: Record<string, string> = {},
  ) => {
    const engine = new FakeEngine({
      details: [fakeDetail(1, { kind: "video", ext: "mp4", durationMs, comments, props })],
    });
    install(engine);
    render(<PreviewPane hash={HASH} generation={0} onClose={vi.fn()} onStep={vi.fn()} />);
    return { engine, user: userEvent.setup() };
  };

  /** The element, once React has mounted it. */
  const player = async (): Promise<HTMLVideoElement> => {
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    const video = document.querySelector("video");
    if (video === null) throw new Error("no player");
    return video;
  };

  /**
   * What a real element announces after a change, and happy-dom does not.
   *
   * `volumechange` is an explicit gap in happy-dom's media element — the
   * property is set and no event follows it. Dispatching it by hand is the
   * honest test of the claim this transport is built on: it holds no copy of
   * what the element knows, and redraws from what the element says.
   */
  const announce = (media: HTMLMediaElement, event: string): void => {
    media.dispatchEvent(new Event(event));
  };

  it("places a mark along the medium's own timeline", async () => {
    showVideo([
      { id: 7, atMs: HOUR / 4, body: "the cut lands early", createdAt: 1, updatedAt: null },
    ]);

    const mark = await screen.findByRole("button", {
      name: "Play from 15:00.0: the cut lands early",
    });
    // On the timeline, at its moment — which is the whole reason the transport
    // is ours (ADR-0024). A quarter of the way in, centred on the moment.
    expect(mark.classList.contains("transport-mark")).toBe(true);
    expect((mark as HTMLElement).style.left).toBe("25%");
  });

  it("seeks the player from a mark", async () => {
    const { user } = showVideo([
      { id: 7, atMs: 91_500, body: "the cut lands early", createdAt: 1, updatedAt: null },
    ]);
    const video = await player();

    await user.click(
      await screen.findByRole("button", { name: "Play from 1:31.5: the cut lands early" }),
    );
    expect(video.currentTime).toBe(91.5);
  });

  it("leaves untimed comments off the timeline", async () => {
    // They are about the asset rather than about a moment in it, and a mark at
    // zero would say something the comment does not. The inspector's list holds
    // both.
    showVideo([{ id: 7, atMs: null, body: "the export is 8-bit", createdAt: 1, updatedAt: null }]);

    await player();
    expect(document.querySelectorAll(".transport-mark")).toHaveLength(0);
  });

  it("places nothing while the duration is unknown", async () => {
    // `durationMs` is null until the probe has been over the file, and happy-dom
    // reports the element's own duration as NaN — which is what an element that
    // has loaded no media really does say. A mark at 0% would be a guess.
    showVideo(
      [{ id: 7, atMs: 91_500, body: "the cut lands early", createdAt: 1, updatedAt: null }],
      null,
    );

    await player();
    expect(document.querySelectorAll(".transport-mark")).toHaveLength(0);
    // And the timeline says so rather than pretending to be at the start.
    expect(screen.getByRole("slider", { name: "Timeline" }).getAttribute("aria-valuetext")).toBe(
      "Duration unknown",
    );
  });

  it("places the marks once the probe answers, even if the element never loads", async () => {
    // Found in a real window on 2026-09-02, against a video Chromium refused to
    // decode: the library knew the duration and the timeline stayed empty. The
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
    await player();
    expect(document.querySelectorAll(".transport-mark")).toHaveLength(0);

    const held = engine.details.get(HASH);
    if (held === undefined) throw new Error("the fake lost the asset");
    engine.details.set(HASH, { ...held, durationMs: HOUR });
    view.rerender(<PreviewPane hash={HASH} generation={1} onClose={vi.fn()} onStep={vi.fn()} />);

    await screen.findByRole("button", { name: "Play from 30:00.0: halfway" });
  });

  it("re-reads when the library changes, so a comment written beside it appears", async () => {
    // The inspector is on screen next to the preview and edits the same asset.
    // Without the re-read the timeline would be right only until somebody used
    // the panel beside it.
    const engine = new FakeEngine({
      details: [fakeDetail(1, { kind: "video", ext: "mp4", durationMs: HOUR })],
    });
    install(engine);
    const view = render(
      <PreviewPane hash={HASH} generation={0} onClose={vi.fn()} onStep={vi.fn()} />,
    );
    await player();
    expect(document.querySelectorAll(".transport-mark")).toHaveLength(0);

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
    const playing = await player();

    view.rerender(<PreviewPane hash={HASH} generation={1} onClose={vi.fn()} onStep={vi.fn()} />);
    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "asset:detail")).toHaveLength(2),
    );
    expect(document.querySelector("video")).toBe(playing);
  });

  it("draws the button the element's own state says, not one it kept itself", async () => {
    const { user } = showVideo();
    const video = await player();

    await user.click(screen.getByRole("button", { name: "Play" }));
    expect(video.paused).toBe(false);
    // The element announced `play` and the transport read it back. Nothing here
    // decided it was playing on its own, which is what lets the keyboard and
    // the button drive the same element without agreeing on anything.
    await screen.findByRole("button", { name: "Pause" });

    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(video.paused).toBe(true);
    await screen.findByRole("button", { name: "Play" });
  });

  it("plays on Space and on K, without stepping to the next asset", async () => {
    const steps: number[] = [];
    const engine = new FakeEngine({
      details: [fakeDetail(1, { kind: "video", ext: "mp4", durationMs: HOUR })],
    });
    install(engine);
    render(
      <PreviewPane
        hash={HASH}
        generation={0}
        onClose={vi.fn()}
        onStep={(delta) => steps.push(delta)}
      />,
    );
    const user = userEvent.setup();
    const video = await player();

    await user.keyboard(" ");
    expect(video.paused).toBe(false);
    await user.keyboard("k");
    expect(video.paused).toBe(true);
    expect(steps).toEqual([]);
  });

  it("seeks ten seconds with J and L, because the arrows step assets", async () => {
    const { user } = showVideo();
    const video = await player();

    await user.keyboard("l");
    expect(video.currentTime).toBe(10);
    await user.keyboard("j");
    // Clamped at the start rather than run negative.
    expect(video.currentTime).toBe(0);
  });

  it("mutes on M, and redraws from what the element says", async () => {
    const { user } = showVideo();
    const video = await player();

    await user.keyboard("m");
    expect(video.muted).toBe(true);
    // happy-dom sets the property and sends nothing; a real element announces
    // it, which is when the button changes.
    announce(video, "volumechange");
    await screen.findByRole("button", { name: "Unmute" });
  });

  it("seeks from the timeline's own arrow keys instead of stepping the asset", async () => {
    // The pane's arrows step through the list, and a slider's arrows seek. Both
    // are right, and the one that acted first keeps the key.
    const steps: number[] = [];
    const engine = new FakeEngine({
      details: [fakeDetail(1, { kind: "video", ext: "mp4", durationMs: HOUR })],
    });
    install(engine);
    render(
      <PreviewPane
        hash={HASH}
        generation={0}
        onClose={vi.fn()}
        onStep={(delta) => steps.push(delta)}
      />,
    );
    const user = userEvent.setup();
    const video = await player();

    screen.getByRole("slider", { name: "Timeline" }).focus();
    await user.keyboard("{ArrowRight}");

    // A tenth of a second, which is the precision a comment's moment carries.
    expect(video.currentTime).toBeCloseTo(0.1, 5);
    expect(steps).toEqual([]);
  });

  it("announces a timecode rather than a count of milliseconds", async () => {
    showVideo();
    const video = await player();

    video.currentTime = 91.5;
    announce(video, "timeupdate");

    await waitFor(() =>
      expect(screen.getByRole("slider", { name: "Timeline" }).getAttribute("aria-valuetext")).toBe(
        "1:31.5 of 1:00:00.0",
      ),
    );
  });

  it("follows a seek that has not landed yet", async () => {
    // Found in a real window on 2026-09-02: the timecode froze at the old
    // moment for as long as a seek took, which on a stalled decoder was most of
    // a second. The sampler skipped anything while `seeking` was set — but
    // `currentTime` is the *official* playback position, which a seek sets
    // straight away, so it already reads as where the playhead is going.
    showVideo();
    const video = await player();

    Object.defineProperty(video, "seeking", { value: true, configurable: true });
    video.currentTime = 91.5;
    announce(video, "timeupdate");

    await waitFor(() =>
      expect(screen.getByRole("slider", { name: "Timeline" }).getAttribute("aria-valuetext")).toBe(
        "1:31.5 of 1:00:00.0",
      ),
    );
  });

  it("offers fullscreen only where the platform has one", async () => {
    // A control that does nothing when pressed is worse than no control, and
    // the transport is drawn in windows that have no Fullscreen API at all.
    showVideo();
    await player();
    expect(screen.queryByRole("button", { name: "Fullscreen" })).toBeNull();
  });

  it("asks the player's own box to go fullscreen, not the video", async () => {
    // The box, so the transport is still there once it arrives — a video sent
    // fullscreen on its own takes the whole screen and the controls with it.
    const enabled = Object.getOwnPropertyDescriptor(document, "fullscreenEnabled");
    Object.defineProperty(document, "fullscreenEnabled", { value: true, configurable: true });
    const asked: string[] = [];
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      value(this: Element) {
        asked.push(this.className);
        return Promise.resolve();
      },
      configurable: true,
      writable: true,
    });

    try {
      const { user } = showVideo();
      await player();
      await user.click(screen.getByRole("button", { name: "Fullscreen" }));
      expect(asked).toEqual(["preview-player"]);
    } finally {
      if (enabled === undefined) Reflect.deleteProperty(document, "fullscreenEnabled");
      else Object.defineProperty(document, "fullscreenEnabled", enabled);
      Reflect.deleteProperty(Element.prototype, "requestFullscreen");
    }
  });
});

describe("what the native bar withholds", () => {
  const HOUR = 3_600_000;
  /** 25fps, so a frame is a round forty milliseconds. */
  const PROBED = { "video.fps": "25" };

  const showVideo = (props: Record<string, string> = PROBED) => {
    const engine = new FakeEngine({
      details: [fakeDetail(1, { kind: "video", ext: "mp4", durationMs: HOUR, props })],
    });
    install(engine);
    render(<PreviewPane hash={HASH} generation={0} onClose={vi.fn()} onStep={vi.fn()} />);
    return { engine, user: userEvent.setup() };
  };

  const player = async (): Promise<HTMLVideoElement> => {
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    const video = document.querySelector("video");
    if (video === null) throw new Error("no player");
    return video;
  };

  const announce = (media: HTMLMediaElement, event: string): void => {
    media.dispatchEvent(new Event(event));
  };

  /**
   * Moves the element, and waits for the transport to have noticed.
   *
   * The loop's points are taken from the moment the transport is *drawing*,
   * not from the element — that is what a person is looking at when they press
   * the key — so a test that pressed it before the redraw would be setting a
   * point at the previous moment.
   */
  const moveTo = async (media: HTMLMediaElement, seconds: number): Promise<void> => {
    media.currentTime = seconds;
    announce(media, "timeupdate");
    await waitFor(() =>
      expect(
        Number(screen.getByRole("slider", { name: "Timeline" }).getAttribute("aria-valuenow")),
      ).toBe(Math.round(seconds * 1000)),
    );
  };

  it("steps one frame at a time, off the rate the probe recorded", async () => {
    const { user } = showVideo();
    const video = await player();
    video.currentTime = 1;

    await user.click(screen.getByRole("button", { name: "Next frame" }));
    expect(video.currentTime).toBeCloseTo(1.04, 5);

    await user.click(screen.getByRole("button", { name: "Previous frame" }));
    expect(video.currentTime).toBeCloseTo(1, 5);
  });

  it("offers no frame step for a file nobody has probed", async () => {
    // A step is arithmetic on the frame rate, and a missing one has to mean no
    // stepping rather than a step of `Infinity`.
    showVideo({});
    await player();
    expect(screen.queryByRole("button", { name: "Next frame" })).toBeNull();
  });

  it("pauses to step, because a step while playing is not a step", async () => {
    const { user } = showVideo();
    const video = await player();
    await video.play();
    expect(video.paused).toBe(false);

    await user.click(screen.getByRole("button", { name: "Next frame" }));
    expect(video.paused).toBe(true);
  });

  it("steps from the keyboard, one frame and ten", async () => {
    const { user } = showVideo();
    const video = await player();
    video.currentTime = 10;

    await user.keyboard(".");
    expect(video.currentTime).toBeCloseTo(10.04, 5);
    await user.keyboard(",");
    expect(video.currentTime).toBeCloseTo(10, 5);
    await user.keyboard(">");
    expect(video.currentTime).toBeCloseTo(10.4, 5);
    await user.keyboard("<");
    expect(video.currentTime).toBeCloseTo(10, 5);
  });

  it("never steps behind the start of the file", async () => {
    const { user } = showVideo();
    const video = await player();

    await user.keyboard("<");
    expect(video.currentTime).toBe(0);
  });

  it("sets the playback rate on the element, and reads it back from there", async () => {
    const { user } = showVideo();
    const video = await player();

    await user.click(screen.getByRole("button", { name: "Playback speed" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "2×" }));
    expect(video.playbackRate).toBe(2);

    // happy-dom sets the property and sends nothing; a real element announces
    // it, which is when the trigger changes.
    announce(video, "ratechange");
    await screen.findByRole("button", { name: "Playback speed" });
    expect(screen.getByRole("button", { name: "Playback speed" }).textContent).toBe("2×");
  });

  it("says why the extremes are silent rather than looking broken", async () => {
    // The platform stops stretching sound outside roughly 0.5×–4×, and a menu
    // that offers 8× without saying so offers a fault (ADR-0024).
    const { user } = showVideo();
    await player();

    await user.click(screen.getByRole("button", { name: "Playback speed" }));
    await screen.findByRole("menuitemradio", { name: "8×" });
    expect(screen.getByText(/plays? silently/)).toBeDefined();
  });

  it("loops between two moments, and the button says which one is next", async () => {
    const { user } = showVideo();
    const video = await player();
    await moveTo(video, 10);

    await user.click(await screen.findByRole("button", { name: "Set loop start" }));
    await moveTo(video, 12);
    await user.click(await screen.findByRole("button", { name: "Set loop end" }));

    // Past the end, and back to the start — within a frame, because the check
    // rides the sampler rather than `timeupdate`'s quarter second.
    video.currentTime = 12.5;
    announce(video, "timeupdate");
    await waitFor(() => expect(video.currentTime).toBeCloseTo(10, 3));

    await user.click(await screen.findByRole("button", { name: "Clear loop" }));
    video.currentTime = 12.5;
    announce(video, "timeupdate");
    await waitFor(() => expect(video.currentTime).toBeCloseTo(12.5, 3));
  });

  it("sets the two points from the keyboard, and draws the region", async () => {
    const { user } = showVideo();
    const video = await player();
    await moveTo(video, 900);

    await user.keyboard("i");
    // A start with no end is a mark, not a band: the loop is not running, and a
    // band to the end of the file would say it was.
    await waitFor(() => expect(document.querySelector(".transport-loop")).not.toBeNull());
    const mark = document.querySelector(".transport-loop") as HTMLElement;
    expect(mark.style.left).toBe("25%");
    expect(mark.style.width).toBe("2px");

    await moveTo(video, 1800);
    await user.keyboard("o");
    await waitFor(() =>
      expect((document.querySelector(".transport-loop") as HTMLElement).style.width).toBe("25%"),
    );
  });

  it("refuses an end before a start", async () => {
    const { user } = showVideo();
    const video = await player();
    await moveTo(video, 1800);
    await user.keyboard("i");

    // Back before the start, and `o` there would be a loop that runs backwards.
    await moveTo(video, 900);
    await user.keyboard("o");

    const region = document.querySelector(".transport-loop") as HTMLElement;
    // Clamped to a step past the start rather than accepted or dropped: the
    // gesture was "end it here", and the nearest honest answer to that is the
    // shortest loop this timeline can express.
    expect(region.style.left).toBe("50%");
    expect(region.style.width).toBe(`${(100 / 3_600_000) * 100}%`);
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
