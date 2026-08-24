import { discoverLibrary, NotALibraryError } from "@roost/library";

/**
 * Which library a command acts on.
 *
 * Three ways, in order: an explicit `--library`, the `ROOST_LIBRARY`
 * environment variable, or the nearest library at or above the working
 * directory. The last is what lets the CLI be run from inside a library the way
 * `git` is, and it is why `roost stats` needs no arguments at all.
 */
export async function resolveLibrary(explicit: string | undefined): Promise<string> {
  if (explicit !== undefined && explicit !== "") return explicit;

  const fromEnvironment = process.env["ROOST_LIBRARY"];
  if (fromEnvironment !== undefined && fromEnvironment !== "") return fromEnvironment;

  const found = await discoverLibrary(process.cwd());
  if (found === undefined) throw new NotALibraryError(process.cwd());
  return found;
}
