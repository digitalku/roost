import { resolve } from "node:path";
import { Library, libraryNameFromPath, withLibrarySuffix } from "@roost/library";
import { row } from "../format.js";

export interface InitArgs {
  readonly path: string;
  readonly name?: string;
}

/**
 * Creates a library at `<path>.roost`.
 *
 * The suffix is added here rather than expected from the caller, so that the
 * CLI and the window put a library in the same place given the same intent
 * (ADR-0014). It is idempotent — `roost init ~/Photos.roost` and
 * `roost init ~/Photos` land on one directory — and the path actually used is
 * printed, because a command that silently creates something other than what
 * was typed has to say so.
 */
export async function init(args: InitArgs, out: (line: string) => void): Promise<void> {
  const root = withLibrarySuffix(resolve(args.path));
  const library = await Library.create(root, args.name ?? libraryNameFromPath(root));
  try {
    out(`Created library "${library.manifest.name}"`);
    out(row("path", root));
    out(row("id", library.manifest.id));
  } finally {
    await library.close();
  }
}
