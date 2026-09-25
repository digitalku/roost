import { memo } from "react";
import { badgeOf, explainFailure } from "./deriveReason.js";

/**
 * What stands where a picture would be, before one arrives or when none can
 * (`UI_SPEC.md` §6.1).
 *
 * It used to be the extension on a grey square, whatever the reason, and a
 * HEIC waiting on a decoder looked exactly like one still in the queue and
 * exactly like a `.zip` that will never have a picture. Reported on 2026-09-24
 * as *"tidak sekedar blank gitu saja"*. So it says three things now: what kind
 * of file it is, in a shape that reads at a glance; the extension, as before;
 * and — only when the queue has given up on it for a reason somebody can act
 * on — a few words saying what, with the whole sentence as a tooltip.
 *
 * It is drawn **underneath** the thumbnail, which covers it when there is one.
 * So an asset whose re-derive failed keeps showing the picture it had, and the
 * badge under it is never seen — which is right: there is still a picture.
 *
 * Primitives only, for the grid's reason (`UI_SPEC.md` §6).
 */
export const Placeholder = memo(function Placeholder({
  kind,
  ext,
  undrawn,
}: {
  /** An `AssetKind`, kept a string so the cell's props stay primitive. */
  readonly kind: string;
  readonly ext: string;
  readonly undrawn: string | null;
}): React.JSX.Element {
  const badge = undrawn === null ? undefined : badgeOf(undrawn);
  return (
    <div className="placeholder" data-badge={badge === undefined ? undefined : ""}>
      <KindGlyph kind={kind} />
      <span className="cell-kind">{ext === "" ? "file" : ext}</span>
      {badge !== undefined && undrawn !== null && (
        <span className="placeholder-badge" title={explainFailure(undrawn).line}>
          <WarningGlyph />
          {badge}
        </span>
      )}
    </div>
  );
});

/**
 * One outline per kind, drawn inline.
 *
 * Inline rather than an icon package, for invariant 7's reason and the
 * transport's: six shapes are not a dependency. Hidden from the accessible
 * tree, because the extension beside it already says the same thing in words.
 */
export function KindGlyph({ kind }: { readonly kind: string }): React.JSX.Element {
  return (
    <svg
      className="placeholder-glyph"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {GLYPHS[kind] ?? GLYPHS["other"]}
    </svg>
  );
}

const GLYPHS: Readonly<Record<string, React.JSX.Element>> = {
  image: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m21 15.5-4.5-4.5L7 19.5" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M10 9.2v5.6l4.6-2.8z" />
    </>
  ),
  audio: (
    <>
      <path d="M9 17.5V6l10-2v11.5" />
      <circle cx="6.5" cy="17.5" r="2.5" />
      <circle cx="16.5" cy="15.5" r="2.5" />
    </>
  ),
  document: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
  font: <path d="m5 19 6.5-15h1L19 19M7.8 14h8.4" />,
  other: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
};

function WarningGlyph(): React.JSX.Element {
  return (
    <svg
      className="placeholder-badge-glyph"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M8 1.5 15 14H1zM7.25 6v4h1.5V6zm0 5.25v1.5h1.5v-1.5z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}
