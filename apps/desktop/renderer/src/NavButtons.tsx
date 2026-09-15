/**
 * Back, forward and up, at the head of the content column (ADR-0044).
 *
 * A file manager's three arrows, in a file manager's order and a file
 * manager's corner: `☰ ← → ↑ [the search field]`. The field is the address bar
 * (ADR-0035 and `UI_SPEC.md` §4.2 — there is no filter state it does not know
 * about), so these sit in front of it exactly as they do in front of a path.
 *
 * **All three are always drawn and dead when they cannot act**, which is not
 * the rule ADR-0033 §7 follows for *Show the folder on screen*. They are a
 * fixed triad: a button that came and went would move the other two and the
 * field with them, and a control whose position is unstable is worse to aim at
 * than one that is greyed.
 */

export interface NavButtonsProps {
  readonly canBack: boolean;
  readonly canForward: boolean;
  /** Whether a folder is on screen, which is the only thing to go up from. */
  readonly canUp: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onUp: () => void;
}

export function NavButtons({
  canBack,
  canForward,
  canUp,
  onBack,
  onForward,
  onUp,
}: NavButtonsProps): React.JSX.Element {
  return (
    <div className="bar-nav">
      <button
        type="button"
        className="nav-button"
        aria-label="Back"
        title="Back (Alt+←)"
        disabled={!canBack}
        onClick={onBack}
      >
        <Arrow direction="left" />
      </button>
      <button
        type="button"
        className="nav-button"
        aria-label="Forward"
        title="Forward (Alt+→)"
        disabled={!canForward}
        onClick={onForward}
      >
        <Arrow direction="right" />
      </button>
      <button
        type="button"
        className="nav-button"
        aria-label="Up"
        title="Up (Alt+↑)"
        disabled={!canUp}
        onClick={onUp}
      >
        <Arrow direction="up" />
      </button>
    </div>
  );
}

/**
 * The arrows, drawn rather than typed.
 *
 * The sidebar's chevron learned this first: a glyph from the font is a
 * different weight and a different size in every stack, and at this size the
 * difference is between a control and a speck.
 */
function Arrow({ direction }: { readonly direction: "left" | "right" | "up" }): React.JSX.Element {
  return (
    <svg
      className="nav-arrow"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      data-direction={direction}
    >
      <path
        d="M9.5 3.5 5 8l4.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
