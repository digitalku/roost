import type { SidebarFolderRow, SidebarRow, WireSidebar } from "@roost/contract";
import { ContextMenu } from "radix-ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  carriesAssets,
  carriesFolder,
  draggedAssets,
  draggedFolder,
  FOLDER_DRAG_TYPE,
} from "../dnd.js";
import { type DrawnRow, found } from "../folders.js";
import { counted } from "../format.js";
import type { Expansion } from "./expansion.js";

/**
 * The navigation pane (`UI_SPEC.md` §4.1).
 *
 * It assembles no queries. Every row arrives carrying the RQL that selects it,
 * built in `@roost/library` where `quoteValue` lives — a renderer concatenating
 * `tag:Some Name` would be a second, worse implementation of the grammar, and
 * the one that got the quoting wrong. Clicking a row hands its query to the
 * caller, which is why the search field can always show what is being asked.
 *
 * Counts are the engine's too. `UI_SPEC.md` §4.1: the renderer never counts
 * anything it did not receive.
 *
 * **Rating and tags are not here** (ADR-0035). They moved to the filter bar
 * over the grid on 2026-09-07, and the reason both should not exist is what a
 * row does: a row here **replaces** the query, a facet up there **narrows** it.
 * Two controls over one vocabulary would disagree about that before they
 * disagreed about anything else. What is left is the three sections that answer
 * *where am I looking*.
 */

export interface SidebarProps {
  readonly sidebar: WireSidebar;
  /** The query currently on screen, so the matching row can be marked. */
  readonly query: string;
  readonly onPick: (query: string) => void;
  /** Which folder branches are open, and how to open one (§4.1). */
  readonly expansion: Expansion;
  /**
   * The three folder commands (ADR-0033). `null` means the top level.
   *
   * The pane raises them and owns none of them: each opens a dialog, and the
   * window owns the one dialog it has at a time.
   */
  readonly onNewFolder: (parent: SidebarFolderRow | null) => void;
  readonly onRenameFolder: (folder: SidebarFolderRow) => void;
  readonly onDeleteFolder: (folder: SidebarFolderRow) => void;
  /**
   * Assets were dropped on a folder (`UI_SPEC.md` §4.3).
   *
   * `copy` is the answer to "was `Ctrl` held" and nothing more — whether this
   * is a move at all depends on what is on screen, which the window knows and
   * the pane does not.
   */
  readonly onDropAssets: (
    folder: SidebarFolderRow,
    hashes: readonly string[],
    copy: boolean,
  ) => void;
  /** A folder was dropped on another, or on the heading. `null` is the top level. */
  readonly onMoveFolder: (folder: number, parent: number | null) => void;
  /**
   * The Trash row's one command (ADR-0022).
   *
   * Raised like the folder commands and owned like them: it confirms, and the
   * window owns the one dialog it has at a time.
   */
  readonly onEmptyTrash: () => void;
}

export function Sidebar({
  sidebar,
  query,
  onPick,
  expansion,
  onNewFolder,
  onRenameFolder,
  onDeleteFolder,
  onDropAssets,
  onMoveFolder,
  onEmptyTrash,
}: SidebarProps): React.JSX.Element {
  return (
    <nav className="sidebar" aria-label="Library">
      <Section
        title="Places"
        rows={sidebar.places}
        query={query}
        onPick={onPick}
        onEmptyTrash={onEmptyTrash}
      />
      <Folders
        rows={sidebar.folders}
        query={query}
        onPick={onPick}
        expansion={expansion}
        onNewFolder={onNewFolder}
        onRename={onRenameFolder}
        onDelete={onDeleteFolder}
        onDropAssets={onDropAssets}
        onMoveFolder={onMoveFolder}
      />
      <Section title="Smart folders" rows={sidebar.smartFolders} query={query} onPick={onPick} />
    </nav>
  );
}

/**
 * The folder tree: the one section that is a tree rather than a list.
 *
 * **The rows arrive depth-first**, each folder followed by its own subtree
 * (`@roost/library`'s `orderTree`), which is what makes both the indentation
 * and the collapsing correct with no parent ids on the wire: a branch is closed
 * by skipping the rows that follow it at a greater depth. Until 2026-09-06 they
 * arrived in one alphabetical run and were indented anyway, so the pane drew a
 * tree that was not one.
 *
 * **It is drawn even when it is empty**, unlike every other section, because
 * its heading carries the only way to make the first folder.
 */
function Folders({
  rows,
  query,
  onPick,
  expansion,
  onNewFolder,
  onRename,
  onDelete,
  onDropAssets,
  onMoveFolder,
}: {
  readonly rows: readonly SidebarFolderRow[];
  readonly query: string;
  readonly onPick: (query: string) => void;
  readonly expansion: Expansion;
  readonly onNewFolder: (parent: SidebarFolderRow | null) => void;
  readonly onRename: (folder: SidebarFolderRow) => void;
  readonly onDelete: (folder: SidebarFolderRow) => void;
  readonly onDropAssets: (
    folder: SidebarFolderRow,
    hashes: readonly string[],
    copy: boolean,
  ) => void;
  readonly onMoveFolder: (folder: number, parent: number | null) => void;
}): React.JSX.Element {
  /**
   * Searching the tree (`UI_SPEC.md` §4.1).
   *
   * Two pieces of state rather than one, because an open field holding nothing
   * is a real state: it is what the magnifier leaves behind, and what a folder
   * command returns the pane to.
   */
  const [searching, setSearching] = useState(false);
  const [needle, setNeedle] = useState("");
  const wanted = searching ? needle.trim() : "";
  const visible = useMemo(
    () => (wanted === "" ? drawn(rows, expansion.open) : found(rows, wanted)),
    [rows, expansion.open, wanted],
  );

  /**
   * The caret belongs in the field the moment it appears — a field that has to
   * be clicked before it can be typed into is two gestures for one intention,
   * and the magnifier was the first of them.
   */
  const takeCaret = useCallback((node: HTMLInputElement | null) => node?.focus(), []);

  /**
   * A folder command clears the needle, keeping the field.
   *
   * All four end in a dialog that changes the tree, and three of them change
   * what the tree holds: a new subfolder whose name does not match the needle
   * would be made and then not drawn, which reads as the command having failed.
   * Clearing costs a word somebody had finished with; hiding the result costs
   * the trust that the pane shows what is there.
   */
  const command = (raise: () => void) => () => {
    setNeedle("");
    raise();
  };

  /**
   * Where the folder on screen sits in the tree, or `-1` (ADR-0033 §7).
   *
   * An index rather than the row, because revealing it means walking back up
   * the depth-first list to its ancestors — the wire carries no parent id, and
   * §5 of this file's own doc comment is why.
   */
  const at = useMemo(() => rows.findIndex((row) => row.query === query), [rows, query]);

  /** The list item drawn for it, so the reveal has somewhere to scroll to. */
  const here = useRef<HTMLLIElement>(null);

  /**
   * Set by the button, read once the branches it opened have been drawn.
   *
   * Two steps, because the row it wants is not in the document yet: opening a
   * branch is a state change in the window, and the effect below runs after the
   * render that answers it.
   */
  const [revealing, setRevealing] = useState(false);

  useEffect(() => {
    if (!revealing) return;
    setRevealing(false);
    const node = here.current;
    if (node === null) return;
    // `nearest`, so a row already on screen does not jump the pane to centre
    // it: the question was "which one is it", and moving the answer while it is
    // being read is a worse answer.
    node.scrollIntoView({ block: "nearest" });
    // Focused as well as scrolled to, because a scroll has nothing to point at.
    // The scroll above has already happened, so the browser's own is refused.
    node.querySelector<HTMLElement>(".sidebar-row")?.focus({ preventScroll: true });
  }, [revealing]);

  /**
   * **Show the folder on screen** — the heading's third control.
   *
   * Asked for on 2026-09-13: with the branches closed (§2) and a tree taller
   * than the pane, the row marked as current is routinely somewhere nobody can
   * see, and "which folder am I in" had only the search field to answer it —
   * which is the wrong question, since the answer is already known.
   */
  const showCurrent = () => {
    const row = rows[at];
    if (row === undefined) return;
    // Every ancestor, found by walking back for the next shallower row: the
    // list is depth-first, so that is the parent by construction.
    let depth = row.depth;
    for (let back = at - 1; back >= 0 && depth > 0; back -= 1) {
      const above = rows[back];
      if (above === undefined || above.depth >= depth) continue;
      expansion.reveal(above.folder);
      depth = above.depth;
    }
    // A needle hides rows that do not match even when every branch is open
    // (§6), so it is cleared — but only when it is actually in the way. A
    // search that already shows the row is one somebody is still using.
    if (!visible.some(({ row: drawnRow }) => drawnRow.query === query)) setNeedle("");
    setRevealing(true);
  };

  /**
   * The row a drag is over, or `"top"` for the heading.
   *
   * Drawn rather than left to `:hover`, because a drag has no hover: the
   * pointer is holding something, and the only thing that says where it will
   * land is the target lighting up.
   */
  const [over, setOver] = useState<number | "top" | null>(null);

  /** Whether this drag is one this pane can take, and what it would mean. */
  const accepts = (event: React.DragEvent, folder: number | null): boolean => {
    if (carriesAssets(event.dataTransfer)) return folder !== null;
    if (!carriesFolder(event.dataTransfer)) return false;
    // A folder cannot be dropped on itself. Its own subtree is refused by the
    // engine, which knows the tree; this is the one case the pane can see.
    return String(folder) !== event.dataTransfer.getData(FOLDER_DRAG_TYPE);
  };

  return (
    <section className="sidebar-section">
      {/*
        A drop target that is not a control, which the a11y lint is right to
        ask about: dragging is pointer-only. The keyboard path is **Move to top
        level** in a folder's own menu below, and this is the shortcut for it —
        so the gesture has an equivalent rather than being the only way.
      */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
      <h2
        className="sidebar-heading"
        data-over={over === "top" || undefined}
        onDragOver={(event) => {
          // The heading is a drop target for folders only: assets belong in a
          // folder, and "the top level" is not one.
          if (!carriesFolder(event.dataTransfer)) return;
          event.preventDefault();
          setOver("top");
        }}
        onDragLeave={() => setOver((held) => (held === "top" ? null : held))}
        onDrop={(event) => {
          setOver(null);
          const dragged = draggedFolder(event.dataTransfer);
          if (dragged === undefined) return;
          event.preventDefault();
          onMoveFolder(dragged, null);
        }}
      >
        Folders
        <span className="sidebar-heading-actions">
          {/*
            Drawn only while there is a folder to show, which is the same rule
            as the magnifier's: a control whose only outcome is nothing is
            worse than an absent one. It is first because it answers a question
            about what is already on screen, where the other two act on the
            tree.
          */}
          {at >= 0 && (
            <button
              type="button"
              className="sidebar-add"
              title="Show the folder on screen"
              aria-label="Show the folder on screen"
              onClick={showCurrent}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <circle
                  cx="8"
                  cy="8"
                  r="3.25"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
          {/*
            Drawn only where there is something to search. A magnifier over an
            empty section is a control whose only outcome is "nothing matches",
            and the heading is drawn on an empty section solely so `+` has
            somewhere to live.
          */}
          {rows.length > 0 && (
            <button
              type="button"
              className="sidebar-add"
              title="Search folders"
              aria-label="Search folders"
              aria-expanded={searching}
              onClick={() => {
                setSearching((on) => !on);
                setNeedle("");
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <circle
                  cx="7"
                  cy="7"
                  r="4.25"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M10.25 10.25 13.5 13.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="sidebar-add"
            title="New folder"
            aria-label="New folder"
            onClick={command(() => onNewFolder(null))}
          >
            +
          </button>
        </span>
      </h2>
      {searching && (
        <div className="sidebar-search">
          <input
            ref={takeCaret}
            type="search"
            className="sidebar-search-input"
            aria-label="Search folders"
            placeholder="Search folders…"
            spellCheck={false}
            value={needle}
            onChange={(changed) => setNeedle(changed.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              // There is always something to close here, unlike the tag field's
              // Escape: the field itself. So it is taken rather than left to
              // the window.
              event.preventDefault();
              event.stopPropagation();
              setSearching(false);
              setNeedle("");
            }}
          />
        </div>
      )}
      <ul className="sidebar-list">
        {visible.map(({ row, hasChildren, isContext }) => (
          // The one row the reveal scrolls to. On the item rather than on the
          // branch inside it, which is a Radix trigger and has a ref of its own.
          <li key={row.id} ref={row.query === query ? here : undefined}>
            <ContextMenu.Root>
              <ContextMenu.Trigger asChild>
                {/*
                  Drag handlers on a row that is not itself a control. The
                  keyboard reaches everything they do through this row's own
                  menu — the context-menu key opens it from the focused row —
                  so the drag is a faster way to say something sayable, which
                  is the test this rule is really asking about (`UI_SPEC.md`
                  §10).
                */}
                {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
                <div
                  className="sidebar-branch"
                  data-depth={depthOf(row)}
                  data-context={isContext || undefined}
                  data-over={over === row.folder || undefined}
                  // The branch is the drag source as well as a target: a folder
                  // travels as its id, and the row's own `draggable` would take
                  // the disclosure arrow with it.
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(FOLDER_DRAG_TYPE, String(row.folder));
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(event) => {
                    if (!accepts(event, row.folder)) return;
                    // Both halves are required: without `preventDefault` on
                    // *every* `dragover` the browser refuses the drop, and
                    // `dropEffect` is what the cursor shows the hand.
                    event.preventDefault();
                    event.dataTransfer.dropEffect =
                      carriesAssets(event.dataTransfer) && event.ctrlKey ? "copy" : "move";
                    setOver(row.folder);
                  }}
                  onDragLeave={() => setOver((held) => (held === row.folder ? null : held))}
                  onDrop={(event) => {
                    setOver(null);
                    if (!accepts(event, row.folder)) return;
                    event.preventDefault();
                    const folder = draggedFolder(event.dataTransfer);
                    if (folder !== undefined) return onMoveFolder(folder, row.folder);
                    const hashes = draggedAssets(event.dataTransfer);
                    if (hashes.length > 0) onDropAssets(row, hashes, event.ctrlKey);
                  }}
                >
                  {/*
                    A button where there are children and a spacer where there
                    are none — never a disabled button, which would be a target
                    that answers a press by doing nothing. The spacer keeps the
                    names in one column, which is what makes the indentation
                    readable at all.
                  */}
                  {hasChildren && wanted !== "" ? (
                    /*
                      While a needle is typed the disclosure is a mark rather
                      than a control. A branch is drawn only because something
                      under it matched, so the one thing closing it could do is
                      hide the reason it is there — and the expansion the pane
                      returns to when the field is cleared is the one it had
                      before, untouched by anything done in here.
                    */
                    <span className="sidebar-twisty" data-open="" aria-hidden="true">
                      <Chevron />
                    </span>
                  ) : hasChildren ? (
                    <button
                      type="button"
                      className="sidebar-twisty"
                      aria-expanded={expansion.open.has(row.folder)}
                      aria-label={`${expansion.open.has(row.folder) ? "Collapse" : "Expand"} ${row.name}`}
                      onClick={() => expansion.toggle(row.folder)}
                    >
                      <Chevron />
                    </button>
                  ) : (
                    <span className="sidebar-twisty" aria-hidden="true" />
                  )}
                  <Row
                    name={row.name}
                    query={row.query}
                    count={row.count}
                    depth={0}
                    stars={null}
                    isCurrent={row.query === query}
                    onPick={onPick}
                  />
                </div>
              </ContextMenu.Trigger>

              <ContextMenu.Portal>
                <ContextMenu.Content className="menu" collisionPadding={8}>
                  <ContextMenu.Item
                    className="menu-item"
                    onSelect={command(() => onNewFolder(row))}
                  >
                    <span className="menu-mark" />
                    <span className="menu-label">New subfolder…</span>
                  </ContextMenu.Item>
                  <ContextMenu.Item className="menu-item" onSelect={command(() => onRename(row))}>
                    <span className="menu-mark" />
                    <span className="menu-label">Rename…</span>
                  </ContextMenu.Item>
                  {/*
                    The keyboard's half of dragging a folder onto the heading.
                    Only the one direction: moving a folder *into* another is a
                    choice among every folder there is, which is a picker, and
                    the drag is the gesture that already expresses it. Coming
                    back out has exactly one destination.
                  */}
                  <ContextMenu.Item
                    className="menu-item"
                    disabled={row.depth === 0}
                    onSelect={() => onMoveFolder(row.folder, null)}
                  >
                    <span className="menu-mark" />
                    <span className="menu-label">Move to top level</span>
                  </ContextMenu.Item>
                  <ContextMenu.Separator className="menu-separator" />
                  {/*
                    Not drawn in the danger ramp, though what it opens is: the
                    asset menu does not colour `Delete permanently` either, and
                    a red row in a menu is attention rather than meaning
                    (`UI_SPEC.md` §2). The ellipsis is the promise that a
                    dialog comes next, and the dialog is where the choice about
                    the contents is made (ADR-0033).
                  */}
                  <ContextMenu.Item className="menu-item" onSelect={command(() => onDelete(row))}>
                    <span className="menu-mark" />
                    <span className="menu-label">Delete folder…</span>
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          </li>
        ))}
      </ul>
      {/*
        A heading over nothing reads as a pane that has broken rather than as
        an answer. The wording is the filter menu's, because it is the same
        sentence about the same gesture (`UI_SPEC.md` §4.4).
      */}
      {wanted !== "" && visible.length === 0 && <p className="sidebar-empty">Nothing matches</p>}
    </section>
  );
}

/**
 * The disclosure arrow, drawn rather than typed.
 *
 * `▸` is a glyph whose weight and size the font decides, and at the size this
 * control wants it arrived as a speck the pointer had to hunt for (reported
 * 2026-09-07). A path is the same shape at every density and turns cleanly.
 */
function Chevron(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M6 3.5 10.5 8 6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** What a row is indented by, capped where a name would run out of room. */
function depthOf(row: SidebarFolderRow): number | undefined {
  return row.depth === 0 ? undefined : Math.min(row.depth, MAX_INDENT);
}

/**
 * The rows to draw, and which of them have something under them.
 *
 * One pass over a depth-first list. A closed folder hides every row that
 * follows it at a greater depth, which is its subtree and nothing else; the
 * *next* row's depth is what says whether a folder has children at all, so no
 * row needs to know its parent.
 */
export function drawn(rows: readonly SidebarFolderRow[], open: ReadonlySet<number>): DrawnRow[] {
  const visible: DrawnRow[] = [];
  /** The depth of the closed folder currently hiding rows, if one is. */
  let hiding: number | null = null;

  for (const [at, row] of rows.entries()) {
    if (hiding !== null) {
      if (row.depth > hiding) continue;
      hiding = null;
    }
    const hasChildren = (rows[at + 1]?.depth ?? 0) > row.depth;
    visible.push({ row, hasChildren, isContext: false });
    if (hasChildren && !open.has(row.folder)) hiding = row.depth;
  }
  return visible;
}

/**
 * The id the engine gives the Trash place (`@roost/library`'s `sidebar.ts`).
 *
 * Matched on rather than on the name or the query: the name is a UI string and
 * the query is `is:trashed`, which is grammar this file is not allowed to write
 * (§4.1). `App.tsx` finds the same row the same way.
 */
const TRASH = "trash";

function Section({
  title,
  rows,
  query,
  onPick,
  onEmptyTrash,
}: {
  readonly title: string;
  readonly rows: readonly SidebarRow[];
  readonly query: string;
  readonly onPick: (query: string) => void;
  /** Given to Places only: it is the one section with a row that has a command. */
  readonly onEmptyTrash?: (() => void) | undefined;
}): React.JSX.Element | null {
  // An empty section is not drawn: a library with no smart folders should not
  // have to look at a heading explaining that.
  if (rows.length === 0) return null;

  return (
    <section className="sidebar-section">
      <h2 className="sidebar-heading">{title}</h2>
      <ul className="sidebar-list">
        {rows.map((row) => {
          const drawn = (
            <Row
              name={row.name}
              query={row.query}
              count={row.count}
              depth={row.depth}
              stars={row.stars}
              isCurrent={row.query === query}
              onPick={onPick}
            />
          );
          if (row.id !== TRASH || onEmptyTrash === undefined) return <li key={row.id}>{drawn}</li>;
          return (
            <li key={row.id}>
              <ContextMenu.Root>
                {/*
                  A wrapper because `Row` is a button and the trigger needs a
                  node it can hand a ref to. It draws nothing of its own: the
                  row is still what fills the width.
                */}
                <ContextMenu.Trigger asChild>
                  <div className="sidebar-place">{drawn}</div>
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content className="menu" collisionPadding={8}>
                    {/*
                      Dead rather than absent when the trash is empty, for the
                      reason the preview's arrows are (`UI_SPEC.md` §3.5): an
                      end is a fact worth showing, and a menu whose one item
                      comes and goes is a menu people stop trusting.

                      No ellipsis, and the same wording as the asset menu's
                      row: the dialog that follows asks nothing, it confirms
                      (`UI_SPEC.md` §3.4). `Delete folder…` has one because its
                      dialog carries a question.
                    */}
                    <ContextMenu.Item
                      className="menu-item"
                      disabled={row.count === 0}
                      onSelect={onEmptyTrash}
                    >
                      <span className="menu-mark" />
                      <span className="menu-label">Empty trash</span>
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * One row. Memo'd on primitives, like a grid cell and for a weaker version of
 * the same reason: a library with a thousand tags redraws all of them whenever
 * anything changes, and only one of them changed.
 */
const Row = memo(function Row({
  name,
  query,
  count,
  depth,
  stars,
  isCurrent,
  onPick,
}: {
  readonly name: string;
  readonly query: string;
  readonly count: number | null;
  readonly depth: number;
  /** Filled stars to draw instead of the name, or `null` to draw the name. */
  readonly stars: number | null;
  readonly isCurrent: boolean;
  readonly onPick: (query: string) => void;
}): React.JSX.Element {
  const shown = elideName(name);
  const cut = shown !== name;

  return (
    <button
      type="button"
      className="sidebar-row"
      data-current={isCurrent || undefined}
      aria-current={isCurrent ? "true" : undefined}
      data-depth={depth === 0 ? undefined : Math.min(depth, MAX_INDENT)}
      // Only where something was actually taken away. A tooltip repeating a
      // name already on screen is one that goes off while somebody is reading
      // the row it covers.
      title={cut ? name : undefined}
      onClick={() => onPick(query)}
    >
      {stars === null ? (
        <>
          {/* The label holds the cut and nothing else, so anything reading the
              row's text reads what is on screen. The whole name follows it,
              off screen and in the accessible tree — a cut name read aloud is
              the half that does not say which folder. */}
          <span className="sidebar-label" aria-hidden={cut || undefined}>
            {shown}
          </span>
          {cut && <span className="sidebar-spoken-name">{name}</span>}
        </>
      ) : (
        <span className="sidebar-label">
          <Stars filled={stars} />
          {/* The name is still the accessible one. A screen reader reads "3
              stars 0", the same sentence the row used to read, while the eye
              gets the shape — and the tests keep asking for the row by name. */}
          <span className="sidebar-spoken-name">{name}</span>
        </span>
      )}
      {count !== null && <span className="sidebar-count">{counted(count)}</span>}
    </button>
  );
});

/**
 * Five stars, `filled` of them lit.
 *
 * Always five, so the rows read as one scale rather than as a staircase, and
 * the unrated row — zero filled — is the same shape with nothing lit. The
 * glyph is the one the inspector's rating control already uses, coloured
 * rather than swapped for a hollow character: two star characters from two
 * fonts is how a row ends up a pixel taller than the one above it.
 */
function Stars({ filled }: { readonly filled: number }): React.JSX.Element {
  return (
    <span className="sidebar-stars" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((star) => (
        <span key={star} data-on={star <= filled ? "" : undefined}>
          ★
        </span>
      ))}
    </span>
  );
}

/**
 * How deep the indentation goes before it stops.
 *
 * A folder path may be sixty-four deep (`@roost/library` bounds it there), and
 * indenting that far would leave no room for a name. The indent is expressed as
 * an attribute rather than an inline style so it stays in CSS, where the
 * spacing token lives.
 */
const MAX_INDENT = 8;

/**
 * The longest name the pane draws, in characters (`UI_SPEC.md` §4.1).
 *
 * Asked for on 2026-09-08, from a pane of long folder names: the ellipsis the
 * label has always had is a *width*, so what was cut moved with the pane and a
 * name could take the whole column and still say nothing the next one did not.
 * A count of characters is the one rule that reads the same at every width.
 *
 * The rule is the row's rather than the folder tree's — a smart folder is named
 * by hand too, and one section cutting while the one under it does not is a
 * difference nobody could explain. Places are ours and are nowhere near it.
 */
export const MAX_NAME = 35;

/**
 * `name`, cut to {@link MAX_NAME} characters with an ellipsis as the last one.
 *
 * The ellipsis is inside the budget rather than added to it — 35 is what is
 * drawn, not 36 — and the trailing space of a name cut mid-phrase goes with it,
 * because "Brand assets …" reads as a word nobody wrote.
 *
 * Counted in code points rather than in `string.length`: an emoji in a folder
 * name is one character to the person who typed it and two to UTF-16, and
 * slicing between the halves of a surrogate pair draws a replacement glyph.
 */
export function elideName(name: string): string {
  const characters = [...name];
  if (characters.length <= MAX_NAME) return name;
  return `${characters
    .slice(0, MAX_NAME - 1)
    .join("")
    .trimEnd()}…`;
}
