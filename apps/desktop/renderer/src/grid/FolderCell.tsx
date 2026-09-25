import { forwardRef } from "react";
import { cellId } from "./AssetCell.js";
import type { GridView } from "./layout.js";

/**
 * One folder, drawn among the thumbnails (ADR-0043).
 *
 * `AssetCell`'s sibling, and deliberately not under the same contract. That
 * one is memo'd on primitives with no callback props because there are four
 * hundred of it on screen; there are as many of these as the folder on screen
 * has children, and only the visible ones are rendered. What it buys by being
 * ordinary is the context menu: the folder menu is a Radix trigger wrapped
 * around the cell, which needs the props and the ref forwarded to the element.
 *
 * **The tile is a sheet protector with the folder's pictures in it** — the
 * user's own drawing, 2026-09-25, which also asked for the cover ADR-0043 §7 had
 * left for later: up to four of the folder's newest pictures, its own first and
 * then its subfolders'. They are `roost://thumb` addresses the engine named
 * (`folder:covers`), never bytes (invariant 12).
 */

export interface FolderCellProps extends React.ComponentPropsWithoutRef<"div"> {
  /** The tile id, which is the folder's id in the grid's vocabulary. */
  readonly id: string;
  readonly name: string;
  /** How many assets the folder's own query finds, or `null` if uncounted. */
  readonly count: number | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly caption: number;
  /**
   * Whether this is the marked tile.
   *
   * The ring is the mark: a folder is never *selected*, because the selection
   * is what every edit acts on and a folder is not an asset (ADR-0043 §4).
   */
  readonly isFocused: boolean;
  readonly view: GridView;
  /** Up to four thumbnail addresses to draw inside the sheet, newest first. */
  readonly covers: readonly string[];
}

export const FolderCell = forwardRef<HTMLDivElement, FolderCellProps>(function FolderCell(
  { id, name, count, x, y, width, height, caption, isFocused, view, covers, ...rest },
  ref,
) {
  const label = count === null ? `${name}, folder` : `${name}, folder, ${count} assets`;
  const style = { transform: `translate(${x}px, ${y}px)`, width, height };

  /*
   * The count rides in the caption, beside the name.
   *
   * It was a badge in the corner of the picture until 2026-09-13, which put a
   * number over a filled shape — unreadable at one size, and in the way at
   * another. The band under the name is where a cell already has room for
   * text, and it is the same room at every zoom. **Not in Details**, where the
   * row's own Size column already says it, and saying it twice in one row is
   * noise.
   */
  const nameBand = (
    <span className="cell-name" title={name}>
      <span className="cell-name-text">{name}</span>
      {count !== null && view !== "details" && <span className="cell-count">{count}</span>}
    </span>
  );

  if (view !== "icons") {
    return (
      // biome-ignore lint/a11y/useFocusableInteractive: one tab stop, as AssetCell
      <div
        {...rest}
        ref={ref}
        id={cellId(id)}
        className="cell cell-folder"
        data-id={id}
        data-folder=""
        data-view={view}
        data-focused={isFocused || undefined}
        role="option"
        aria-selected={false}
        aria-label={label}
        style={style}
      >
        <div className="cell-thumb">
          <FolderSheet covers={NO_COVERS} />
        </div>
        {nameBand}
        {view === "details" && (
          <>
            <span className="cell-field">FOLDER</span>
            <span className="cell-field">{count === null ? "—" : `${count} assets`}</span>
            <span className="cell-field">—</span>
            <span className="cell-field">—</span>
          </>
        )}
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/useFocusableInteractive: see above
    <div
      {...rest}
      ref={ref}
      id={cellId(id)}
      className="cell cell-folder"
      data-id={id}
      data-folder=""
      data-view="icons"
      data-focused={isFocused || undefined}
      role="option"
      aria-selected={false}
      aria-label={label}
      style={style}
    >
      <div className="cell-thumb" style={{ height: height - caption }}>
        <FolderSheet covers={covers} />
      </div>
      {nameBand}
    </div>
  );
});

/**
 * A row draws the sleeve and no pictures — the user's call, 2026-09-25: in a
 * list the name is what is read, and the icon only has to say *folder*.
 */
const NO_COVERS: readonly string[] = [];

/**
 * The sleeve, and what is filed in it.
 *
 * Drawn in markup rather than as an SVG so that the pictures can sit inside it
 * as ordinary `<img>`s: Chromium decodes and caches them exactly as it does a
 * cell's, and an image in an SVG `<image>` would be a second path for that.
 *
 * **The punched strip is what says *folder*.** Without it a grey rectangle with
 * four pictures in it reads as a collage, which is a different thing — a sheet
 * protector is the shape a person already files things in. The holes are the
 * ground showing through, so they are right on either theme.
 *
 * One picture fills the sheet, and two to four make a 2×2: a single picture in
 * a quarter of the sheet looked like three missing ones.
 */
function FolderSheet({ covers }: { readonly covers: readonly string[] }): React.JSX.Element {
  return (
    <div className="folder-sheet" data-covers={covers.length}>
      <div className="folder-sheet-strip" aria-hidden="true">
        <span className="folder-hole" data-long="" />
        <span className="folder-hole" />
        <span className="folder-hole" data-long="" />
        <span className="folder-hole" />
        <span className="folder-hole" />
        <span className="folder-hole" data-long="" />
      </div>
      <div className="folder-sheet-body">
        {covers.map((src) => (
          <img
            key={src}
            className="folder-sheet-image"
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={hideBroken}
          />
        ))}
      </div>
    </div>
  );
}

/** A picture that went away between the cover being named and being drawn. */
function hideBroken(event: React.SyntheticEvent<HTMLImageElement>): void {
  event.currentTarget.hidden = true;
}
