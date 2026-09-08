import { COPYRIGHT, HOMEPAGE, HOMEPAGE_URL, SUPPORT_EMAIL } from "./brand.js";
import { invoke } from "./bridge.js";

/**
 * One line under the picker (`UI_SPEC.md` §3.12, ADR-0038 §5.2).
 *
 * The picker is the only screen a first run has, and the `☰` that holds
 * **About Roost…** is drawn beside a library's name — so without this there is
 * a state of the application in which the support address cannot be reached at
 * all, and it is the state somebody is in when a library will not open.
 *
 * Quiet on purpose: it sits under the recent list at the type scale of the
 * status bar. A credit that competes with **Open library…** is an advert.
 */
export function Credit(): React.JSX.Element {
  return (
    <p className="credit">
      <span>{COPYRIGHT}</span>
      <button
        type="button"
        className="link"
        onClick={() => void invoke({ type: "link:open", url: HOMEPAGE_URL })}
      >
        {HOMEPAGE}
      </button>
      {/* Text, not a `mailto:` — see `brand.ts`. */}
      <span className="about-email">{SUPPORT_EMAIL}</span>
    </p>
  );
}
