import { useShownAfter } from "../delay.js";

/** An open in flight, as the picker knows it. */
export interface Opening {
  /** What the person picked, as they would recognise it. */
  readonly name: string;
  /**
   * How much of the journal has been folded, 0 to 1 — or `undefined` when the
   * open is not folding, which is the ordinary case (`library:folding`).
   */
  readonly fraction: number | undefined;
}

/**
 * Says that a library is opening, once it has taken long enough to need saying.
 *
 * **A bar only when there is a number to draw.** Most opens find the index
 * already matching the journal and have nothing to count, so they get a line
 * of text and nothing that pretends to move. An open that folds the journal
 * reports how many bytes it has read, and that is a real fraction — so it gets
 * a real bar rather than a spinner (`UI_SPEC.md` §0.6).
 */
export function OpeningStatus({
  opening,
}: {
  readonly opening: Opening | undefined;
}): React.JSX.Element | null {
  // The grid's skeleton waits the same time: an ordinary open answers in a
  // fifth of a second at a hundred thousand assets.
  const shown = useShownAfter(opening !== undefined);
  if (opening === undefined || !shown) return null;

  const fraction = opening.fraction;
  // A read that has finished is not a bar at 100% any more: what follows it —
  // queueing the thumbnails still missing — has no count to draw, and a full
  // bar that sits there is the one §0.6 forbids by name.
  const reading = fraction !== undefined && fraction < 1;
  const percent = reading ? Math.round(fraction * 100) : undefined;

  return (
    <div className="opening" role="status">
      <span className="opening-name">Opening {opening.name}…</span>
      {fraction !== undefined && !reading && (
        <span className="opening-stage">Getting it ready</span>
      )}
      {percent !== undefined && (
        <>
          <span className="opening-stage">Reading the journal</span>
          <div className="opening-track">
            <div
              className="opening-bar"
              role="progressbar"
              aria-label="Reading the journal"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div className="opening-fill" style={{ width: `${percent}%` }} />
            </div>
            <span className="opening-percent">{percent}%</span>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A library's name from its path, for saying which one is opening.
 *
 * Only for display. The engine reads the real name from the manifest; this is
 * what the person picked, before the engine has said anything, and the folder's
 * name is the best guess the window has without a filesystem (ADR-0014).
 */
export function openingName(path: string, suffix: string): string {
  const last =
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? path;
  return last.endsWith(suffix) && last.length > suffix.length
    ? last.slice(0, -suffix.length)
    : last;
}
