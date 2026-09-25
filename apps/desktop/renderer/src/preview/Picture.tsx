import type { WireAssetDetail } from "@roost/contract";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { explainFailure } from "../deriveReason.js";
import { fallbackFromRendition } from "../thumbnail.js";
import { Unshowable } from "./Unshowable.js";

/**
 * A picture, at whatever size somebody wants to look at it (`UI_SPEC.md` §7).
 *
 * Asked for on 2026-09-07: *"jika view foto. tambahkan untuk zoom in atau zoom
 * out"*, and then *"terus bisa pakai scroll untuk zoom in atau out nya"*. §7
 * has asked for click-to-1:1 and drag-to-pan since it was written and the pane
 * fitted the picture and stopped there — which is the difference between
 * looking at a photograph and checking one.
 *
 * **Fit is the resting state, and it is a state rather than a number.** While
 * nothing has been zoomed the scale is held as `null` and computed from the
 * pane, so dragging the window wider re-fits the picture instead of leaving it
 * at the size the old pane happened to want. The first zoom fixes a number, and
 * from then on the number is what is drawn.
 *
 * **A photograph is never blown up at rest**: the fit is capped at 1, so a 64px
 * icon opens at 64px rather than as a wall of mush. Zooming in past that is
 * something somebody asked for, which is a different thing.
 *
 * **The wheel zooms about the pointer**, not about the middle: the pixel under
 * the cursor is the one being examined, so it is the one that must not move.
 * No modifier is needed — the stage scrolls nothing, so the wheel has no other
 * job here — and a trackpad pinch arrives as a wheel event with `ctrlKey` set,
 * which lands on the same handler and means the same thing.
 */

/** How much one press of a button, or of `+`, changes the scale. */
const STEP = 1.25;

/** The ceiling, in image pixels to the screen pixel. */
const MAX_SCALE = 16;

/**
 * How fast the wheel zooms, per pixel of `deltaY`.
 *
 * Exponential rather than additive: a step has to be a *proportion* of what is
 * on screen, or the same notch is imperceptible at 8× and a leap at fit.
 */
const WHEEL_GAIN = 0.0015;

/** A wheel that reports lines rather than pixels, at roughly a line's height. */
const LINE_HEIGHT = 16;

/** Below this, a press is a click and not a drag (`UI_SPEC.md` §7). */
const DRAG_SLOP = 4;

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The scale that fits `natural` inside `box`, never above 1.
 *
 * Zero for either is the state before the image has loaded or before the pane
 * has been measured; 1 is the only honest answer to that, and the picture is
 * not drawn until both are known anyway.
 */
export function fitScale(natural: Size, box: Size): number {
  if (natural.width <= 0 || natural.height <= 0 || box.width <= 0 || box.height <= 0) return 1;
  return Math.min(1, box.width / natural.width, box.height / natural.height);
}

/**
 * Where the picture actually sits, given where it was asked to sit.
 *
 * An axis smaller than the pane is **centred and not pannable** — a photograph
 * that can be dragged into a corner of an empty pane is a photograph somebody
 * has to put back. An axis larger than the pane is clamped to its own edges, so
 * a drag can never leave the pane blank.
 */
export function placeOffset(scaled: Size, box: Size, wanted: Point): Point {
  const axis = (size: number, along: number, at: number): number => {
    if (size <= along) return Math.round((along - size) / 2);
    return Math.min(0, Math.max(along - size, at));
  };
  return {
    x: axis(scaled.width, box.width, wanted.x),
    y: axis(scaled.height, box.height, wanted.y),
  };
}

/**
 * The offset that keeps the point under `at` under `at`, across a scale change.
 *
 * The whole of what makes wheel zoom feel like a magnifier rather than like a
 * slider somewhere else on screen.
 */
export function zoomAbout(at: Point, offset: Point, from: number, to: number): Point {
  const ratio = to / from;
  return {
    x: at.x - (at.x - offset.x) * ratio,
    y: at.y - (at.y - offset.y) * ratio,
  };
}

export interface PictureHandle {
  /** Multiplies the scale about the middle of the pane, as a key press does. */
  zoomBy(factor: number): void;
  /** Fit ↔ 1:1, which is what a click on the picture does. */
  toggle(): void;
}

export function Picture({
  detail,
  src,
  controls,
  ref,
}: {
  readonly detail: WireAssetDetail;
  readonly src: string;
  /**
   * Where the zoom controls are drawn: the slot at the head of the pane.
   *
   * They belong to the picture — the scale is its state and nothing else has
   * it — and they are drawn a pane away from it, so they go through a portal
   * rather than through a second copy of the state held one component up. The
   * head is the pane's own row of controls (`UI_SPEC.md` §7) and putting them
   * there gives the picture back the strip they were standing on, which is
   * what was asked for on 2026-09-07. `null` while the pane is mounting.
   */
  readonly controls: HTMLElement | null;
  readonly ref?: React.Ref<PictureHandle>;
}): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  /** `null` while the picture is still simply fitted. */
  const [scale, setScale] = useState<number | null>(null);
  const [wanted, setWanted] = useState<Point>({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  /** Every source failed: the rendition, and both sizes of the thumbnail. */
  const [lost, setLost] = useState(false);

  const fit = natural === null ? 1 : fitScale(natural, box);
  const current = scale ?? fit;
  const scaled: Size =
    natural === null
      ? { width: 0, height: 0 }
      : { width: natural.width * current, height: natural.height * current };
  const offset = placeOffset(scaled, box, wanted);
  const pannable = scaled.width > box.width || scaled.height > box.height;
  /**
   * Both halves are known, so what is drawn is a size somebody chose.
   *
   * The picture is transparent until then. The two arrive independently — the
   * pane is measured when it mounts and the pixels when the bytes land — and a
   * picture drawn between them is drawn against a box of nothing, which is a
   * flash of 1:1 before it settles to the fit. Seen in a real window on
   * 2026-09-07, at 1600px in a pane 736 wide.
   */
  const ready = natural !== null && box.width > 0 && box.height > 0;

  // Before paint rather than after it, for the same reason: this measurement is
  // what the first frame is composed from.
  useLayoutEffect(() => {
    const node = viewport.current;
    // happy-dom computes no layout and has no observer; a window has both, and
    // this is the only thing that tells the picture how much room it has been
    // given.
    if (node === null || typeof ResizeObserver === "undefined") return;
    const measure = (): void => setBox({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /**
   * Moves to `next`, keeping whatever is under `at` where it is.
   *
   * Everything that changes the scale comes through here — the wheel, the
   * buttons, the keys, and the click — so the clamp and the anchoring are
   * written once. Below the fit is not a scale anybody asked for: a picture
   * smaller than the room it is in only makes the pane emptier.
   */
  const apply = useCallback(
    (next: number, at: Point | null): void => {
      if (natural === null) return;
      const to = Math.min(MAX_SCALE, Math.max(fit, next));
      if (to === current) return;
      const anchor = at ?? { x: box.width / 2, y: box.height / 2 };
      const moved = zoomAbout(anchor, offset, current, to);
      // Back to `null` at the fit, so the picture re-fits when the pane is
      // resized rather than staying at the number the old pane wanted.
      setScale(to <= fit ? null : to);
      setWanted(moved);
    },
    [box, current, fit, natural, offset],
  );

  const toggle = useCallback(
    (at: Point | null): void => {
      if (current > fit) {
        setScale(null);
        setWanted({ x: 0, y: 0 });
        return;
      }
      apply(1, at);
    },
    [apply, current, fit],
  );

  // The pane's own key handling reaches in through this: `+` and `-` belong to
  // whatever is on screen, and the pane is the thing that has the focus.
  useImperativeHandle(
    ref,
    () => ({
      zoomBy: (factor: number) => apply(current * factor, null),
      toggle: () => toggle(null),
    }),
    [apply, current, toggle],
  );

  /*
   * The wheel is subscribed by hand, and the handler reads the latest state out
   * of refs rather than closing over it. React's own `onWheel` is passive, so
   * `preventDefault` inside it does nothing — and without that the gesture is
   * also whatever Chromium decides a wheel over a picture means. Subscribed
   * once, because re-subscribing on every zoom would be a listener swapped in
   * the middle of the gesture that is causing it.
   */
  const latest = useRef(apply);
  const currentScale = useRef(current);
  useEffect(() => {
    latest.current = apply;
    currentScale.current = current;
  });
  useEffect(() => {
    const node = viewport.current;
    if (node === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const delta = event.deltaMode === 1 ? event.deltaY * LINE_HEIGHT : event.deltaY;
      latest.current(currentScale.current * Math.exp(-delta * WHEEL_GAIN), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  /** Where a press started, so a drag can be told from a click on release. */
  const press = useRef<{ from: Point; origin: Point; moved: boolean } | null>(null);

  const bar = (
    /*
      Always drawn, never revealed on hover: a control that appears only under
      the pointer is one a keyboard cannot find, which is the rule the comment
      rows already follow (`UI_SPEC.md` §3.8).
    */
    <div className="preview-zoom">
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        disabled={current <= fit}
        onClick={() => apply(current / STEP, null)}
      >
        −
      </button>
      {/* The readout is the control: a percentage says where the picture is,
          and the one thing somebody wants from it is the way back. */}
      <button
        type="button"
        className="preview-zoom-level"
        aria-label={current > fit ? "Fit to the pane" : "Zoom to actual size"}
        title={current > fit ? "Fit to the pane" : "Zoom to actual size"}
        disabled={natural === null || (fit >= 1 && current === 1)}
        onClick={() => toggle(null)}
      >
        {percent(current)}
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        disabled={current >= MAX_SCALE}
        onClick={() => apply(current * STEP, null)}
      >
        +
      </button>
    </div>
  );

  if (lost) {
    // No zoom bar either: there is nothing to zoom, and a control that does
    // nothing reads as one that is broken.
    // Where the derive is stalled, the card below says the hint and the steps;
    // saying the hint here as well would be saying it twice.
    const explained = detail.undrawn === null ? undefined : explainFailure(detail.undrawn);
    return (
      <Unshowable
        detail={detail}
        line={explained?.line ?? `Roost cannot show this ${detail.ext.toUpperCase()} here`}
        hint={
          explained === undefined
            ? "It is in the library, safe as it is, and opens in the application that owns it."
            : undefined
        }
        cardHeading={false}
      />
    );
  }

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the picture is drawn for the pointer; the same two actions are a button and a key below and on the pane */}
      <div
        className="preview-photo-view"
        ref={viewport}
        data-ready={ready ? "" : undefined}
        data-pannable={pannable ? "" : undefined}
        data-panning={panning ? "" : undefined}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          press.current = {
            from: { x: event.clientX, y: event.clientY },
            origin: offset,
            moved: false,
          };
          setPanning(true);
          // Held by the element, so a drag that leaves the pane keeps panning
          // rather than stopping at the edge with the button still down.
          if (typeof event.currentTarget.setPointerCapture === "function") {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        }}
        onPointerMove={(event) => {
          const held = press.current;
          if (held === null) return;
          const dx = event.clientX - held.from.x;
          const dy = event.clientY - held.from.y;
          if (Math.abs(dx) + Math.abs(dy) > DRAG_SLOP) held.moved = true;
          if (!pannable) return;
          setWanted({ x: held.origin.x + dx, y: held.origin.y + dy });
        }}
        onPointerUp={(event) => {
          const held = press.current;
          press.current = null;
          setPanning(false);
          if (held === null || held.moved) return;
          const rect = event.currentTarget.getBoundingClientRect();
          toggle({ x: event.clientX - rect.left, y: event.clientY - rect.top });
        }}
        onPointerCancel={() => {
          press.current = null;
          setPanning(false);
        }}
      >
        <img
          className="preview-photo-image"
          src={src}
          alt={detail.name}
          draggable={false}
          // A rendition that could not be made steps down to the thumbnail
          // Roost already has, rather than to Chromium's broken-image glyph
          // (ADR-0040 §7) — and past the last step, to saying why (§7.3).
          onError={(event) => {
            if (!fallbackFromRendition(event)) setLost(true);
          }}
          onLoad={(event) =>
            setNatural({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          /* Transparent rather than hidden until the pixels are known: the
             element is measured on `load` and its natural size is what every
             number here is computed from, so it has to be in the document —
             and `visibility: hidden` would also take it out of the accessible
             tree, where it is the picture being previewed. */
          style={
            natural === null
              ? { opacity: 0 }
              : {
                  ...(ready ? {} : { opacity: 0 }),
                  width: `${natural.width}px`,
                  height: `${natural.height}px`,
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${current})`,
                }
          }
        />
      </div>

      {controls === null ? null : createPortal(bar, controls)}
    </>
  );
}

/** The scale as somebody reads it. Whole percent: nobody is reading tenths. */
export function percent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
