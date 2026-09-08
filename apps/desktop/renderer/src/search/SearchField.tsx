import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "../bridge.js";
import { isTyping } from "../keyboard.js";

/**
 * The RQL field (`UI_SPEC.md` §5).
 *
 * **It validates before it applies.** A half-typed query leaves the grid alone
 * and the parse error appears under the field with a caret at the position the
 * parser reported — not a red border, not a toast, and not an empty grid that
 * looks like a library with nothing in it.
 *
 * The renderer cannot parse RQL: the grammar lives in `@roost/search` and the
 * renderer's only import is the contract. So the check is a request, made on a
 * 250ms idle or immediately on Enter, and the grid sees only queries the engine
 * has already agreed to.
 *
 * **It rests showing the head of the query, not the tail.** A field scrolled to
 * wherever the caret last was shows `…/post/testing"` of a folder path, which
 * is the half that names nothing; the half that says which place is being asked
 * about is off the left edge. So the scroll is pinned to 0 whenever nobody is
 * typing in it, and taking the focus selects the query with the view at its
 * head.
 */

/** How long the typing has to stop before the query is checked. */
export const IDLE_MS = 250;

export interface SearchFieldProps {
  /** The query on screen. Changes when a sidebar row is clicked, too. */
  readonly query: string;
  readonly onApply: (query: string) => void;
  /** Matches for the applied query, or `undefined` while it is being counted. */
  readonly matches: number | undefined;
}

export function SearchField({ query, onApply, matches }: SearchFieldProps): React.JSX.Element {
  const [text, setText] = useState(query);
  const [problem, setProblem] = useState<{ message: string; at: number | null } | undefined>();
  const field = useRef<HTMLInputElement>(null);

  /**
   * Selects the whole query with the view pinned to its head.
   *
   * `"backward"` puts the selection's *focus* end at offset 0, and a browser
   * scrolls to the focus end — so the field shows `folder:"SMA NUSANTARA…`
   * rather than the tail it happened to be scrolled to. Selecting rather than
   * only scrolling is the address bar's own idiom: arriving somewhere by
   * clicking a sidebar row and then typing means replacing the query, and a
   * caret dropped at offset 0 would mean prefixing it.
   *
   * **On the focus event, and on nothing else.** The gesture is the address
   * bar's: the click that *arrives* selects, and a second one puts the caret
   * where it landed — a click carries a position, and overriding it every time
   * would fight anyone editing one term of a query. Chromium leaves a selection
   * made here alone for the rest of the click, which is a browser's decision
   * rather than a promise of the DOM, so `scripts/check-filters.mjs` is what
   * holds it: jsdom has no default action to override anything with.
   */
  const selectAll = useCallback(() => {
    const input = field.current;
    if (input === null || input.value === "") return;
    input.setSelectionRange(0, input.value.length, "backward");
  }, []);

  // A sidebar click replaces the query, and the field shows what is actually
  // being asked (`UI_SPEC.md` §4.1) — so it follows the applied query rather
  // than holding whatever was last typed.
  useEffect(() => {
    setText(query);
    setProblem(undefined);
  }, [query]);

  /**
   * Which check a reply belongs to.
   *
   * Replies can overtake each other: a check for `tag:woo` sent before one for
   * `tag:wood` may land after it, and applying the older answer would show an
   * error for text nobody can see any more.
   */
  const attempt = useRef(0);

  const apply = useCallback(
    async (candidate: string) => {
      attempt.current += 1;
      const mine = attempt.current;
      const checked = await invoke({ type: "query:check", query: candidate });
      if (mine !== attempt.current) return;

      if (!checked.ok) {
        // The engine refused the request itself — no library open, most likely.
        // Not a parse error, and not something a caret explains.
        setProblem({ message: checked.problem.message, at: null });
        return;
      }
      if (!checked.value.ok) {
        setProblem({ message: checked.value.message ?? "Not a valid query", at: checked.value.at });
        return;
      }
      setProblem(undefined);
      onApply(candidate);
    },
    [onApply],
  );

  // The head of the query is what names what is being asked, so it is what the
  // field shows while nobody is typing in it — the state it spends its life in,
  // since a sidebar click writes the query and then nothing touches it. A
  // layout effect rather than the change handler: the scroll belongs to the DOM
  // node and only exists once React has written the new value into it.
  useLayoutEffect(() => {
    const input = field.current;
    // `input.value !== text` is React not having written this render's value in
    // yet; scrolling a node still holding the previous query would put the
    // wrong string's head on screen.
    if (input === null || input.value !== text || document.activeElement === input) return;
    input.scrollLeft = 0;
  }, [text]);

  /**
   * `Ctrl+F` and `/` (`UI_SPEC.md` §9).
   *
   * Here rather than in `App.tsx` because what it does is take *this* field's
   * caret, and the field owns its own input. `/` is a character somebody may be
   * typing into a tag name, so it is refused while a field has the focus;
   * `Ctrl+F` is not a character and works from anywhere, including from inside
   * this field, where it selects the query rather than doing nothing.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.altKey) return;
      const chord = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f";
      const slash = !event.ctrlKey && !event.metaKey && event.key === "/";
      if (!chord && !slash) return;
      const target = event.target;
      if (slash && target instanceof HTMLElement && isTyping(target)) return;
      event.preventDefault();
      field.current?.focus();
      selectAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectAll]);

  // Applied on an idle rather than on every keystroke: every character would be
  // a round trip, and a query is not finished until the typing stops.
  useEffect(() => {
    if (text === query) return;
    const timer = setTimeout(() => void apply(text), IDLE_MS);
    return () => clearTimeout(timer);
  }, [text, query, apply]);

  return (
    <div className="search">
      <input
        ref={field}
        className="search-input"
        // `type="search"` already gives it the searchbox role; spelling the
        // role out as well is redundant, and the tests query by role.
        type="search"
        aria-label="Search"
        aria-invalid={problem !== undefined || undefined}
        placeholder="Search names, notes, and comments"
        spellCheck={false}
        autoComplete="off"
        value={text}
        onChange={(changed) => setText(changed.target.value)}
        onFocus={selectAll}
        onBlur={() => {
          if (field.current !== null) field.current.scrollLeft = 0;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void apply(text);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setText(query);
            setProblem(undefined);
          }
        }}
      />
      {problem === undefined ? (
        matches !== undefined && (
          <output className="search-matches">
            {matches.toLocaleString()} {matches === 1 ? "match" : "matches"}
          </output>
        )
      ) : (
        <ParseError message={problem.message} at={problem.at} text={text} />
      )}
    </div>
  );
}

/**
 * The message, under the field, with a caret where the parser stopped.
 *
 * The caret is drawn from the text itself rather than from a measured pixel
 * offset: the field is in the monospace stack for exactly this reason, so a run
 * of spaces the same length as the prefix lands under the right character
 * without measuring anything.
 */
function ParseError({
  message,
  at,
  text,
}: {
  readonly message: string;
  readonly at: number | null;
  readonly text: string;
}): React.JSX.Element {
  return (
    <div className="search-error" role="alert">
      {at !== null && (
        <pre className="search-caret" aria-hidden="true">
          {/* Every character before the caret becomes a space, so a wide
              character still occupies its own width. */}
          {`${text.slice(0, at).replace(/\S/g, " ")}^`}
        </pre>
      )}
      <span className="search-message">{message}</span>
    </div>
  );
}
