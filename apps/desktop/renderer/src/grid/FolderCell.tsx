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
 * There is no `<img>` here and no `roost://` address. A folder has no
 * thumbnail — the cover mosaic ADR-0043 §7 leaves for later is where that would
 * arrive — so the glyph is the whole picture.
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
}

export const FolderCell = forwardRef<HTMLDivElement, FolderCellProps>(function FolderCell(
  { id, name, count, x, y, width, height, caption, isFocused, view, ...rest },
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
          <FolderGlyph />
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
        <FolderGlyph />
      </div>
      {nameBand}
    </div>
  );
});

/**
 * The folder itself, drawn rather than typed.
 *
 * The same reasoning as the sidebar's chevron: a glyph from the font is a
 * different weight and a different size in every stack, and this one has to
 * read at 40px in a Details row and at a few hundred in Icons.
 *
 * **Two tones, not a silhouette.** One filled shape is a blob at the small end
 * and a slab of colour at the large one — both reported from a real window on
 * 2026-09-13, in that order. The sheet in front of the tab is what says
 * *folder* rather than *rectangle*, and it costs one more path.
 *
 * The `viewBox` is the drawing's own box: an icon grid reserves a margin inside
 * itself, and a cell that then centres the element adds a second one, which is
 * how the first build drew a speck in the middle of a lot of nothing.
 */
function FolderGlyph(): React.JSX.Element {
  return (
    <svg className="cell-folder-glyph" viewBox="0 0 24 19" aria-hidden="true" focusable="false">
      <path
        className="folder-back"
        d="M3 1h6.17a2 2 0 0 1 1.41.59L12.41 3H21a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z"
      />
      <path
        className="folder-front"
        d="M3 6.5h18a2 2 0 0 1 2 2V16a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2z"
      />
    </svg>
  );
}
