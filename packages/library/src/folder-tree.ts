import type { FolderRow } from "@roost/core";

/**
 * Walking the folder tree in memory.
 *
 * The tree is user-made and small — tens of rows, not thousands — so one
 * statement that returns all of it beats a recursive query per folder, and beats
 * a recursive CTE inside every compiled search (`DATA_MODEL.md` §3).
 */

/** Child ids by parent id. Folders at the top level appear in no entry. */
export function childrenById(rows: readonly FolderRow[]): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    if (row.parentId === null) continue;
    const siblings = children.get(row.parentId);
    if (siblings === undefined) children.set(row.parentId, [row.id]);
    else siblings.push(row.id);
  }
  return children;
}

/**
 * Every id in `roots`, plus everything beneath them.
 *
 * The `seen` check is what makes a corrupt parent cycle cost a wrong answer
 * rather than a hang. The editing commands cannot produce one — `moveFolder`
 * refuses — but a hand-edited journal can.
 */
export function descendants(
  children: ReadonlyMap<number, readonly number[]>,
  roots: readonly number[],
): number[] {
  const seen = new Set<number>();
  const frontier = [...roots];

  while (frontier.length > 0) {
    const id = frontier.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    frontier.push(...(children.get(id) ?? []));
  }
  return [...seen];
}

/**
 * The tree in the order a pane draws it: each folder immediately followed by
 * its own subtree, siblings in the order the rows arrived.
 *
 * **`repo.folders()` is a display order, not a topological one** — it sorts by
 * `sort_order`, then name, and nothing sets `sort_order` yet, so a plain listing
 * is one flat alphabetical run in which a child can appear above its parent and
 * beside somebody else's. Indented, that reads as a tree while being none: it is
 * what the window drew until 2026-09-06, and it is why `Icons` sat under
 * whatever folder happened to sort before it.
 *
 * A row whose parent is missing is corruption, and it lands at the top level
 * rather than disappearing — the same choice the depth mapping makes.
 */
export function orderTree(rows: readonly FolderRow[]): FolderRow[] {
  const children = new Map<number | null, FolderRow[]>();
  const known = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    const parent = row.parentId !== null && known.has(row.parentId) ? row.parentId : null;
    const siblings = children.get(parent);
    if (siblings === undefined) children.set(parent, [row]);
    else siblings.push(row);
  }

  const ordered: FolderRow[] = [];
  const walk = (parent: number | null, depth: number): void => {
    // Bounded for the same reason `descendants` keeps a `seen` set: a
    // hand-edited journal can describe a cycle that the editing commands
    // refuse to make.
    if (depth > MAX_TREE_DEPTH) return;
    for (const row of children.get(parent) ?? []) {
      ordered.push(row);
      walk(row.id, depth + 1);
    }
  };
  walk(null, 0);
  return ordered;
}

/** Matches the depth `pathOf` stops walking at. */
const MAX_TREE_DEPTH = 64;
