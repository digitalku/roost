import type { SidebarFolderRow } from "@roost/contract";

/**
 * Searching a folder tree, for the two controls that draw one.
 *
 * The navigation pane (`UI_SPEC.md` §4.1) and the inspector's **Add to folder**
 * menu (§3.9) show the same rows in the same order, so they search them by the
 * same rule. It lives here rather than in either of them because the second one
 * asking would otherwise have written a second, subtly different answer.
 */

/** One folder row as a tree draws it. */
export interface DrawnRow {
  readonly row: SidebarFolderRow;
  /** Whether a row deeper than this one is drawn under it. */
  readonly hasChildren: boolean;
  /**
   * Drawn only because something under it matched the needle.
   *
   * Always `false` outside a search: every row of an unsearched tree is there
   * on its own account.
   */
  readonly isContext: boolean;
}

/**
 * The rows a needle finds, and the ones that hold them up (`UI_SPEC.md` §4.1).
 *
 * The tree keeps its shape: a match is drawn where it sits, every folder on the
 * path down to it comes along as context, and the expansion state is not
 * consulted — a branch is open here because it leads somewhere. What does *not*
 * come along is a match's own subtree, which is what stops a needle matching a
 * folder near the root from redrawing the whole pane.
 *
 * Two passes rather than one, because whether a row is kept can only be decided
 * by rows that come after it. The second pass is over the original list, so the
 * result is in the same depth-first order and the indentation stays contiguous.
 */
export function found(rows: readonly SidebarFolderRow[], needle: string): DrawnRow[] {
  const wanted = needle.trim().toLowerCase();
  /** Rows matching the needle, by index. */
  const hits = new Set<number>();
  /** Those, and every ancestor holding one of them up. */
  const keep = new Set<number>();
  /** The ancestors of the row being read, by depth — the list is depth-first. */
  const path: number[] = [];

  for (const [at, row] of rows.entries()) {
    path.length = row.depth;
    path[row.depth] = at;
    if (!row.name.toLowerCase().includes(wanted)) continue;
    hits.add(at);
    for (const ancestor of path) keep.add(ancestor);
  }

  const kept = [...rows.entries()].filter(([at]) => keep.has(at));
  return kept.map(([at, row], drawnAt) => ({
    row,
    hasChildren: (kept[drawnAt + 1]?.[1].depth ?? 0) > row.depth,
    isContext: !hits.has(at),
  }));
}
