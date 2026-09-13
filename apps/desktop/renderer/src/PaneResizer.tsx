import { useRef } from "react";

/**
 * The seam between two columns, as something to drag (`UI_SPEC.md` §1).
 *
 * **The width does not go through React while the pointer is down.** A drag
 * emits an event per pixel, and a `setState` each would re-render the grid's
 * whole tree for a number it does not read — the rule in `CLAUDE.md` §8 that
 * the cell props exist for. It writes one custom property on the workspace
 * instead; the pane is sized from that property, and the grid reflows because
 * it is already watching its own box (`Grid.tsx`). The engine hears about it
 * once, when the pointer comes up.
 *
 * It is a `separator` rather than a decorated `div`: the arrow keys move it,
 * because a pointer is not the only way somebody drives this window, and the
 * value is announced with its bounds so that "how wide is this" has an answer
 * without pixels being counted on screen.
 */

/** What one arrow key is worth. A tenth of the range, near enough, in both. */
const STEP = 16;

/**
 * The bounds `UI_SPEC.md` §1 sets, and the width each pane starts at.
 *
 * The window's, as the zoom steps are (`grid/layout.ts`): the engine holds the
 * same two ranges as a guard on what it reads from a file it does not write,
 * and neither copy is the other's authority. A number in here is a fact about
 * the interface — how narrow a folder tree can be before it is useless.
 */
export const SIDEBAR = { min: 220, max: 420, fallback: 240 } as const;
export const INSPECTOR = { min: 280, max: 480, fallback: 280 } as const;

export interface PaneResizerProps {
  /** What is being resized, for the screen reader: "Sidebar", "Inspector". */
  readonly pane: string;
  /** The property the pane's width is read from — declared in `app.css`. */
  readonly token: string;
  /**
   * Which side of the seam the pane is on.
   *
   * `before` for the sidebar, whose width grows as the pointer moves right;
   * `after` for the inspector, whose width grows as it moves left. The whole
   * of the difference between the two instances.
   */
  readonly side: "before" | "after";
  readonly width: number;
  readonly min: number;
  readonly max: number;
  /** What a double-click goes back to, which is what the library shipped with. */
  readonly fallback: number;
  /** The element carrying the property — the flex row the panes are in. */
  readonly surface: React.RefObject<HTMLElement | null>;
  /** Called once a gesture ends, with the width the library should remember. */
  readonly onCommit: (width: number) => void;
}

export function PaneResizer({
  pane,
  token,
  side,
  width,
  min,
  max,
  fallback,
  surface,
  onCommit,
}: PaneResizerProps): React.JSX.Element {
  /** The last width this drag wrote, so the pointer-up commits what is drawn. */
  const drawn = useRef(width);

  /**
   * The width on screen right now, which is not always the one in `width`.
   *
   * A gesture continues from **what is drawn**, because that is what the hand
   * is on. The prop is a round trip behind at the moment a commit is in
   * flight — the window holds the new value, sends it, and takes the engine's
   * answer — and a drag that started from the prop in that window would jump
   * by the difference. Seen as a flake in `check-panes.mjs` before it was ever
   * seen by a person, which is the only reason it is written down here.
   */
  const onScreen = (): number => {
    const element = surface.current;
    if (element === null) return width;
    const held = Number.parseFloat(getComputedStyle(element).getPropertyValue(token));
    return Number.isFinite(held) ? held : width;
  };

  const draw = (next: number): number => {
    const clamped = Math.round(Math.min(Math.max(next, min), max));
    drawn.current = clamped;
    surface.current?.style.setProperty(token, `${clamped}px`);
    return clamped;
  };

  return (
    // An `<hr>` because that is what a separator is in HTML — the element the
    // role names, rather than a `div` wearing it. Its own border and margins
    // are removed in `app.css`: the line on screen is the pane's, and this is
    // the handle for moving it.
    <hr
      className="pane-resizer"
      // No `role`: an `<hr>` is a separator already, and saying so twice is
      // the kind of thing that goes stale.
      aria-label={`${pane} width`}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(event) => {
        // The primary button only: a right-click here is on its way to a
        // context menu, and capturing it would swallow one.
        if (event.button !== 0) return;
        event.preventDefault();
        const from = event.clientX;
        const started = onScreen();
        drawn.current = started;
        const handle = event.currentTarget;
        // Captured so that a drag leaving the window keeps arriving here.
        //
        // **Best-effort, exactly as the grid's sweep is** (`Grid.tsx`):
        // `setPointerCapture` throws for a pointer the browser does not
        // consider active, which is every synthetic one — so a capture that
        // failed must not take the gesture with it. The listeners below are on
        // the window rather than on this element for the same reason: with the
        // capture they are reached by bubbling, and without it they are the
        // whole of what makes the drag work.
        try {
          handle.setPointerCapture(event.pointerId);
        } catch {
          // No capture. The drag still works while the pointer is in the window.
        }
        // Read by the CSS that stops the columns selecting text under the
        // cursor, and keeps `col-resize` on for the whole gesture rather than
        // only while the pointer is over the seam.
        surface.current?.setAttribute("data-resizing", "");
        // On the handle as well as the row: the row's attribute is what stops
        // the columns selecting text, and this one is what keeps the seam lit
        // while the pointer is out over the grid, where it spends the drag.
        handle.setAttribute("data-dragging", "");

        const move = (moved: PointerEvent): void => {
          const delta = moved.clientX - from;
          draw(side === "before" ? started + delta : started - delta);
        };
        const done = (): void => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", done);
          window.removeEventListener("pointercancel", done);
          surface.current?.removeAttribute("data-resizing");
          handle.removeAttribute("data-dragging");
          // The engine hears once, at the end. A write per pixel would be a
          // file write per pixel, and the number in between is on screen
          // already.
          if (drawn.current !== started) onCommit(drawn.current);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", done);
        window.addEventListener("pointercancel", done);
      }}
      // What a file manager does with the seam, and the way back from a width
      // somebody has dragged into a corner.
      onDoubleClick={() => {
        onCommit(draw(fallback));
      }}
      onKeyDown={(event) => {
        const step =
          event.key === "ArrowLeft" ? -STEP : event.key === "ArrowRight" ? STEP : undefined;
        if (step === undefined) return;
        event.preventDefault();
        // The keyboard moves the pane, not the seam: for the inspector the two
        // point in opposite directions, and a key that widened the column it is
        // pushing into would be the arrow lying about which way it goes.
        onCommit(draw(onScreen() + (side === "before" ? step : -step)));
      }}
    />
  );
}
