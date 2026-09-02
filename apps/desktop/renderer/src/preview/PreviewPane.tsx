import type { WireAssetDetail } from "@roost/contract";
import { useEffect, useRef, useState } from "react";
import { invoke } from "../bridge.js";
import { fallbackToGrid, previewSrc } from "../thumbnail.js";
import { playhead } from "./playhead.js";
import { Transport } from "./Transport.js";

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
 * Bytes arrive over `roost://original/<hash>`, which answers range requests —
 * which is what makes a `<video>` seek rather than download (ADR-0008).
 */

export interface PreviewPaneProps {
  readonly hash: string;
  /**
   * Bumped by the caller when something outside the pane changed the library.
   *
   * The inspector is on screen beside the preview and can add a comment to the
   * asset being played, so the pane re-reads on it exactly as the inspector
   * does — otherwise the marks on the timeline would be right only until
   * somebody used the panel next to it.
   */
  readonly generation: number;
  readonly onClose: () => void;
  /** Moves to the previous or next loaded asset, changing the selection. */
  readonly onStep: (delta: -1 | 1) => void;
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
function mediaKey(key: string): boolean {
  switch (key) {
    case " ":
    case "k":
      return playhead.toggle();
    case "m":
      return playhead.toggleMute();
    case "j":
      return playhead.nudge(-10_000);
    case "l":
      return playhead.nudge(10_000);
    default:
      // Frame stepping and the A-B loop, which need state the pane has no
      // reason to hold. `playhead.ts` says why they are delegated rather than
      // lifted.
      return playhead.key(key);
  }
}

export function PreviewPane({
  hash,
  generation,
  onClose,
  onStep,
}: PreviewPaneProps): React.JSX.Element {
  const [detail, setDetail] = useState<WireAssetDetail | undefined>();
  const [page, setPage] = useState(0);
  const pane = useRef<HTMLDivElement>(null);
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
    // asset replaces the element anyway, because `Stage` is keyed on the hash.
    setDetail((held) => (held?.hash === hash ? held : undefined));
    // Back to the first page: stepping to the next asset must not open it at
    // page forty because that is where the last document was left.
    setPage((at) => (detailHash.current === hash ? at : 0));
    detailHash.current = hash;
    void (async () => {
      const outcome = await invoke({ type: "asset:detail", hash });
      if (current && outcome.ok && outcome.value !== null) setDetail(outcome.value);
    })();
    return () => {
      current = false;
    };
  }, [hash, generation]);

  // The pane takes focus when it opens: it is the thing the keyboard is now
  // for, and a preview that needs a click before the arrow keys work is a
  // preview nobody drives with the keyboard.
  useEffect(() => {
    pane.current?.focus();
  }, []);

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
      <header className="preview-bar">
        <span className="preview-name">{detail?.name ?? ""}</span>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="preview-stage">
        {detail === undefined ? null : <Stage detail={detail} page={page} onTurn={turn} />}
      </div>
    </div>
  );
}

/**
 * What the asset renders as.
 *
 * Keyed on the hash so that stepping to the next asset replaces the element
 * rather than reusing it: a `<video>` given a new `src` keeps the old one's
 * playback state, and a paused frame from the previous asset is worse than a
 * blank one.
 */
function Stage({
  detail,
  page,
  onTurn,
}: {
  readonly detail: WireAssetDetail;
  readonly page: number;
  readonly onTurn: (delta: number) => void;
}): React.JSX.Element {
  const src = `roost://original/${detail.hash}`;

  if (detail.kind === "image") {
    // An SVG renders through the same `<img>`, which is what sandboxes it:
    // scripts in an image do not run, and neither do external references.
    return <img key={detail.hash} className="preview-media" src={src} alt={detail.name} />;
  }

  if (detail.kind === "video" || detail.kind === "audio") {
    return <Player key={detail.hash} detail={detail} src={src} />;
  }

  // A document with pages to turn. `pageCount` is null until the derive pass
  // has been over it, and a document nobody has counted yet falls through to
  // its thumbnail rather than to a pager with one page in it.
  if (detail.kind === "document" && detail.pageCount !== null && detail.pageCount > 0) {
    return (
      <Pages
        key={detail.hash}
        detail={detail}
        pages={detail.pageCount}
        page={page}
        onTurn={onTurn}
      />
    );
  }

  if (detail.kind === "font") {
    return <Specimen key={detail.hash} detail={detail} />;
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
 * Each page is an `<img>` pointed at `roost://page/<hash>/<n>@1024`, rendered
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
        src={`roost://page/${detail.hash}/${shown}@1024`}
        alt={`Page ${shown + 1} of ${pages}`}
      />
      <div className="preview-pager">
        <button type="button" disabled={shown === 0} onClick={() => onTurn(-1)}>
          Previous
        </button>
        <span className="preview-page-count">
          {(shown + 1).toLocaleString()} / {pages.toLocaleString()}
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
 */
function Player({
  detail,
  src,
}: {
  readonly detail: WireAssetDetail;
  readonly src: string;
}): React.JSX.Element {
  const [element, setElement] = useState<HTMLVideoElement | HTMLAudioElement | null>(null);
  const stage = useRef<HTMLDivElement>(null);

  // Registered for the inspector's comment list to seek and for the pane's own
  // keys to drive, both of which are outside this subtree (`playhead.ts`).
  useEffect(() => (element === null ? undefined : playhead.attach(element)), [element]);

  /*
   * The file is the user's own and there is nowhere a caption track could come
   * from — M4's metadata pass is where an embedded one would be found.
   */
  return (
    <div className="preview-player" data-kind={detail.kind} ref={stage}>
      {detail.kind === "audio" ? (
        // biome-ignore lint/a11y/useMediaCaption: see above
        <audio ref={setElement} className="preview-audio" src={src} autoPlay />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: see above
        <video ref={setElement} className="preview-media" src={src} autoPlay />
      )}
      <Transport
        media={element}
        stage={stage}
        comments={detail.comments}
        probedMs={detail.durationMs}
        fps={frameRate(detail.props["video.fps"])}
      />
    </div>
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
        src={previewSrc(detail.hash)}
        alt={`Specimen of ${family}`}
        onError={fallbackToGrid}
      />
      <p className="preview-specimen-name">
        {style === undefined ? family : `${family} · ${style}`}
      </p>
      <button
        type="button"
        onClick={() => void invoke({ type: "asset:openExternally", hash: detail.hash })}
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
        <span className="cell-kind">{detail.ext === "" ? "file" : detail.ext}</span>
        <img
          className="cell-image"
          src={previewSrc(detail.hash)}
          alt=""
          decoding="async"
          onError={fallbackToGrid}
        />
      </div>
      <p>Roost cannot show a {detail.ext === "" ? "file of this kind" : detail.ext} yet.</p>
      <button
        type="button"
        data-variant="primary"
        onClick={() => void invoke({ type: "asset:openExternally", hash: detail.hash })}
      >
        Open externally
      </button>
    </div>
  );
}
