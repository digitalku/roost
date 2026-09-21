import { readFile } from "node:fs/promises";
import { saveEdit } from "@roost/library";
import { resolveAll, short } from "../assets.js";
import { EXIT, type Streams, usage } from "../io.js";
import { withLibrary } from "../open.js";

/**
 * Replaces an asset's contents with a file's (ADR-0046, superseding ADR-0026).
 *
 * A verb here because ADR-0005 makes the headless CLI a first-class frontend:
 * the window can save an edit, so this can too.
 *
 * **It does not edit anything.** The bytes come from a file the caller already
 * has; what this command does is write them over the asset's own file. An
 * editor in the terminal would be a second thing to keep in step with the one
 * in the window.
 *
 * **Nothing is journalled** (RL-23), and that is the whole of what version 2
 * changed here: the asset is the same asset afterwards, keeps its tags, its
 * folders and its comments, and what is thrown away is only what was derived
 * from the bytes that are gone.
 */
export async function save(
  root: string,
  needle: string,
  file: string | undefined,
  streams: Streams,
): Promise<number> {
  if (file === undefined) {
    return usage(streams, "save", "save needs a file to take the new contents from");
  }

  return withLibrary(root, async (library) => {
    const ids = resolveAll(library, [needle]);
    const id = ids[0];
    if (id === undefined) throw new Error("resolveAll returned nothing for one argument");

    await saveEdit(library, id, await readFile(file));

    streams.out(`${short(id)} now holds those bytes — run \`roost thumb\` to draw its picture`);
    return EXIT.ok;
  });
}
