import type { Expr } from "./ast.js";
import { parse } from "./parser.js";

/**
 * Reading a query as a search for folders as well as assets (ADR-0057).
 *
 * A typed search draws the folders whose names hold its words ahead of the
 * assets it finds, but only while the query is **words and nothing else**, or
 * words inside one folder — the shape the field takes when somebody opens a
 * folder and starts typing. Any other term is a filter a folder cannot answer:
 * a folder called *kucing* does not have five stars, and drawing it under
 * `rating:5` would say that it does (ADR-0043 §3).
 */
export interface FolderSearch {
  /** The free-text terms, as the grammar read them. A quoted phrase is one. */
  readonly words: readonly FolderWord[];
  /**
   * The path of the folder the words were typed inside, or `null` for the whole
   * library. `folder:` and `infolder:` both give one: the checkbox says how deep
   * the grid draws assets, not how deep a search looks (ADR-0057 §3.3).
   */
  readonly within: string | null;
}

/** One free-text term, and whether its last word may be a prefix (ADR-0057 §7). */
export interface FolderWord {
  readonly value: string;
  readonly exact: boolean;
}

/**
 * The words a query searches folders for, or `undefined` when it is any other
 * shape.
 *
 * Never throws: a query that does not parse is not a search for anything, and
 * the field is already saying so.
 */
export function folderSearch(input: string): FolderSearch | undefined {
  let expr: Expr;
  try {
    expr = parse(input);
  } catch {
    return undefined;
  }

  const words: FolderWord[] = [];
  const folders: string[] = [];
  for (const branch of conjuncts(expr)) {
    if (branch.kind !== "term") return undefined;
    const { term } = branch;
    if (term.field === "text") words.push({ value: term.value, exact: term.exact });
    else if (term.field === "folder" || term.field === "infolder") folders.push(term.value);
    else return undefined;
  }

  // Two folders is two places, and a folder alone is not a search: it is the
  // folder's own contents, which ADR-0043 draws already.
  if (words.length === 0 || folders.length > 1) return undefined;
  return { words, within: folders[0] ?? null };
}

/** The branches of the top-level `AND`, with parenthesised ones opened up. */
function conjuncts(expr: Expr): Expr[] {
  return expr.kind === "and" ? expr.branches.flatMap(conjuncts) : [expr];
}
