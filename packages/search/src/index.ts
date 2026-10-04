/**
 * The Roost Query Language: grammar, parser, and SQL compiler.
 *
 * RQL compiles to a `WHERE` fragment with **bound parameters only**. This is
 * user input reaching a database, so no value the user typed is ever written
 * into SQL text, and the parser is property-tested rather than only
 * example-tested.
 *
 * ```text
 * tag:wood -tag:wip (ext:png OR ext:jpg) rating:>=4 size:>2mb "beach"
 * ```
 *
 * Adjacent terms are ANDed. `OR` and parentheses are explicit. A leading `-`
 * negates. The grammar is documented in `docs/DATA_MODEL.md` §3 and is **frozen
 * by compatibility, not preference**: a smart folder stores its query text, so
 * a query this build cannot parse is a folder the user loses.
 */
import type { Filter } from "@roost/core";
import { compileQuery, type Folders, NO_FOLDERS } from "./compile.js";
import { parse } from "./parser.js";

export type {
  Compare,
  Expr,
  Flag,
  NameField,
  NumericField,
  Term,
} from "./ast.js";
export { FLAGS, NAME_FIELDS, NUMERIC_FIELDS } from "./ast.js";
export { compileQuery, type Folders, NO_FOLDERS } from "./compile.js";
export {
  QUERY_ERROR_KINDS,
  QueryError,
  type QueryErrorKind,
} from "./error.js";
export {
  type Facets,
  joinQuery,
  NO_FACETS,
  type SplitQuery,
  type Stars,
  type SubfolderSections,
  splitQuery,
  subfolderSections,
  withSubfolders,
} from "./facets.js";
export { type FolderSearch, folderSearch } from "./folder-search.js";
export { MAX_DEPTH, parse } from "./parser.js";
export { quoteValue } from "./quote.js";

/** Parses and compiles in one step. */
export function buildQuery(input: string, folders: Folders = NO_FOLDERS): Filter {
  return compileQuery(parse(input), folders);
}
