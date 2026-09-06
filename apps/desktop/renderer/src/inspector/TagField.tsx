import { useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * One tag the library already has.
 *
 * A structural subset of `SidebarRow`, so the window hands over the tag rows it
 * already holds for the navigation pane and nothing maps between two shapes.
 * The count is what a suggestion is ordered by, and the group is drawn beside
 * the name — groups **arrange** tags rather than nesting them, so a group is a
 * label here and never part of what gets typed.
 */
export interface TagChoice {
  readonly name: string;
  readonly group: string | null;
  readonly count: number | null;
}

/** How many suggestions are offered at once. */
export const MAX_SUGGESTIONS = 8;

/**
 * The tags worth offering for what has been typed, best first.
 *
 * **Names that begin with the typed text come before names that merely contain
 * it**, and within each half the most used tag comes first. Tag names are flat
 * and globally unique here, so a match in the middle is the only way `raga`
 * finds `olahraga` — and it stays below the prefixes, where it cannot push the
 * tag somebody is plainly typing off the top of the list.
 *
 * Tags the selection already carries are left out: offering one would be
 * offering a no-op, and the chip for it is on screen a few pixels above.
 */
export function rankTags(
  vocabulary: readonly TagChoice[],
  draft: string,
  attached: readonly string[],
): TagChoice[] {
  const typed = draft.trim().toLowerCase();
  if (typed === "") return [];

  const taken = new Set(attached.map((tag) => tag.toLowerCase()));
  const beginning: TagChoice[] = [];
  const inside: TagChoice[] = [];
  for (const choice of vocabulary) {
    const name = choice.name.toLowerCase();
    if (taken.has(name)) continue;
    const at = name.indexOf(typed);
    if (at === 0) beginning.push(choice);
    else if (at > 0) inside.push(choice);
  }

  const byUse = (a: TagChoice, b: TagChoice): number =>
    (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name);
  beginning.sort(byUse);
  inside.sort(byUse);
  return [...beginning, ...inside].slice(0, MAX_SUGGESTIONS);
}

/**
 * The field that adds a tag, with the library's own vocabulary under it.
 *
 * **Nothing is highlighted until an arrow key highlights it.** Enter therefore
 * adds exactly what was typed unless somebody has chosen a suggestion, which is
 * what keeps a new tag possible while an old one is being offered: `oke` must
 * still be `oke` when `okelah` is on screen under it.
 *
 * **The list is drawn in the flow of the panel rather than floating over it.**
 * The inspector is a scroll container (`overflow-y: auto`), so an absolutely
 * positioned list would be clipped by it exactly when the field has been
 * scrolled near the bottom — the case a dropdown exists for — and escaping the
 * clip means a portal that re-measures the field on every scroll of a panel
 * whose whole job is to scroll. In flow, nothing can be cut off; what it costs
 * is the note moving down for as long as the list is open.
 *
 * The vocabulary arrives from `library:sidebar`, which already carries every
 * tag with its live count. There is no request behind this component and no
 * work in the engine: a tag added here bumps the window's revision, the sidebar
 * is re-read, and the new tag is in the next suggestion.
 */
export function TagField({
  vocabulary,
  attached,
  onAdd,
}: {
  readonly vocabulary: readonly TagChoice[];
  /** Tags already on the selection — shared and partial alike. */
  readonly attached: readonly string[];
  readonly onAdd: (tag: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [active, setActive] = useState<number | null>(null);
  // Escape closes the list without clearing the field, and a second Escape is
  // the window's to handle. It reopens on the next keystroke, not before.
  const [dismissed, setDismissed] = useState(false);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);

  const matches = useMemo(
    () => rankTags(vocabulary, draft, attached),
    [vocabulary, draft, attached],
  );
  const open = matches.length > 0 && !dismissed;

  useEffect(() => {
    if (active === null) return;
    const option = list.current?.children[active];
    // jsdom computes no layout and does not implement this; a real window does.
    if (option instanceof HTMLElement && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  }, [active]);

  const commit = (tag: string): void => {
    if (tag.trim() === "") return;
    setDraft("");
    setActive(null);
    setDismissed(false);
    onAdd(tag);
  };

  return (
    <div className="tag-field">
      <input
        className="tag-input"
        aria-label="Add a tag"
        placeholder="Add a tag"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active !== null ? `${listId}-${active}` : undefined}
        value={draft}
        onChange={(changed) => {
          setDraft(changed.target.value);
          setActive(null);
          setDismissed(false);
        }}
        // A click away is a change of mind about the list, not about the text.
        onBlur={() => setDismissed(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (!open) return;
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((was) => {
              if (was === null) return step === 1 ? 0 : matches.length - 1;
              return (was + step + matches.length) % matches.length;
            });
            return;
          }
          if (event.key === "Escape") {
            // Only while there is a list to close: otherwise this is the
            // window's Escape and the panel must not swallow it.
            if (!open) return;
            event.preventDefault();
            event.stopPropagation();
            setActive(null);
            setDismissed(true);
            return;
          }
          if (event.key !== "Enter") return;
          const picked = active === null ? draft : (matches[active]?.name ?? draft);
          if (picked.trim() === "") return;
          event.preventDefault();
          commit(picked);
        }}
      />
      {open && (
        <div
          className="tag-suggestions"
          id={listId}
          role="listbox"
          aria-label="Matching tags"
          ref={list}
        >
          {matches.map((match, index) => (
            /* The keyboard drives this list from the input, which is what
               `aria-activedescendant` is for: an option that took the focus
               would take it off the field being typed into. */
            // biome-ignore lint/a11y/useKeyWithClickEvents: the input carries the keyboard, per the comment above
            <div
              key={match.name}
              id={`${listId}-${index}`}
              className="tag-suggestion"
              role="option"
              // Reachable to a pointer and to `scrollIntoView`, never to Tab:
              // the field keeps the focus for the whole of this interaction.
              tabIndex={-1}
              aria-selected={index === active}
              data-active={index === active ? "" : undefined}
              // Before the blur, so the field keeps the focus and the list is
              // still mounted when the click lands on it.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(match.name)}
            >
              <span className="tag-suggestion-name">{match.name}</span>
              {match.group !== null && <span className="tag-suggestion-group">{match.group}</span>}
              {match.count !== null && <span className="tag-suggestion-count">{match.count}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
