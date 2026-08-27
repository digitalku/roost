import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../bridge.js";

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
        className="search-input"
        // `type="search"` already gives it the searchbox role; spelling the
        // role out as well is redundant, and the tests query by role.
        type="search"
        aria-label="Search"
        aria-invalid={problem !== undefined || undefined}
        placeholder="tag:wood rating:>=4"
        spellCheck={false}
        autoComplete="off"
        value={text}
        onChange={(changed) => setText(changed.target.value)}
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
