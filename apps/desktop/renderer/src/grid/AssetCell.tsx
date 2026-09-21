import { memo } from "react";
import { bytes } from "../format.js";
import { gridSrc } from "../thumbnail.js";
import type { GridView } from "./layout.js";

/**
 * One cell. Memo'd, and given nothing but primitives.
 *
 * `UI_SPEC.md` §6 makes this non-negotiable, and the reason is arithmetic: at
 * four hundred cells on screen, one freshly-allocated object prop per cell is
 * four hundred re-renders per selection change. There are no callbacks here
 * either — the grid listens once, on the container, and reads the id back off
 * the DOM. One listener, not four hundred closures.
 *
 * The thumbnail is an `<img>` pointed at `roost://`, so its bytes never pass
 * through React state and Chromium owns the decode, the cache, and the
 * eviction (ADR-0008).
 */
/**
 * The DOM id of a cell, so the listbox can point at the focused one.
 *
 * `aria-activedescendant` is how the ARIA listbox pattern expresses a roving
 * focus ring: the container is the one tab stop and the options are never
 * focusable themselves, which is what `UI_SPEC.md` §6 asks for. Declared beside
 * the element that carries it, so the two spellings cannot drift.
 */
export function cellId(id: string): string {
  return `cell-${id}`;
}

/**
 * Hides an image that could not be loaded.
 *
 * A cell whose asset has no thumbnail — a zip, a BMP, anything still in the
 * derive queue — asks for one and gets a 404, and Chromium draws its own broken
 * icon on top of the placeholder underneath. Seen in a real window: the `<img>`
 * does *not* "simply render nothing", which is what this file used to claim.
 *
 * Declared at module scope, not inline: a fresh closure per cell is exactly what
 * `UI_SPEC.md` §6 forbids, and this one is the same function for every cell.
 */
function hideBroken(event: React.SyntheticEvent<HTMLImageElement>): void {
  event.currentTarget.hidden = true;
}

/**
 * And shows it again when one arrives.
 *
 * A cell is keyed on its id, so today the hiding above cannot outlive the
 * asset it was for. That is a property of the grid rather than of this file,
 * and the panel that lacked it drew nothing at all for an hour on 2026-09-05
 * (`thumbnail.ts`). Pairing the two here costs a stable function reference.
 */
function showLoaded(event: React.SyntheticEvent<HTMLImageElement>): void {
  event.currentTarget.hidden = false;
}

export interface AssetCellProps {
  readonly id: string;
  readonly name: string;
  readonly ext: string;
  /** Part of the thumbnail's address, not something the cell draws. */
  readonly posterMs: number | null;
  /**
   * Also part of the address, and the reason an edited file redraws.
   *
   * A number, so it costs the memo nothing: a cell whose asset was re-derived
   * gets a new `src` and every other cell compares equal and does not render
   * (`CLAUDE.md` §8).
   */
  readonly derivedAt: number | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly caption: number;
  readonly isSelected: boolean;
  readonly isFocused: boolean;
  readonly view: GridView;
  /*
   * The four below are only drawn by the details view, and are passed in every
   * view anyway. They are primitives, so they cost nothing to pass and nothing
   * to compare — and formatting them *here*, inside the memo, is what keeps a
   * selection change from re-formatting two hundred dates.
   */
  readonly size: number;
  readonly assetWidth: number | null;
  readonly assetHeight: number | null;
  readonly importedAt: number;
}

export const AssetCell = memo(function AssetCell({
  id,
  posterMs,
  derivedAt,
  name,
  ext,
  x,
  y,
  width,
  height,
  caption,
  isSelected,
  isFocused,
  view,
  size,
  assetWidth,
  assetHeight,
  importedAt,
}: AssetCellProps): React.JSX.Element {
  const kind = ext === "" ? "file" : ext;

  if (view !== "icons") {
    return (
      // biome-ignore lint/a11y/useFocusableInteractive: one tab stop; see below
      <div
        id={cellId(id)}
        className="cell"
        data-id={id}
        data-view={view}
        data-selected={isSelected || undefined}
        data-focused={isFocused || undefined}
        role="option"
        aria-selected={isSelected}
        aria-label={name}
        // A primitive, not a handler: the grid listens once for `dragstart` on
        // its container and reads the id back off the DOM, the way it does
        // for every other gesture (`UI_SPEC.md` §6).
        draggable
        style={{ transform: `translate(${x}px, ${y}px)`, width, height }}
      >
        <div className="cell-thumb">
          <span className="cell-kind">{kind}</span>
          <img
            className="cell-image"
            src={gridSrc(id, posterMs, derivedAt)}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={showLoaded}
            onError={hideBroken}
          />
        </div>
        <span className="cell-name" title={name}>
          {name}
        </span>
        {view === "details" && (
          <>
            <span className="cell-field">{kind.toUpperCase()}</span>
            <span className="cell-field">{bytes(size)}</span>
            <span className="cell-field">
              {assetWidth === null || assetHeight === null ? "" : `${assetWidth} × ${assetHeight}`}
            </span>
            <span className="cell-field">{day(importedAt)}</span>
          </>
        )}
      </div>
    );
  }

  return (
    /*
     * An option in a listbox is deliberately not focusable. The grid is one tab
     * stop with a roving ring pointed by `aria-activedescendant` (`UI_SPEC.md`
     * §6); a tabindex per cell would put four hundred tab stops between the
     * grid and whatever follows it.
     */
    // biome-ignore lint/a11y/useFocusableInteractive: see above
    <div
      id={cellId(id)}
      className="cell"
      data-id={id}
      data-selected={isSelected || undefined}
      data-focused={isFocused || undefined}
      role="option"
      aria-selected={isSelected}
      aria-label={name}
      data-view="icons"
      draggable
      style={{ transform: `translate(${x}px, ${y}px)`, width, height }}
    >
      <div className="cell-thumb" style={{ height: height - caption }}>
        {/*
          The placeholder is a first-class cell, not a broken one: a library
          holds anything (`CONCEPT.md` §5), so a `.zip` shows its extension
          rather than a broken-image glyph. It is drawn underneath and the image
          covers it — and the image hides itself when it fails, because Chromium
          draws a broken icon otherwise.
        */}
        <span className="cell-kind">{kind}</span>
        <img
          className="cell-image"
          src={gridSrc(id, posterMs, derivedAt)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={showLoaded}
          onError={hideBroken}
        />
      </div>
      <span className="cell-name" title={name}>
        {name}
      </span>
    </div>
  );
});

/** The date alone: a details row has no room for a clock, and rarely a use. */
function day(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString();
}
