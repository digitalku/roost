import type { SidebarFolderRow } from "@roost/contract";
import { DropdownMenu } from "radix-ui";
import { useMemo, useRef, useState } from "react";
import { found } from "../folders.js";

/** Steps of indentation drawn; past this a row would be all indent. */
const MAX_INDENT = 8;

/**
 * Past this many folders, the menu is searched rather than read.
 *
 * The filter bar's rule (ADR-0035 §7.3), not the sidebar's magnifier (ADR-0033
 * §6): a menu is only on screen while it is being used, so a row spent on a
 * field costs nothing when it is not, and the pane's reason for hiding the
 * field behind a button does not apply here.
 */
const SEARCHABLE_FROM = 8;

/**
 * The control that puts the selection in a folder (`UI_SPEC.md` §3.9).
 *
 * **A menu, not a field.** The tag field beside it takes typing because a tag
 * that does not exist yet is made by typing it; a folder is not. Nothing in the
 * window creates one — folders come from the sidebar and the CLI — so a text
 * field here would offer a gesture that can only fail, and the whole vocabulary
 * is a tree small enough to show at once.
 *
 * **The tree is drawn as a tree**, indented by the same depth the sidebar uses,
 * because the paths repeat: three folders called `Icons` are three rows reading
 * `Icons`, and the indentation is what tells them apart at a glance. The full
 * path is on each row's `title` for the case where it does not.
 *
 * **The list scrolls rather than growing** (`.folder-menu` in `inspector.css`).
 * A menu taller than the window is one whose first rows are off the top of the
 * screen, which is what a library with twenty folders showed on 2026-09-09.
 *
 * A folder the selection is already in is **disabled rather than absent**: an
 * item that vanishes as it is used moves the next one under the pointer, and a
 * tree that changes shape between two openings is one nobody learns.
 */
export function FolderField({
  tree,
  attached,
  onAdd,
}: {
  /** Every folder in the library, in the order the sidebar draws them. */
  readonly tree: readonly SidebarFolderRow[];
  /** Folder ids the selection is already in — shared and partial alike. */
  readonly attached: readonly number[];
  readonly onAdd: (folder: number) => void;
}): React.JSX.Element {
  const held = new Set(attached);
  const [needle, setNeedle] = useState("");
  const searchable = tree.length > SEARCHABLE_FROM;
  const wanted = searchable ? needle.trim() : "";
  /*
   * The pane's rule, from the one function both use: a match where it sits,
   * its ancestors along as context, a match's own subtree left out. Context
   * rows are drawn like any other, because every row here is a folder that can
   * be filed into — the sidebar dims them for navigation, and this menu is not
   * navigating.
   */
  const rows = useMemo(
    () => (wanted === "" ? tree : found(tree, wanted).map((drawn) => drawn.row)),
    [tree, wanted],
  );

  const field = useRef<HTMLInputElement>(null);
  /**
   * Whether the next focus of the content is the one the menu opens with, the
   * only one handed to the field: the menu also focuses its content whenever
   * the pointer leaves an item, and handing that on scrolled a long list back
   * to its head under the pointer (2026-10-24, found in the filter bar).
   */
  const opening = useRef(false);

  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        opening.current = open;
        if (open) setNeedle("");
      }}
    >
      <DropdownMenu.Trigger asChild>
        {/*
          Disabled with an empty tree rather than hidden. A library with no
          folders yet is the state somebody most wants told about — the button
          is where the question "how do I file this?" gets asked, and a control
          that is not there answers nothing.
        */}
        <button
          type="button"
          className="folder-trigger"
          disabled={tree.length === 0}
          title={tree.length === 0 ? "This library has no folders yet" : undefined}
        >
          <span aria-hidden="true">+</span>
          <span>Add to folder</span>
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="menu folder-menu"
          sideOffset={4}
          align="start"
          collisionPadding={8}
          /*
           * The caret belongs in the field the moment the menu opens, or the
           * first letter typed jumps to a folder instead of searching for one.
           *
           * Handed on rather than raced for: a `radix-ui` menu focuses its own
           * content when it opens, and asking for the caret a frame later loses
           * in a real window — found by driving one on 2026-09-09, where the
           * field was drawn, the letters went to the menu's own typeahead, and
           * every component test passed. So the content's own focus is what
           * moves it, whenever that lands. Only the content's: a focus that
           * reaches an item is somebody walking the list with the arrows. And
           * only the first: see `opening`.
           */
          onFocus={(event) => {
            if (event.target !== event.currentTarget || !opening.current) return;
            opening.current = false;
            field.current?.focus({ preventScroll: true });
          }}
        >
          {searchable && (
            <div className="menu-search">
              <input
                ref={field}
                type="search"
                className="menu-search-input"
                aria-label="Search folders"
                placeholder="Search folders"
                spellCheck={false}
                value={needle}
                onChange={(changed) => setNeedle(changed.target.value)}
                // A `radix-ui` menu binds printable keys to jump between its
                // items, so `p` would highlight `post` rather than reach the
                // field. Only those are taken: the arrows, `Escape` and `Tab`
                // are the menu's and go on working.
                onKeyDown={(event) => {
                  if (event.key.length === 1) event.stopPropagation();
                }}
              />
            </div>
          )}

          {/* The wording is the filter menu's and the pane's, because it is the
              same sentence about the same gesture. */}
          {rows.length === 0 ? (
            <div className="menu-item" data-disabled="">
              <span className="menu-mark" />
              <span className="menu-label">Nothing matches</span>
            </div>
          ) : (
            rows.map((folder) => (
              <DropdownMenu.Item
                key={folder.id}
                className="menu-item folder-item"
                // The indent is in CSS, capped there like the sidebar's: a
                // `var(--token)` written into a style attribute is invisible to
                // `check:css`, which is the one thing that can see a typo in one.
                data-depth={folder.depth === 0 ? undefined : Math.min(folder.depth, MAX_INDENT)}
                disabled={held.has(folder.folder)}
                title={folder.path}
                onSelect={() => onAdd(folder.folder)}
              >
                <span className="menu-mark" />
                <span className="menu-label">{folder.name}</span>
              </DropdownMenu.Item>
            ))
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
