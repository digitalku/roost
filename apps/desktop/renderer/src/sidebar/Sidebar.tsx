import type { SidebarFolderRow, SidebarRow, WireSidebar } from "@roost/contract";
import { ContextMenu } from "radix-ui";
import { memo, useMemo, useState } from "react";
import {
  carriesAssets,
  carriesFolder,
  draggedAssets,
  draggedFolder,
  FOLDER_DRAG_TYPE,
} from "../dnd.js";
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
}: SidebarProps): React.JSX.Element {
  return (
    <nav className="sidebar" aria-label="Library">
      <Section title="Places" rows={sidebar.places} query={query} onPick={onPick} />
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
  const visible = useMemo(() => drawn(rows, expansion.open), [rows, expansion.open]);
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
        <button
          type="button"
          className="sidebar-add"
          title="New folder"
          aria-label="New folder"
          onClick={() => onNewFolder(null)}
        >
          +
        </button>
      </h2>
      <ul className="sidebar-list">
        {visible.map(({ row, hasChildren }) => (
          <li key={row.id}>
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
                  {hasChildren ? (
                    <button
                      type="button"
                      className="sidebar-twisty"
                      aria-expanded={expansion.open.has(row.folder)}
                      aria-label={`${expansion.open.has(row.folder) ? "Collapse" : "Expand"} ${row.name}`}
                      onClick={() => expansion.toggle(row.folder)}
                    >
                      {/* Drawn rather than typed: `▸` is a glyph the font
                          decides the weight and the size of, and at the size
                          this control wants it arrived as a speck the pointer
                          had to hunt for. A path is the same shape at every
                          density and turns cleanly. */}
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
                  <ContextMenu.Item className="menu-item" onSelect={() => onNewFolder(row)}>
                    <span className="menu-mark" />
                    <span className="menu-label">New subfolder…</span>
                  </ContextMenu.Item>
                  <ContextMenu.Item className="menu-item" onSelect={() => onRename(row)}>
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
                  <ContextMenu.Item className="menu-item" onSelect={() => onDelete(row)}>
                    <span className="menu-mark" />
                    <span className="menu-label">Delete folder…</span>
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          </li>
        ))}
      </ul>
    </section>
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
export function drawn(
  rows: readonly SidebarFolderRow[],
  open: ReadonlySet<number>,
): { row: SidebarFolderRow; hasChildren: boolean }[] {
  const visible: { row: SidebarFolderRow; hasChildren: boolean }[] = [];
  /** The depth of the closed folder currently hiding rows, if one is. */
  let hiding: number | null = null;

  for (const [at, row] of rows.entries()) {
    if (hiding !== null) {
      if (row.depth > hiding) continue;
      hiding = null;
    }
    const hasChildren = (rows[at + 1]?.depth ?? 0) > row.depth;
    visible.push({ row, hasChildren });
    if (hasChildren && !open.has(row.folder)) hiding = row.depth;
  }
  return visible;
}

function Section({
  title,
  rows,
  query,
  onPick,
}: {
  readonly title: string;
  readonly rows: readonly SidebarRow[];
  readonly query: string;
  readonly onPick: (query: string) => void;
}): React.JSX.Element | null {
  // An empty section is not drawn: a library with no smart folders should not
  // have to look at a heading explaining that.
  if (rows.length === 0) return null;

  return (
    <section className="sidebar-section">
      <h2 className="sidebar-heading">{title}</h2>
      <ul className="sidebar-list">
        {rows.map((row) => (
          <li key={row.id}>
            <Row
              name={row.name}
              query={row.query}
              count={row.count}
              depth={row.depth}
              stars={row.stars}
              isCurrent={row.query === query}
              onPick={onPick}
            />
          </li>
        ))}
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
  return (
    <button
      type="button"
      className="sidebar-row"
      data-current={isCurrent || undefined}
      aria-current={isCurrent ? "true" : undefined}
      data-depth={depth === 0 ? undefined : Math.min(depth, MAX_INDENT)}
      onClick={() => onPick(query)}
    >
      {stars === null ? (
        <span className="sidebar-label">{name}</span>
      ) : (
        <span className="sidebar-label">
          <Stars filled={stars} />
          {/* The name is still the accessible one. A screen reader reads "3
              stars 0", the same sentence the row used to read, while the eye
              gets the shape — and the tests keep asking for the row by name. */}
          <span className="sidebar-stars-name">{name}</span>
        </span>
      )}
      {count !== null && <span className="sidebar-count">{count.toLocaleString()}</span>}
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
