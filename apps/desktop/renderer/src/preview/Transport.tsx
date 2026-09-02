import type { WireComment } from "@roost/contract";
import { DropdownMenu, Slider } from "radix-ui";
import { type RefObject, useEffect, useRef, useState } from "react";
import { timecode } from "../timecode.js";
import { playhead } from "./playhead.js";

/**
 * The transport under a video or an audio file (`UI_SPEC.md` §7, ADR-0024).
 *
 * **Ours, over a `<video controls={false}>`.** The browser's own bar is a closed
 * widget: nothing can be drawn on it and nothing added to it, so a comment mark
 * could only ever sit *beside* the timeline it belongs on — which is what
 * ADR-0023 §6 shipped and what this replaces. Owning the transport means owning
 * buffering, fullscreen, the keyboard map, and the accessibility a native bar
 * gives away for nothing; ADR-0024 names that last one as the way this
 * component fails quietly, because losing it breaks no test.
 *
 * **The element is the state.** Nothing here mirrors what the media element
 * already knows — `paused`, `muted`, `volume`, `playbackRate`, `duration` and
 * the buffered ranges are read back out of it whenever it says they changed.
 * That is what lets the keyboard shortcuts in the preview pane drive the same
 * element through {@link playhead} without telling this component anything:
 * they call `play()`, the element emits `play`, and the button redraws itself.
 *
 * The one exception is the position, which no event reports often enough to
 * scrub with — `timeupdate` fires about four times a second. It is sampled in
 * an animation frame **while playing only**, which is the throttle
 * `CLAUDE.md` §8 asks for; a still playhead moves on the element's own events
 * and re-renders nothing. Which of the two is running is decided by the
 * element's `play` and `pause`, never by this component's copy of them.
 *
 * Stage 2 added what the native bar withholds: frame stepping, a playback rate,
 * and an A-B loop. Two of the three are state the pane cannot reach, which is
 * why the transport registers its own keys with the playhead rather than
 * leaving them all in one switch beside the element-only ones.
 */

export interface TransportProps {
  /** The element on screen, or `null` until React has mounted it. */
  readonly media: HTMLVideoElement | HTMLAudioElement | null;
  /**
   * The box that goes fullscreen.
   *
   * A ref rather than the node, because the only thing that reads it is a
   * click — passing the node would mean a second render for a value nothing
   * draws.
   */
  readonly stage: RefObject<HTMLElement | null>;
  readonly comments: readonly WireComment[];
  /**
   * What the derive pass measured, for an element that has loaded nothing.
   *
   * A file Chromium refuses to decode still has a duration in the library, and
   * a timeline with marks on it is more use than an empty one (found in a real
   * window on 2026-09-02).
   */
  readonly probedMs: number | null;
  /** Frames per second, from the probe. `null` disables frame stepping. */
  readonly fps: number | null;
}

/** What the element says about itself, in the terms this component draws. */
interface Status {
  readonly paused: boolean;
  readonly muted: boolean;
  /** 0–1, as the element keeps it. */
  readonly volume: number;
  readonly rate: number;
  readonly durationMs: number | null;
  /** The end of the buffered range the playhead is inside. */
  readonly bufferedMs: number;
}

const IDLE: Status = {
  paused: true,
  muted: false,
  volume: 1,
  rate: 1,
  durationMs: null,
  bufferedMs: 0,
};

/** A tenth of a second, which is the precision a comment's moment is written at. */
const STEP_MS = 100;

/**
 * The rates offered, and where the platform stops stretching sound.
 *
 * Chromium plays the extremes silently rather than pitch-shifting them, which
 * looks like a fault unless the menu says so (ADR-0024). The bounds are
 * approximate and deliberately written as such — they are the platform's, they
 * have moved between versions, and nothing here can measure them.
 */
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8] as const;

/** The events after which the element may describe itself differently. */
const WATCHED = [
  "play",
  "pause",
  "ended",
  "emptied",
  "volumechange",
  "ratechange",
  "durationchange",
  "loadedmetadata",
  "progress",
] as const;

export function Transport({
  media,
  stage,
  comments,
  probedMs,
  fps,
}: TransportProps): React.JSX.Element {
  const [status, setStatus] = useState<Status>(IDLE);
  const [positionMs, setPositionMs] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  /** The frame actually presented, which is not the frame we asked for. */
  const [frame, setFrame] = useState<number | null>(null);
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);

  useEffect(() => {
    if (media === null) return;
    const read = (): void => setStatus((held) => keep(held, describe(media)));
    read();
    for (const event of WATCHED) media.addEventListener(event, read);
    return () => {
      for (const event of WATCHED) media.removeEventListener(event, read);
    };
  }, [media]);

  /*
   * Driven by the element rather than by this component's idea of it, which is
   * the difference between a timeline that is occasionally right and one that
   * is always right. An earlier version subscribed to `seeked` only while React
   * believed the media was paused; in a window it left the timecode frozen at
   * the old moment for as long as a seek took to land.
   *
   * The loop is in the dependencies rather than behind a ref: its two numbers
   * change at human speed, and re-attaching a handful of listeners then is
   * cheaper to read than a ref that has to be kept in step.
   */
  useEffect(() => {
    if (media === null) return;
    let frames = 0;
    // `currentTime` is the *official* playback position, which a seek sets
    // straight away — so a seek in flight reads as where it is going, and the
    // timecode is right before the frame arrives.
    const sample = (): void => {
      const at = Math.round(media.currentTime * 1000);
      if (loopA !== null && loopB !== null && at >= loopB) {
        media.currentTime = loopA / 1000;
        setPositionMs(loopA);
        return;
      }
      setPositionMs(at);
    };
    const follow = (): void => {
      sample();
      frames = requestAnimationFrame(follow);
    };
    const start = (): void => {
      if (frames === 0) frames = requestAnimationFrame(follow);
    };
    const stop = (): void => {
      cancelAnimationFrame(frames);
      frames = 0;
      sample();
    };

    sample();
    if (!media.paused) start();
    // While it plays, an animation frame — nothing else reports a position
    // often enough to scrub with, and it is also what makes the loop's end
    // land within a frame rather than within `timeupdate`'s quarter second.
    // Otherwise the element's own events, which is all a still playhead can
    // move on, and React bails out of a state update to the same number, so
    // those redraw nothing.
    media.addEventListener("play", start);
    media.addEventListener("playing", start);
    media.addEventListener("pause", stop);
    media.addEventListener("ended", stop);
    media.addEventListener("seeked", sample);
    media.addEventListener("timeupdate", sample);
    return () => {
      cancelAnimationFrame(frames);
      media.removeEventListener("play", start);
      media.removeEventListener("playing", start);
      media.removeEventListener("pause", stop);
      media.removeEventListener("ended", stop);
      media.removeEventListener("seeked", sample);
      media.removeEventListener("timeupdate", sample);
    };
  }, [media, loopA, loopB]);

  /*
   * The frame counter, from the frame the compositor actually presented.
   *
   * `currentTime` says where we asked to be; a seek in a long-GOP codec lands
   * on the nearest decodable frame, so arithmetic on it is a counter that lies
   * on exactly the files frame stepping exists for.
   * `requestVideoFrameCallback` reports what was shown, and it fires after a
   * seek while paused too — which is what makes a step legible.
   */
  useEffect(() => {
    if (media === null || fps === null || !("requestVideoFrameCallback" in media)) return;
    let handle = 0;
    const report = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
      setFrame(Math.round(metadata.mediaTime * fps));
      handle = media.requestVideoFrameCallback(report);
    };
    handle = media.requestVideoFrameCallback(report);
    return () => media.cancelVideoFrameCallback(handle);
  }, [media, fps]);

  useEffect(() => {
    const read = (): void => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", read);
    return () => document.removeEventListener("fullscreenchange", read);
  }, []);

  const durationMs = status.durationMs ?? probedMs;
  const seekable = durationMs !== null && durationMs > 0;
  const at = seekable ? Math.min(positionMs, durationMs) : positionMs;

  const seek = (ms: number): void => {
    if (media === null) return;
    const bounded = Math.max(0, seekable ? Math.min(durationMs, ms) : ms);
    media.currentTime = bounded / 1000;
    // Moved here rather than waited for: the element reports a completed seek,
    // and a thumb that only moves then lags the pointer dragging it.
    setPositionMs(bounded);
  };

  /** Steps whole frames, pausing first: a step while playing is not a step. */
  const step = (frames: number): void => {
    if (media === null || fps === null) return;
    media.pause();
    seek(Math.round((media.currentTime + frames / fps) * 1000));
  };

  const play = (): void => {
    if (media === null) return;
    // The promise rejects when the platform refuses to start — a policy, not a
    // fault, and the element stays paused, which the button already shows.
    if (media.paused) void media.play().catch(() => undefined);
    else media.pause();
  };

  const volume = (percent: number): void => {
    if (media === null) return;
    media.volume = percent / 100;
    // Turning it up is how somebody undoes a mute, and leaving them separate
    // means a volume slider that changes nothing audible.
    if (percent > 0) media.muted = false;
  };

  const goFullscreen = (): void => {
    const box = stage.current;
    // `Boolean`, not a null check: a platform without the API has no such
    // property at all, and `undefined !== null` would try to leave a fullscreen
    // nothing ever entered.
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (box !== null) void box.requestFullscreen();
  };

  /**
   * The loop, one press at a time: start, then end, then gone.
   *
   * Three states on one control rather than three controls, because the middle
   * one is the only moment "set the end" means anything and a button that is
   * disabled two thirds of the time is worse than one that moves on.
   */
  const cycleLoop = (): void => {
    if (loopA === null) setLoopA(at);
    else if (loopB === null) setLoopB(Math.max(at, loopA + STEP_MS));
    else {
      setLoopA(null);
      setLoopB(null);
    }
  };

  /*
   * The keys whose state is this component's rather than the element's. The
   * pane holds the focus and the element-only keys (`UI_SPEC.md` §9), and hands
   * the rest here — see `playhead.ts`. Registered through a ref so that binding
   * happens once rather than on every frame of playback.
   */
  const keys = (name: string): boolean => {
    switch (name) {
      case ",":
        step(-1);
        return fps !== null;
      case ".":
        step(1);
        return fps !== null;
      case "<":
        step(-10);
        return fps !== null;
      case ">":
        step(10);
        return fps !== null;
      case "i":
        setLoopA(at);
        setLoopB((held) => (held !== null && held <= at ? null : held));
        return true;
      case "o":
        if (loopA === null) return false;
        setLoopB(Math.max(at, loopA + STEP_MS));
        return true;
      default:
        return false;
    }
  };
  const latest = useRef(keys);
  useEffect(() => {
    latest.current = keys;
  });
  useEffect(() => playhead.bindKeys((name) => latest.current(name)), []);

  // Narrowed by the property rather than by a cast: audio has no frames, so it
  // has no picture to put in a window (`HTMLAudioElement` has no such method).
  const inPicture = media !== null && "requestPictureInPicture" in media ? media : null;
  const muted = status.muted || status.volume === 0;
  const label = status.paused ? "Play" : "Pause";
  const loop = loopA === null ? "Set loop start" : loopB === null ? "Set loop end" : "Clear loop";

  return (
    <div className="transport">
      <Slider.Root
        className="transport-timeline"
        min={0}
        max={seekable ? durationMs : 0}
        step={STEP_MS}
        value={[at]}
        disabled={!seekable}
        onValueChange={(next) => {
          const first = next[0];
          if (first !== undefined) seek(first);
        }}
      >
        <Slider.Track className="transport-track">
          {/* What has arrived, which the native bar draws and a naive scrubber
              forgets — the difference between a slow network and a broken one. */}
          <div
            className="transport-buffered"
            style={{ width: seekable ? span(status.bufferedMs, durationMs) : "0%" }}
          />
          <Slider.Range className="transport-played" />
          {seekable && loopA !== null && (
            <div
              className="transport-loop"
              style={{
                left: span(loopA, durationMs),
                // An end that is not set yet is a mark rather than a band: the
                // loop is not running, and a band to the end of the file would
                // say it was.
                width: loopB === null ? "2px" : span(Math.max(0, loopB - loopA), durationMs),
              }}
            />
          )}
        </Slider.Track>
        {seekable &&
          comments.map((comment) => {
            const moment = comment.atMs;
            if (moment === null) return null;
            return (
              <button
                key={comment.id}
                type="button"
                className="transport-mark"
                // Clamped: a comment written against the duration the probe
                // reported must stay on a timeline the file disagrees with.
                style={{ left: span(moment, durationMs) }}
                title={`${timecode(moment)} — ${comment.body}`}
                aria-label={`Play from ${timecode(moment)}: ${comment.body}`}
                // Or the slider under it would start a drag from the same press,
                // and the mark's own moment would be overwritten by the pointer's.
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => seek(moment)}
              />
            );
          })}
        <Slider.Thumb
          className="transport-thumb"
          aria-label="Timeline"
          // The timecode, not a count of milliseconds. `aria-valuetext` is what
          // a screen reader reads when it is there, and "91500" is not a time.
          aria-valuetext={
            seekable ? `${timecode(at)} of ${timecode(durationMs)}` : "Duration unknown"
          }
        />
      </Slider.Root>

      <div className="transport-controls">
        {fps !== null && (
          <button
            type="button"
            className="transport-button"
            aria-label="Previous frame"
            title="Previous frame"
            onClick={() => step(-1)}
          >
            <Icon of="stepBack" />
          </button>
        )}

        <button
          type="button"
          className="transport-button"
          aria-label={label}
          title={label}
          onClick={play}
        >
          <Icon of={status.paused ? "play" : "pause"} />
        </button>

        {fps !== null && (
          <button
            type="button"
            className="transport-button"
            aria-label="Next frame"
            title="Next frame"
            onClick={() => step(1)}
          >
            <Icon of="stepOn" />
          </button>
        )}

        <span className="transport-time">
          {timecode(at)}
          {frame !== null && <span className="transport-frame"> f{frame}</span>}
          <span className="transport-time-total">
            {" / "}
            {durationMs === null ? "—" : timecode(durationMs)}
          </span>
        </span>

        <div className="transport-gap" />

        <button
          type="button"
          className="transport-button"
          aria-label={loop}
          title={loop}
          data-on={loopA !== null ? "" : undefined}
          onClick={cycleLoop}
        >
          <Icon of="loop" />
        </button>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="transport-rate" aria-label="Playback speed">
              {rate(status.rate)}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" sideOffset={4} align="end" collisionPadding={8}>
              <DropdownMenu.RadioGroup
                value={String(status.rate)}
                onValueChange={(next) => {
                  if (media !== null) media.playbackRate = Number(next);
                }}
              >
                {RATES.map((candidate) => (
                  <DropdownMenu.RadioItem
                    key={candidate}
                    className="menu-item"
                    value={String(candidate)}
                  >
                    <span className="menu-mark">{status.rate === candidate ? "●" : ""}</span>
                    <span className="menu-label">{rate(candidate)}</span>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Label className="menu-note">
                The extremes play silently: the platform stops stretching sound outside about 0.5×
                to 4×.
              </DropdownMenu.Label>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <button
          type="button"
          className="transport-button"
          aria-label={muted ? "Unmute" : "Mute"}
          title={muted ? "Unmute" : "Mute"}
          onClick={() => {
            if (media === null) return;
            // Unmuting something turned all the way down would stay silent, so
            // it comes back up as well.
            if (muted && status.volume === 0) media.volume = 1;
            media.muted = !status.muted;
          }}
        >
          <Icon of={muted ? "muted" : "volume"} />
        </button>

        <Slider.Root
          className="transport-volume"
          min={0}
          max={100}
          step={5}
          value={[muted ? 0 : Math.round(status.volume * 100)]}
          onValueChange={(next) => {
            const first = next[0];
            if (first !== undefined) volume(first);
          }}
        >
          <Slider.Track className="transport-track">
            <Slider.Range className="transport-played" />
          </Slider.Track>
          <Slider.Thumb
            className="transport-thumb"
            aria-label="Volume"
            aria-valuetext={`${muted ? 0 : Math.round(status.volume * 100)}%`}
          />
        </Slider.Root>

        {inPicture !== null && document.pictureInPictureEnabled && (
          <button
            type="button"
            className="transport-button"
            aria-label="Picture in picture"
            title="Picture in picture"
            onClick={() => {
              if (document.pictureInPictureElement) void document.exitPictureInPicture();
              else void inPicture.requestPictureInPicture().catch(() => undefined);
            }}
          >
            <Icon of="pip" />
          </button>
        )}

        {/* Only where the platform has one. A control that does nothing when
            pressed is worse than no control (`UI_SPEC.md` §3.5 says it about a
            timecode; it is the same rule). */}
        {document.fullscreenEnabled && (
          <button
            type="button"
            className="transport-button"
            aria-label={fullscreen ? "Leave fullscreen" : "Fullscreen"}
            title={fullscreen ? "Leave fullscreen" : "Fullscreen"}
            onClick={goFullscreen}
          >
            <Icon of={fullscreen ? "compress" : "expand"} />
          </button>
        )}
      </div>
    </div>
  );
}

/** What the element currently says about itself. */
function describe(media: HTMLMediaElement): Status {
  const seconds = media.duration;
  return {
    paused: media.paused,
    muted: media.muted,
    volume: media.volume,
    rate: media.playbackRate,
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    bufferedMs: bufferedTo(media),
  };
}

/**
 * The previous status when nothing in it changed.
 *
 * `progress` fires while a file downloads and says nothing about the numbers
 * here most of the time; a fresh object every time would re-render the
 * transport for each of them.
 */
function keep(held: Status, next: Status): Status {
  return held.paused === next.paused &&
    held.muted === next.muted &&
    held.volume === next.volume &&
    held.rate === next.rate &&
    held.durationMs === next.durationMs &&
    held.bufferedMs === next.bufferedMs
    ? held
    : next;
}

/** How far the range under the playhead reaches, in milliseconds. */
function bufferedTo(media: HTMLMediaElement): number {
  const ranges = media.buffered;
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    if (media.currentTime >= ranges.start(index)) return Math.round(ranges.end(index) * 1000);
  }
  return 0;
}

/** A moment as a share of the whole, clamped to the bar it is drawn on. */
function span(ms: number, durationMs: number): string {
  return `${Math.min(100, Math.max(0, (ms / durationMs) * 100))}%`;
}

/** `1×`, `0.25×` — a multiplication sign, never the letter. */
function rate(of: number): string {
  return `${of}×`;
}

/**
 * The transport's icons, drawn here.
 *
 * Inline paths rather than an icon package: invariant 7 forbids fetching one at
 * runtime, and nine shapes are not a dependency. Every button that uses one
 * carries the same words in `aria-label` and `title` (`UI_SPEC.md` §10).
 */
function Icon({ of }: { readonly of: keyof typeof PATHS }): React.JSX.Element {
  return (
    <svg className="transport-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={PATHS[of]} fill="currentColor" />
    </svg>
  );
}

const PATHS = {
  play: "M5 3.5v9l8-4.5-8-4.5z",
  pause: "M4.5 3h2.5v10H4.5V3zm4.5 0h2.5v10H9V3z",
  stepBack: "M4 3.5h1.5v9H4v-9zm8 0v9l-6-4.5 6-4.5z",
  stepOn: "M12 3.5h-1.5v9H12v-9zm-8 0v9l6-4.5-6-4.5z",
  loop: "M4.5 4h6V2l3 2.75L10.5 7.5v-2h-6v3H3v-3A1.5 1.5 0 0 1 4.5 4zm7 4.5H13v3a1.5 1.5 0 0 1-1.5 1.5h-6v2L2.5 12.25 5.5 9.5v2h6v-3z",
  volume:
    "M3 6.5h2.5L9 3.5v9L5.5 9.5H3v-3zm8.2-1.1a4 4 0 0 1 0 5.2l-.9-.8a2.8 2.8 0 0 0 0-3.6l.9-.8z",
  muted:
    "M3 6.5h2.5L9 3.5v9L5.5 9.5H3v-3zm8.1-.6.9.9.9-.9.8.8-.9.9.9.9-.8.8-.9-.9-.9.9-.8-.8.9-.9-.9-.9.8-.8z",
  pip: "M2 3h12v10H2V3zm1.5 1.5v7h9v-7h-9zM8 8h4v3H8V8z",
  expand:
    "M2 2h5v1.5H3.5V7H2V2zm7 0h5v5h-1.5V3.5H9V2zM2 9h1.5v3.5H7V14H2V9zm10.5 0H14v5H9v-1.5h3.5V9z",
  compress:
    "M6 2h1.5v5H2.5V5.5H6V2zm2.5 0H10v3.5h3.5V7h-5V2zM2.5 9h5v5H6v-3.5H2.5V9zm6 0h5v1.5H10V14H8.5V9z",
} as const;
