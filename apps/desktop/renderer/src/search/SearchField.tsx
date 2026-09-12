import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "../bridge.js";
import { counted } from "../format.js";
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
 * **Nothing moves the caret.** A click lands where the pointer landed, as it
 * does in any text field; the field neither selects the query nor runs to its
 * end, at the user's word on 2026-09-08. At rest, with nobody typing in it, the
 * view is pinned back to the head: `…/post/testing"` names nothing, and
 * `folder:"SMA NUSANTARA…` is the half that says which place is being asked
 * about.
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
    async (draft: string) => {
      // A trailing space is a separator somebody typed, not a term: `App.tsx`
      // recognises the folder on screen by comparing the running query against
      // the sidebar's rows, and one that ends in a space matches nothing.
      const candidate = draft.trimEnd();
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
    // yet; the scroll would then act on the wrong string.
    if (input === null || input.value !== text) return;
    if (document.activeElement === input) return;
    input.scrollLeft = 0;
  }, [text]);

  /**
   * `Ctrl+F` and `/` (`UI_SPEC.md` §9).
   *
   * Here rather than in `App.tsx` because what it does is take *this* field's
   * focus, and the field owns its own input. `/` is a character somebody may be
   * typing into a tag name, so it is refused while a field has the focus;
   * `Ctrl+F` is not a character and works from anywhere. Neither moves the
   * caret: taking the focus is the whole of what they do.
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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Applied on an idle rather than on every keystroke: every character would be
  // a round trip, and a query is not finished until the typing stops.
  useEffect(() => {
    // A space typed after a finished query asks the engine nothing new.
    if (text.trimEnd() === query) return;
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
            {counted(matches)} {matches === 1 ? "match" : "matches"}
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
