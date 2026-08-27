import { memo } from "react";

/**
 * One cell. Memo'd, and given nothing but primitives.
 *
 * `UI_SPEC.md` §6 makes this non-negotiable, and the reason is arithmetic: at
 * four hundred cells on screen, one freshly-allocated object prop per cell is
 * four hundred re-renders per selection change. There are no callbacks here
 * either — the grid listens once, on the container, and reads the hash back off
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
export function cellId(hash: string): string {
  return `cell-${hash}`;
}

export interface AssetCellProps {
  readonly hash: string;
  readonly name: string;
  readonly ext: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly caption: number;
  readonly isSelected: boolean;
  readonly isFocused: boolean;
}

export const AssetCell = memo(function AssetCell({
  hash,
  name,
  ext,
  x,
  y,
  width,
  height,
  caption,
  isSelected,
  isFocused,
}: AssetCellProps): React.JSX.Element {
  return (
    /*
     * An option in a listbox is deliberately not focusable. The grid is one tab
     * stop with a roving ring pointed by `aria-activedescendant` (`UI_SPEC.md`
     * §6); a tabindex per cell would put four hundred tab stops between the
     * grid and whatever follows it.
     */
    // biome-ignore lint/a11y/useFocusableInteractive: see above
    <div
      id={cellId(hash)}
      className="cell"
      data-hash={hash}
      data-selected={isSelected || undefined}
      data-focused={isFocused || undefined}
      role="option"
      aria-selected={isSelected}
      aria-label={name}
      style={{ transform: `translate(${x}px, ${y}px)`, width, height }}
    >
      <div className="cell-thumb" style={{ height: height - caption }}>
        {/*
          The placeholder is a first-class cell, not a broken one: a library
          holds anything (`CONCEPT.md` §5), so a `.zip` shows its extension
          rather than a broken-image glyph. It is drawn underneath and the
          image covers it, so a failed load needs no state — the `<img>` simply
          renders nothing and what was already there shows through.
        */}
        <span className="cell-kind">{ext === "" ? "file" : ext}</span>
        <img
          className="cell-image"
          src={`roost://thumb/${hash}@256`}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      </div>
      <span className="cell-name" title={name}>
        {name}
      </span>
    </div>
  );
});
