import type { WireAssetDetail, WireSubtitle } from "@roost/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "../bridge.js";
import { codecName } from "../deriveReason.js";
import { dragOneAsset } from "../dnd.js";
import { counted } from "../format.js";
import { KindGlyph, Placeholder } from "../Placeholder.js";
import { fallbackToGrid, gridSrc, previewSrc, showLoaded } from "../thumbnail.js";
import { Picture, type PictureHandle } from "./Picture.js";
import { playhead, SKIP_MS } from "./playhead.js";
import { sound } from "./sound.js";
import { Transport } from "./Transport.js";
import { Unshowable } from "./Unshowable.js";

/**
 * One asset, filling the content region (`UI_SPEC.md` §7).
 *
 * Opens on `Enter` or a double-click and closes on `Escape`. Arrow keys step
 * through the loaded list, and **stepping changes the selection** — in
 * `roost-old` it did not, and a note could be written onto the wrong asset
 * while the preview showed another.
 *
 * Every kind reaches the same place in the end: a library holds anything
 * (`CONCEPT.md` §5), so what Roost cannot draw gets its thumbnail, its
 * metadata, and **Open externally** rather than a dead end.
 *
 * Bytes arrive over `roost://file/<id>`, which answers range requests —
 * which is what makes a `<video>` seek rather than download (ADR-0008).
 */

export interface PreviewPaneProps {
  readonly id: string;
  /**
   * Bumped by the caller when something outside the pane changed the library.
   *
   * The inspector is on screen beside the preview and can add a comment to the
   * asset being played, so the pane re-reads on it exactly as the inspector
   * does — otherwise the marks on the timeline would be right only until
   * somebody used the panel next to it.
   */
  readonly generation: number;
  /**
   * Whether there is an asset either side of this one, so the buttons in the
   * head can be drawn dead rather than pressed to no effect (`UI_SPEC.md` §3.5).
   *
   * The caller's, not the pane's: the list is the grid's and it ends where the
   * loaded page does, which is a fact this component has no way to learn.
   */
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly onClose: () => void;
  /** Moves to the previous or next loaded asset, changing the selection. */
  readonly onStep: (delta: -1 | 1) => void;
  /**
   * Whether a video is scaled up to the pane (ADR-0024 §8).
   *
   * The library's, not the pane's: it is remembered in `settings.json` and is
   * therefore the caller's to hold, exactly as *Show subfolder contents* is.
   */
  readonly fitVideo: boolean;
  readonly onFitVideo: (on: boolean) => void;
  /**
   * The application's `☰`, when there is nowhere else to draw it (ADR-0028 §6).
   *
   * The button lives in the head of whichever column is on screen, and with the
   * sidebar hidden this head is the only one there is: the pane replaces the
   * grid's bar with its own. Handed in rather than built here, because it is
   * the *same* element the other two heads draw — an instance of its own would
   * be a second open state.
   *
   * `undefined` while the sidebar is showing, which is where the button then
   * is: a preview is not a place to repeat a control already on screen.
   */
  readonly menu?: React.ReactNode;
  /**
   * Starts a drag of the file on screen out of the window, and answers whether
   * it did (ADR-0034 §7).
   *
   * **Given only while the inspector is hidden**, and the head draws its handle
   * only then. With the inspector showing, its picture is the handle, and the
   * file is picked up there: one place for it, wherever that is on screen, as
   * the `☰` has one (ADR-0028 §6).
   *
   * The grid's own function: whether a drag may go out is decided by what a
   * copy costs in this library and by the asset's size, and the caller is where
   * both are held.
   */
  readonly onDragOut?: (ids: readonly string[]) => boolean;
}

/**
 * The file on screen, as something a hand can pick up, while the inspector is
 * hidden (ADR-0034 §7).
 *
 * The picture itself cannot be the thing dragged: a press on it zooms to 1:1
 * and a drag across it pans, and under a video the timeline is dragged to seek.
 * The inspector's picture has no such job, so it is the handle while it is
 * shown, and this stands in for it while it is not.
 *
 * Pointer-only on purpose. `Ctrl+C` is the keyboard's way to hand the same
 * file over (ADR-0034 §5.1), and the pane already has it.
 */
function FileHandle({
  id,
  detail,
  onDragOut,
}: {
  readonly id: string;
  readonly detail: WireAssetDetail | undefined;
  readonly onDragOut: (ids: readonly string[]) => boolean;
}): React.JSX.Element {
  const [broken, setBroken] = useState(false);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drag source only; the keyboard hands the same file over with Ctrl+C
    <div
      className="preview-handle"
      draggable
      title="Drag the file to another application"
      onDragStart={(event) => dragOneAsset(event, id, onDragOut)}
    >
      {/* The kind's outline underneath, which the thumbnail covers when there
          is one, as a cell's placeholder is covered (`UI_SPEC.md` §6.1). */}
      <KindGlyph kind={detail?.kind ?? "other"} />
      {detail === undefined || broken ? null : (
        <img
          src={gridSrc(id, detail.posterMs, detail.derivedAt)}
          alt=""
          draggable={false}
          onError={() => setBroken(true)}
        />
      )}
    </div>
  );
}

/**
 * The media keys, handed to the player on screen if there is one.
 *
 * `Space` and `K` play, `M` mutes, and coarse seeking is `J` and `L` because
 * the arrow keys step between assets — the fine seek is on the timeline itself,
 * which is a slider and moves by a tenth of a second (`UI_SPEC.md` §9). Frame
 * stepping and the A-B loop are the transport's, and fall through to it.
 * Fullscreen has a button rather than `F`: `F` toggles the favourite, and a key
 * that means one thing beside a video and another beside a picture is worse
 * than a button.
 *
 * Answers whether anything took the key, so a preview with no player in it
 * leaves `Space` alone.
 */
/** What `+` and `-` do to the scale, matching one press of the zoom buttons. */
const KEY_ZOOM = 1.25;

function mediaKey(key: string): boolean {
  switch (key) {
    case " ":
    case "k":
      return playhead.toggle();
    case "m":
      return playhead.toggleMute();
    case "j":
      return playhead.nudge(-SKIP_MS);
    case "l":
      return playhead.nudge(SKIP_MS);
    default:
      // Frame stepping and the A-B loop, which need state the pane has no
      // reason to hold. `playhead.ts` says why they are delegated rather than
      // lifted.
      return playhead.key(key);
  }
}

export function PreviewPane({
  id,
  generation,
  hasPrevious,
  hasNext,
  onClose,
  onStep,
  fitVideo,
  onFitVideo,
  menu,
  onDragOut,
}: PreviewPaneProps): React.JSX.Element {
  const [detail, setDetail] = useState<WireAssetDetail | undefined>();
  const [page, setPage] = useState(0);
  const pane = useRef<HTMLDivElement>(null);
  /**
   * The picture on screen, if what is on screen is one.
   *
   * The zoom belongs to the picture — it is the thing that knows its own pixels
   * and its own box — but `+` and `-` arrive here, because the pane is what
   * holds the focus. This ref is the whole of the line between the two.
   */
  const picture = useRef<PictureHandle>(null);
  /**
   * The slot at the head of the pane, for whatever is on screen to draw into.
   *
   * State rather than a ref, because what fills it is rendered from the node:
   * a ref would be `null` on the render that needs it. It is a real element in
   * the head's own row rather than a shuffled order, so what the eye reads
   * left to right is what the Tab key walks through.
   */
  const [tools, setTools] = useState<HTMLElement | null>(null);
  /** Which asset the page number belongs to, so a re-read does not turn back. */
  const detailHash = useRef<string | undefined>(undefined);

  const pages = detail?.kind === "document" ? (detail.pageCount ?? 0) : 0;
  const turn = (delta: number): void => {
    setPage((current) => Math.min(pages - 1, Math.max(0, current + delta)));
  };

  /*
   * `generation` is a trigger rather than a value the body reads: something
   * outside the pane changed the library, and what is on screen may be stale.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let current = true;
    // Not cleared on a re-read of the same asset: blanking the pane on every
    // announced change would restart a video that is playing. A different
    // asset replaces the element anyway, because `Stage` is keyed on the id.
    setDetail((held) => (held?.id === id ? held : undefined));
    // Back to the first page: stepping to the next asset must not open it at
    // page forty because that is where the last document was left.
    setPage((at) => (detailHash.current === id ? at : 0));
    detailHash.current = id;
    void (async () => {
      const outcome = await invoke({ type: "asset:detail", id });
      if (current && outcome.ok && outcome.value !== null) setDetail(outcome.value);
    })();
    return () => {
      current = false;
    };
  }, [id, generation]);

  // The pane takes focus when it opens: it is the thing the keyboard is now
  // for, and a preview that needs a click before the arrow keys work is a
  // preview nobody drives with the keyboard.
  //
  // And again when the `☰` arrives or leaves (ADR-0028 §6). Bringing the
  // sidebar back from that menu moves the button to the sidebar's head, so the
  // element the menu handed focus back to is unmounted a moment later and focus
  // lands on `<body>` — where `Escape`, the arrows and the media keys are all
  // dead until something in the pane is clicked.
  const hasMenu = menu !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the menu arriving or leaving is the trigger
  useEffect(() => {
    pane.current?.focus();
  }, [hasMenu]);

  return (
    <div
      className="preview"
      ref={pane}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={detail?.name ?? "Preview"}
      onKeyDown={(event) => {
        // A control inside the pane that has already acted on the key keeps it.
        // The timeline is a slider, so its arrows seek — and without this they
        // would seek *and* step to the next asset.
        if (event.defaultPrevented) return;
        // The media keys are the pane's own, so they are read only while the
        // pane itself has focus: with a button focused, `Space` presses it, and
        // that is what `Space` means everywhere else in the window.
        if (event.target === event.currentTarget && mediaKey(event.key)) {
          event.preventDefault();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          onStep(-1);
        }
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          onStep(1);
        }
        // Zoom, where there is something to zoom (`UI_SPEC.md` §7). `+` and
        // `-` rather than a digit: `0`–`5` set the rating on the selection
        // (§9), and a preview does not take that away from the asset it shows.
        if ((event.key === "+" || event.key === "=") && picture.current !== null) {
          event.preventDefault();
          picture.current.zoomBy(KEY_ZOOM);
        }
        if (event.key === "-" && picture.current !== null) {
          event.preventDefault();
          picture.current.zoomBy(1 / KEY_ZOOM);
        }
        // Page keys turn pages and arrow keys step assets, which is the one
        // split that keeps a document from trapping the keyboard.
        if (event.key === "PageDown" && pages > 0) {
          event.preventDefault();
          turn(1);
        }
        if (event.key === "PageUp" && pages > 0) {
          event.preventDefault();
          turn(-1);
        }
      }}
    >
      {/*
        No filename here. The inspector carries the name of whatever is
        selected — an editable field, three inches to the right — and the pane
        cannot be open without something being selected, so a second copy said
        the same thing twice and read as a title bar the window already has.
        Removed at the user's request on 2026-09-06.
      */}
      <header className="preview-bar">
        {/* Before the kind's own tools, because it is the window's rather than
            this file's — and in the same corner it occupies in the other two
            heads, so it does not move as a preview opens (ADR-0028 §6). */}
        {menu}
        {/* First in the row and first in the tab order; empty for a kind with
            nothing to put here, and then it takes no room at all. */}
        <div className="preview-bar-tools" ref={setTools} />
        {/* Keyed on the id, so a thumbnail that failed for one asset is not
            taken as failed for the next one stepped to. */}
        {onDragOut !== undefined && (
          <FileHandle key={id} id={id} detail={detail} onDragOut={onDragOut} />
        )}
        <button
          type="button"
          className="preview-step"
          aria-label="Previous asset"
          title="Previous asset"
          disabled={!hasPrevious}
          onClick={() => onStep(-1)}
        >
          <Arrow back />
        </button>
        <button
          type="button"
          className="preview-step"
          aria-label="Next asset"
          title="Next asset"
          disabled={!hasNext}
          onClick={() => onStep(1)}
        >
          <Arrow />
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="preview-stage">
        {detail === undefined ? null : (
          <Stage
            detail={detail}
            page={page}
            onTurn={turn}
            pictureRef={picture}
            tools={tools}
            fitVideo={fitVideo}
            onFitVideo={onFitVideo}
          />
        )}
      </div>
    </div>
  );
}

/**
 * What the asset renders as.
 *
 * Keyed on the id so that stepping to the next asset replaces the element
 * rather than reusing it: a `<video>` given a new `src` keeps the old one's
 * playback state, and a paused frame from the previous asset is worse than a
 * blank one.
 */
function Stage({
  detail,
  page,
  onTurn,
  pictureRef,
  tools,
  fitVideo,
  onFitVideo,
}: {
  readonly detail: WireAssetDetail;
  readonly page: number;
  readonly onTurn: (delta: number) => void;
  readonly pictureRef: React.RefObject<PictureHandle | null>;
  /** The head's slot, which the picture and the player draw their size controls into. */
  readonly tools: HTMLElement | null;
  readonly fitVideo: boolean;
  readonly onFitVideo: (on: boolean) => void;
}): React.JSX.Element {
  const original = `roost://file/${detail.id}`;

  if (detail.kind === "image") {
    // A rendition where a browser cannot read the file itself — HEIC, RAW, TIFF
    // (ADR-0040 §7). Everything else is the original, which is what makes an SVG
    // stay a vector.
    const src = detail.browserDrawable ? original : `roost://render/${detail.id}`;
    // An SVG renders through the same `<img>`, which is what sandboxes it:
    // scripts in an image do not run, and neither do external references.
    // Keyed on the id like every other kind here, which is also what puts the
    // zoom back to the fit on the way to the next asset: a scale belongs to the
    // photograph somebody is looking at, not to the pane.
    return <Picture key={detail.id} detail={detail} src={src} controls={tools} ref={pictureRef} />;
  }

  if (detail.kind === "video" || detail.kind === "audio") {
    /*
     * Always the original, and never a rendition.
     *
     * **`browserDrawable` is an answer about an `<img>`**, and it is false for
     * every video and audio format there is — so asking it here sent a `<video>`
     * to `roost://render/<id>`, which answers *"no rendition for mp4"* with a
     * 404. Every video and every sound in the library opened blank from the day
     * ADR-0040 §7 arrived (2026-09-10) until this was found on 2026-09-13. The
     * tests missed it because `fakeDetail` says `browserDrawable: true` for
     * everything, so the one shape that reaches this line was the one shape
     * never tried.
     */
    return (
      <Player
        key={detail.id}
        detail={detail}
        src={original}
        tools={tools}
        fit={fitVideo}
        onFit={onFitVideo}
      />
    );
  }

  // A document with pages to turn. `pageCount` is null until the derive pass
  // has been over it, and a document nobody has counted yet falls through to
  // its thumbnail rather than to a pager with one page in it.
  if (detail.kind === "document" && detail.pageCount !== null && detail.pageCount > 0) {
    return (
      <Pages key={detail.id} detail={detail} pages={detail.pageCount} page={page} onTurn={onTurn} />
    );
  }

  if (detail.kind === "font") {
    return <Specimen key={detail.id} detail={detail} />;
  }

  return <Fallback detail={detail} />;
}

/**
 * The probe's frame rate, if it recorded one.
 *
 * One known key read out of the property map, which the inspector otherwise
 * shows without understanding (`UI_SPEC.md` §3). Frame stepping is arithmetic
 * on this number, so a missing or nonsensical one has to mean "no stepping"
 * rather than a step of `Infinity`.
 */
function frameRate(recorded: string | undefined): number | null {
  if (recorded === undefined) return null;
  const fps = Number(recorded);
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

/**
 * A document, one page at a time (`UI_SPEC.md` §7).
 *
 * Each page is an `<img>` pointed at `roost://page/<id>/<n>@1024`, rendered
 * on demand by main and cached by Chromium — the same arrangement as a
 * thumbnail, and for the same reason: bytes do not travel through IPC
 * (invariant 12), and a library that stored a picture per page would be storing
 * a rendering nobody asked for.
 *
 * The pager is `PageUp` and `PageDown` as well as buttons, because the arrow
 * keys already belong to stepping between assets and taking them here would
 * mean a document trapped the keyboard.
 */
function Pages({
  detail,
  pages,
  page,
  onTurn,
}: {
  readonly detail: WireAssetDetail;
  readonly pages: number;
  readonly page: number;
  readonly onTurn: (delta: number) => void;
}): React.JSX.Element {
  const shown = Math.min(page, pages - 1);

  return (
    <div className="preview-pages">
      <img
        className="preview-media"
        src={`roost://page/${detail.id}/${shown}@1024`}
        alt={`Page ${shown + 1} of ${pages}`}
      />
      <div className="preview-pager">
        <button type="button" disabled={shown === 0} onClick={() => onTurn(-1)}>
          Previous
        </button>
        <span className="preview-page-count">
          {counted(shown + 1)} / {counted(pages)}
        </span>
        <button type="button" disabled={shown >= pages - 1} onClick={() => onTurn(1)}>
          Next
        </button>
      </div>
    </div>
  );
}

/**
 * Video and audio, under a transport of ours (ADR-0024).
 *
 * `controls` is off. The browser's bar is a closed widget — nothing can be
 * drawn on it and nothing added to it — so the comment marks could only ever
 * sit beside the timeline they belong on. {@link Transport} is what replaces
 * it, and the same one serves `<audio>`: two implementations of one control is
 * how they come to disagree.
 *
 * The element is held in state rather than a ref because the transport is
 * drawn from it, and a ref does not tell React that it has arrived.
 *
 * **Fit to window is a mode, not an action** (ADR-0024 §8). Asked for on
 * 2026-09-08: *"apakah memungkinkan di beirkan tombol fit to window? supaya
 * videonya gak kekecilan jika memutar resolusi rendah"*. A video too big for
 * the pane is fitted to it either way — that is what `max-*` has always done —
 * so what the button decides is whether a video **smaller** than the pane is
 * scaled up to it, which is why it is drawn pressed rather than as something
 * that happens once. The choice is the library's and outlives the asset: it is
 * an answer about a screen, not about one file.
 */
function Player({
  detail,
  src,
  tools,
  fit,
  onFit,
}: {
  readonly detail: WireAssetDetail;
  readonly src: string;
  /** The head's slot. `null` while the pane is mounting. */
  readonly tools: HTMLElement | null;
  readonly fit: boolean;
  readonly onFit: (on: boolean) => void;
}): React.JSX.Element {
  const [element, setElement] = useState<HTMLVideoElement | HTMLAudioElement | null>(null);
  const [problem, setProblem] = useState<{ line: string; said: string } | undefined>();
  /** The sound plays and the picture does not: see {@link Player}'s `measured`. */
  const [blind, setBlind] = useState(false);
  const stage = useRef<HTMLDivElement>(null);

  /*
   * A new asset is a new question. Without this, the answer to the last one
   * would still be on screen over a clip that plays.
   *
   * `src` is a trigger rather than something the body reads, which is exactly
   * what the rule below counts as an extra dependency.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    setProblem(undefined);
    setBlind(false);
  }, [src]);

  /**
   * Whether the picture can be decoded, which an error does not say.
   *
   * **Chromium drops a video track it has no decoder for and plays the rest.**
   * An HEVC clip with AAC sound raises no `error` at all: it loads, reports its
   * duration, and plays the sound under an empty rectangle, with the timeline
   * moving (seen 2026-09-24 against Electron 43, which has no HEVC decoder
   * whatever the system has installed). The one sign is a width of zero, and it
   * means something only when the probe found a picture there — an `.mp4` that
   * is only sound is zero wide too, and is simply audio.
   *
   * Paused rather than left to play: sound from a preview whose picture is
   * missing sounds like a bug, and the transport still plays it on request.
   */
  const measured = (event: React.SyntheticEvent<HTMLMediaElement>): void => {
    const media = event.currentTarget;
    if (!(media instanceof HTMLVideoElement) || media.videoWidth > 0) return;
    if ((detail.width ?? 0) === 0) return;
    media.pause();
    setBlind(true);
  };

  /**
   * What the element says when it cannot play what it was given.
   *
   * A picture that fails falls back to its thumbnail; a video has nothing to
   * fall back to, and until this existed it left an empty rectangle with a
   * transport bar under it and no word anywhere about why (reported 2026-09-13).
   *
   * **The thumbnail arriving is not evidence that this will play.** The
   * thumbnail is drawn by the system's ffmpeg (ADR-0017) and this is decoded by
   * Chromium, which ships a narrower list of codecs — so the two disagree, and
   * the disagreement looks like a bug in the pane.
   */
  const failed = (event: React.SyntheticEvent<HTMLMediaElement>): void => {
    const code = event.currentTarget.error?.code;
    // `MEDIA_ERR_ABORTED` is what a load being replaced looks like, and the
    // pane replaces one every time the selection moves.
    if (code === undefined || code === 1) return;
    setProblem({
      line: mediaProblem(code, detail),
      // The element's own words under ours, as the failures list does it
      // (§3.13): the sentence is a reading of the code and the code is coarse —
      // *Format error* is what both a codec nobody has and a 404 look like from
      // here, and only the second one is a bug in Roost. Keeping the original
      // is what turned "cannot play h264" into a wrong path in one glance.
      said: event.currentTarget.error?.message ?? "",
    });
  };

  /**
   * The volume the library remembers, put on before anything can be heard
   * (ADR-0024 §9).
   *
   * In the ref callback rather than in an effect, and that is the whole reason
   * this is not two lines of `useEffect`: the element is `autoPlay`, an effect
   * runs after paint, and a clip whose data is already cached would be audible
   * at full volume for those frames. The callback runs during the commit that
   * creates the element, before it can have loaded anything.
   *
   * Its identity has to be stable — a fresh function each render would be a
   * detach and a re-attach, which is a remount of the transport for nothing.
   */
  const attach = useCallback((node: HTMLVideoElement | HTMLAudioElement | null) => {
    if (node !== null) {
      const { volume, muted } = sound.current();
      node.volume = volume / 100;
      node.muted = muted;
    }
    setElement(node);
  }, []);

  // Registered for the inspector's comment list to seek and for the pane's own
  // keys to drive, both of which are outside this subtree (`playhead.ts`).
  useEffect(() => (element === null ? undefined : playhead.attach(element)), [element]);

  /*
   * Whatever the element says about its own loudness, back to the store — the
   * slider, the mute button and the `m` key all reach the element and none of
   * them reaches here. The store drops a value that has not changed, which is
   * what keeps applying the remembered volume above from being reported back as
   * a change.
   */
  useEffect(() => {
    if (element === null) return undefined;
    const report = (): void => {
      sound.changed({ volume: Math.round(element.volume * 100), muted: element.muted });
    };
    element.addEventListener("volumechange", report);
    return () => element.removeEventListener("volumechange", report);
  }, [element]);

  /*
   * Only what can be served without an external tool: ASS and an embedded
   * stream need ffmpeg, and a `<track>` pointed at a URL that answers 415 is an
   * empty track with no error anywhere (ADR-0025). The CC menu lists the rest
   * and says why they are missing.
   */
  const tracks = detail.subtitles.filter((track) => track.servable);

  /**
   * **Add subtitle…**, from the CC menu (ADR-0025).
   *
   * The chooser is main's — the renderer has no filesystem — and it is the
   * subtitle one rather than the import one: files only, filtered, and its
   * button says "Add". What comes back are paths, which the engine imports and
   * attaches in **one** request: apart, the two leave a state between them
   * where a track is imported and attached to nothing.
   *
   * Nothing is re-read here. The engine announces the change, the window bumps
   * its generation, and the pane re-reads exactly as it does after every other
   * edit.
   */
  const addSubtitle = (): void => {
    void (async () => {
      const chosen = await invoke({ type: "dialog:chooseSubtitle" });
      if (!chosen.ok || chosen.value === null || chosen.value.length === 0) return;
      await invoke({ type: "asset:addSubtitle", id: detail.id, paths: chosen.value });
    })();
  };

  /*
    Audio has no picture, so it has nothing to fit. Drawn through a portal for
    the picture's reason: the control belongs to what is on screen and the head
    is where the pane keeps its controls, which is also what leaves the video
    the whole strip it was standing on.
  */
  const fitControl =
    detail.kind === "audio" || tools === null
      ? null
      : createPortal(
          <div className="preview-fit">
            <button
              type="button"
              aria-pressed={fit}
              title={fit ? "Show the video at its own size" : "Scale the video to the window"}
              onClick={() => onFit(!fit)}
            >
              Fit
            </button>
          </div>,
          tools,
        );

  const unshown =
    detail.kind !== "video" ? undefined : problem !== undefined ? (
      <Unshowable detail={detail} line={problem.line} said={problem.said} />
    ) : blind ? (
      <Unshowable detail={detail} line={blindLine(detail)} hint={blindHint(detail)} />
    ) : undefined;

  return (
    <div
      className="preview-player"
      data-kind={detail.kind}
      data-fit={fit ? "" : undefined}
      ref={stage}
    >
      {/* The picture takes whatever is left above the bar, which is what keeps
          the bar at the foot of the pane rather than wherever the file's aspect
          ratio happens to end. */}
      <div className="preview-picture">
        {detail.kind === "audio" ? (
          // The tracks below are the captions, and there are as many as the
          // asset has — often none, and never a literal the rule can see.
          // biome-ignore lint/a11y/useMediaCaption: see above
          <audio
            ref={attach}
            className="preview-audio"
            src={src}
            crossOrigin="anonymous"
            autoPlay
            onError={failed}
          >
            {tracks.map((track) => (
              <Caption key={track.id} track={track} />
            ))}
          </audio>
        ) : (
          // biome-ignore lint/a11y/useMediaCaption: see above
          <video
            ref={attach}
            className="preview-media"
            // Still mounted when its picture cannot be shown, because the sound
            // can be, and the transport under it is what plays it.
            hidden={unshown !== undefined}
            src={src}
            /* Not decoration and not caution: a caption track is fetched with
               CORS or not at all, so without this the `<track>` below ends at
               `readyState 3` with no cues and nothing said anywhere (ADR-0025).
               The media's own load becomes a CORS request too, which is why
               every `roost://` response carries `access-control-allow-origin`. */
            crossOrigin="anonymous"
            autoPlay
            onError={failed}
            onLoadedMetadata={measured}
          >
            {tracks.map((track) => (
              <Caption key={track.id} track={track} />
            ))}
          </video>
        )}
        {unshown}
      </div>
      {/* Outside the picture, because audio hides that box entirely and an
          unplayable sound file has the same nothing to say about itself. A
          video says it in the picture's place instead (§7.3). */}
      {problem !== undefined && detail.kind === "audio" && (
        <div className="preview-media-problem">
          <p>{problem.line}</p>
          {problem.said !== "" && <p className="preview-media-said">{problem.said}</p>}
        </div>
      )}
      <Transport
        media={element}
        stage={stage}
        comments={detail.comments}
        probedMs={detail.durationMs}
        fps={frameRate(detail.props["video.fps"])}
        subtitles={tracks}
        onAddSubtitle={addSubtitle}
      />
      {fitControl}
    </div>
  );
}

/** What a video whose picture this window cannot decode says first. */
function blindLine(detail: WireAssetDetail): string {
  const codec = detail.props["video.codec"];
  return codec === undefined
    ? "This window cannot play the picture in this video"
    : `This window cannot play ${codecName(codec)} video`;
}

/**
 * And what it means, which is not what the thumbnail's missing decoder means.
 *
 * Two decoders are involved and only one of them is the system's: the pane
 * plays through Chromium's, which is fixed when Electron is built, and the
 * thumbnail is drawn by the system's ffmpeg (ADR-0017). Installing something
 * fixes the second and never the first — so the sentence says which is which,
 * rather than sending somebody to install a codec that the pane will ignore.
 */
function blindHint(detail: WireAssetDetail): string {
  const sound =
    detail.props["audio.codec"] === undefined
      ? ""
      : "The sound can still be played — only the picture is missing. ";
  // What installing something would do for the *thumbnail* is the card's to
  // say, under this, with the command beside it (ADR-0050).
  return `${sound}Chromium, which draws this window, has no decoder for it, and nothing installed on the system changes that; a player that has one can open it.`;
}

/**
 * A media element's failure, said in the interface's voice.
 *
 * The codes are `MediaError`'s and they are genuinely different questions: 2 is
 * about the bytes and points at `roost://`, 3 and 4 are about the decoder and
 * point at the file. Naming the codec is what makes the common one actionable —
 * *"this window cannot play hevc"* is something a person can act on, and "the
 * video could not be played" is not.
 */
function mediaProblem(code: number, detail: WireAssetDetail): string {
  const codec = detail.props["video.codec"] ?? detail.props["audio.codec"];
  const named = codec === undefined ? "this file" : `${codec} files`;
  switch (code) {
    case 2:
      // Not the decoder: the bytes never arrived. A library on a drive that has
      // gone away reaches here, and so would a bug in the protocol handler.
      return "The file could not be read from the library.";
    case 3:
      return `The picture stops partway through — ${named} decoded this far and no further.`;
    default:
      // 4, `MEDIA_ERR_SRC_NOT_SUPPORTED`. Two different faults arrive here and
      // the code cannot tell them apart, so the sentence names both rather than
      // picking one: the window's decoder list is narrower than ffmpeg's, and a
      // route that answered 404 looks exactly the same from an element.
      return `This window could not play ${named} — either it has no decoder for it, or the file could not be read from the library.`;
  }
}

/**
 * The two arrows in the head, drawn here.
 *
 * Inline rather than an icon package, for invariant 7's reason and the
 * transport's: one shape mirrored is not a dependency. The `<button>` around it
 * carries the words, so this is hidden from the accessible tree.
 */
function Arrow({ back = false }: { readonly back?: boolean }): React.JSX.Element {
  return (
    <svg
      className="preview-arrow"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      style={back ? { transform: "scaleX(-1)" } : undefined}
    >
      <path
        d="M9 3.5 13.5 8 9 12.5 7.9 11.4l2.6-2.6H2.5V7.2h8L7.9 4.6 9 3.5z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * One caption track, as WebVTT (ADR-0025).
 *
 * **Never `default`.** A track marked default shows itself, and a subtitle that
 * turns itself on is the thing people go looking for the button to turn off.
 * The transport's CC menu is that button, and it starts at Off.
 *
 * The `src` is `roost://subtitle/<id>` and not `roost://file/`, because
 * what comes back is a conversion: `<track>` accepts WebVTT and nothing else,
 * and the format people have is SubRip.
 */
function Caption({ track }: { readonly track: WireSubtitle }): React.JSX.Element {
  return (
    <track
      kind="subtitles"
      src={`roost://subtitle/${track.id}`}
      label={track.label ?? track.lang ?? track.name}
      {...(track.lang === null ? {} : { srcLang: track.lang })}
    />
  );
}

/**
 * A font: the specimen the derive pass drew, and what the font calls itself.
 *
 * The specimen is a stored thumbnail like any other — drawn from outlines, so
 * nothing here loads a font (ADR-0015) — and this is a `<img>` at the preview
 * size rather than live text in the window's own renderer.
 */
function Specimen({ detail }: { readonly detail: WireAssetDetail }): React.JSX.Element {
  const family = detail.props["font.family"] ?? detail.name;
  const style = detail.props["font.style"];

  return (
    <div className="preview-specimen">
      <img
        className="preview-media"
        src={previewSrc(detail.id, detail.posterMs, detail.derivedAt)}
        alt={`Specimen of ${family}`}
        onLoad={showLoaded}
        onError={fallbackToGrid}
      />
      <p className="preview-specimen-name">
        {style === undefined ? family : `${family} · ${style}`}
      </p>
      <button
        type="button"
        onClick={() => void invoke({ type: "asset:openExternally", id: detail.id })}
      >
        Open externally
      </button>
    </div>
  );
}

/**
 * Everything Roost cannot draw yet: a PDF, a font, a `.blend`, an archive.
 *
 * The thumbnail if there is one, the extension if there is not, and the button
 * that hands the file to the application that owns it. `CONCEPT.md` §5 is
 * explicit that this is not a failure state — it is what a library that holds
 * anything looks like.
 */
function Fallback({ detail }: { readonly detail: WireAssetDetail }): React.JSX.Element {
  return (
    <div className="preview-fallback">
      <div className="inspector-preview">
        <Placeholder kind={detail.kind} ext={detail.ext} undrawn={detail.undrawn} />
        <img
          className="cell-image"
          src={previewSrc(detail.id, detail.posterMs, detail.derivedAt)}
          alt=""
          decoding="async"
          onLoad={showLoaded}
          onError={fallbackToGrid}
        />
      </div>
      <p>Roost cannot show a {detail.ext === "" ? "file of this kind" : detail.ext} yet.</p>
      <button
        type="button"
        data-variant="primary"
        onClick={() => void invoke({ type: "asset:openExternally", id: detail.id })}
      >
        Open externally
      </button>
    </div>
  );
}
