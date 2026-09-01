import type { WireAssetDetail, WireComment } from "@roost/contract";
import { useEffect, useRef, useState } from "react";
import { invoke } from "../bridge.js";
import { fallbackToGrid, previewSrc } from "../thumbnail.js";
import { timecode } from "../timecode.js";
import { playhead } from "./playhead.js";

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
   * does — otherwise the marker strip would be right only until somebody used
   * the panel next to it.
   */
  readonly generation: number;
  readonly onClose: () => void;
  /** Moves to the previous or next loaded asset, changing the selection. */
  readonly onStep: (delta: -1 | 1) => void;
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
 * Video and audio, with a strip of comment markers under the native controls.
 *
 * **Under the control bar, not instead of it** (ADR-0023 §6). The browser's own
 * bar cannot carry marks of ours, and the only other way past that is a custom
 * transport — which means owning buffering, fullscreen, the keyboard map, and
 * the accessibility of a media player, a commitment `UI_SPEC.md` §7 has avoided
 * on purpose.
 *
 * The strip is drawn whether or not there is anything on it, so that writing the
 * first comment does not move the picture it is about.
 *
 * Nothing here follows the playhead. The native bar draws the position a pixel
 * above this strip, and a second indicator would be a `requestAnimationFrame`
 * loop for the whole of a film to redraw what is already on screen.
 */
function Player({
  detail,
  src,
}: {
  readonly detail: WireAssetDetail;
  readonly src: string;
}): React.JSX.Element {
  const media = useRef<HTMLMediaElement | null>(null);
  /**
   * What the element says, once it has said anything.
   *
   * Derived rather than seeded from `detail.durationMs`, and the difference is
   * not academic: a `useState` initialiser runs once, so a strip that opened
   * before the derive pass had probed the file would hold `null` for as long as
   * the preview stayed open — and there is no second chance if the element
   * itself never loads. Found in a real window, against a video Chromium
   * refused to decode: the library knew the duration and the strip stayed
   * empty.
   */
  const [measured, setMeasured] = useState<number | null>(null);
  // The element's own answer wins: it is the timeline the markers are placed
  // along. The probe's is what lets a marker be drawn before the file loads.
  const duration = measured ?? detail.durationMs;

  // Registered for the inspector's list to seek, which is in another subtree
  // entirely (`playhead.ts`).
  useEffect(() => {
    const element = media.current;
    return element === null ? undefined : playhead.attach(element);
  }, []);

  const measure = (): void => {
    const seconds = media.current?.duration;
    if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) {
      setMeasured(Math.round(seconds * 1000));
    }
  };

  /*
   * The file is the user's own and there is nowhere a caption track could come
   * from — M4's metadata pass is where an embedded one would be found.
   */
  return (
    <div className="preview-player">
      {detail.kind === "audio" ? (
        // biome-ignore lint/a11y/useMediaCaption: see above
        <audio
          ref={(element) => {
            media.current = element;
          }}
          className="preview-audio"
          src={src}
          controls
          autoPlay
          onLoadedMetadata={measure}
        />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: see above
        <video
          ref={(element) => {
            media.current = element;
          }}
          className="preview-media"
          src={src}
          controls
          autoPlay
          onLoadedMetadata={measure}
        />
      )}
      <Markers comments={detail.comments} duration={duration} />
    </div>
  );
}

/**
 * One tick per timed comment, placed along the medium's own timeline.
 *
 * Untimed comments are not here on purpose: they are about the asset rather
 * than about a moment in it, and a tick at zero would say something the comment
 * does not. They are in the inspector's list, which holds both.
 */
function Markers({
  comments,
  duration,
}: {
  readonly comments: readonly WireComment[];
  readonly duration: number | null;
}): React.JSX.Element {
  const timed = comments.filter((comment) => comment.atMs !== null);
  const placeable = duration !== null && duration > 0;

  return (
    // No role and no name of its own: the strip is a track, and every tick on
    // it says where it goes and what is written there. A named group here would
    // announce a heading over controls that already describe themselves.
    <div className="preview-markers">
      {placeable &&
        timed.map((comment) => {
          const at = comment.atMs ?? 0;
          return (
            <button
              key={comment.id}
              type="button"
              className="preview-marker"
              // Clamped: a comment written against a duration the probe
              // reported and the file disagrees with must stay on the strip.
              style={{ left: `${Math.min(100, (at / duration) * 100)}%` }}
              title={`${timecode(at)} — ${comment.body}`}
              aria-label={`Play from ${timecode(at)}: ${comment.body}`}
              onClick={() => playhead.seek(at)}
            />
          );
        })}
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
