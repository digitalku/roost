import { readFile } from "node:fs/promises";
import { saveEdit, supersedeAsset } from "@roost/library";
import { resolveAll, short } from "../assets.js";
import { EXIT, type Streams, usage } from "../io.js";
import { withLibrary } from "../open.js";

/**
 * Replaces an asset's contents with a file's, as a new version (ADR-0026).
 *
 * A verb here because ADR-0005 makes the headless CLI a first-class frontend:
 * the window can save an edit, so this can too — and the rebuild conformance
 * test needs a way to author a `supersede` without a window.
 *
 * **It does not edit anything.** The bytes come from a file the caller already
 * has; what this command does is journal them as the new version and mark the
 * old one superseded. An editor in the terminal would be a second thing to keep
 * in step with the one in the window.
 */
export async function save(
  root: string,
  needle: string,
  file: string | undefined,
  clear: boolean,
  streams: Streams,
): Promise<number> {
  if (clear && file !== undefined) {
    return usage(streams, "save", "--clear and a file ask for different things");
  }
  if (!clear && file === undefined) {
    return usage(streams, "save", "save needs a file to take the new contents from");
  }

  return withLibrary(root, async (library) => {
    const hashes = resolveAll(library, [needle]);
    const hash = hashes[0];
    if (hash === undefined) throw new Error("resolveAll returned nothing for one argument");

    if (clear) {
      await supersedeAsset(library, hash, null);
      streams.out(`${short(hash)} is current again`);
      return EXIT.ok;
    }

    // `file` is defined here: the two guards above cover every other shape.
    const bytes = await readFile(file as string);
    const saved = await saveEdit(library, hash, bytes);

    if (saved === hash) {
      streams.out(`${short(hash)} already holds those bytes — nothing written`);
      return EXIT.ok;
    }

    streams.out(
      `${short(hash)} superseded by ${short(saved)} — run \`roost thumb\` to draw its picture`,
    );
    return EXIT.ok;
  });
}
