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
