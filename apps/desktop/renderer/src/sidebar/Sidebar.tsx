import type { SidebarRow, WireSidebar } from "@roost/contract";
import { memo, useMemo } from "react";

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
 */

export interface SidebarProps {
  readonly sidebar: WireSidebar;
  /** The query currently on screen, so the matching row can be marked. */
  readonly query: string;
  readonly onPick: (query: string) => void;
}

export function Sidebar({ sidebar, query, onPick }: SidebarProps): React.JSX.Element {
  // Tags are grouped, and the ungrouped ones come last (`UI_SPEC.md` §4.1).
  const tagGroups = useMemo(() => groupTags(sidebar.tags), [sidebar.tags]);

  return (
    <nav className="sidebar" aria-label="Library">
      <Section title="Places" rows={sidebar.places} query={query} onPick={onPick} />
      <Section title="Folders" rows={sidebar.folders} query={query} onPick={onPick} />
      <Section title="Smart folders" rows={sidebar.smartFolders} query={query} onPick={onPick} />
      {tagGroups.map(([group, rows]) => (
        <Section
          key={group ?? "(ungrouped)"}
          title={group === null ? "Tags" : `Tags · ${group}`}
          rows={rows}
          query={query}
          onPick={onPick}
        />
      ))}
    </nav>
  );
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
  isCurrent,
  onPick,
}: {
  readonly name: string;
  readonly query: string;
  readonly count: number | null;
  readonly depth: number;
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
      <span className="sidebar-label">{name}</span>
      {count !== null && <span className="sidebar-count">{count.toLocaleString()}</span>}
    </button>
  );
});

/**
 * How deep the indentation goes before it stops.
 *
 * A folder path may be sixty-four deep (`@roost/library` bounds it there), and
 * indenting that far would leave no room for a name. The indent is expressed as
 * an attribute rather than an inline style so it stays in CSS, where the
 * spacing token lives.
 */
const MAX_INDENT = 8;

/** Grouped tags first, in first-seen order; ungrouped last. */
function groupTags(tags: readonly SidebarRow[]): [string | null, SidebarRow[]][] {
  const groups = new Map<string | null, SidebarRow[]>();
  for (const tag of tags) {
    const existing = groups.get(tag.group);
    if (existing === undefined) groups.set(tag.group, [tag]);
    else existing.push(tag);
  }
  const ungrouped = groups.get(null);
  groups.delete(null);
  const ordered: [string | null, SidebarRow[]][] = [...groups];
  if (ungrouped !== undefined) ordered.push([null, ungrouped]);
  return ordered;
}
