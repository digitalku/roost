import { resolve } from "node:path";
import { chooseThumbnail, chosenThumbnails, clearThumbnail } from "@roost/library";
import { resolveAll, short } from "../assets.js";
import { EXIT, type Streams, usage } from "../io.js";
import { withLibrary } from "../open.js";

/**
 * A thumbnail somebody chose, in place of the file's own (ADR-0060).
 *
 * Drawn here rather than queued, unlike `poster`: there is nothing to journal
 * and nothing a later `roost thumb` could draw it from, because the image is not
 * kept. Its pictures in `thumbs/` are the whole of it, and are lost with that
 * directory. `--clear` queues the file's own, which `roost thumb` draws.
 */
export async function thumbnail(
  root: string,
  needle: string,
  image: string | undefined,
  clear: boolean,
  streams: Streams,
): Promise<number> {
  if (clear && image !== undefined) {
    return usage(streams, "thumbnail", "--clear and an image ask for different things");
  }

  return withLibrary(root, async (library) => {
    const ids = resolveAll(library, [needle]);
    const id = ids[0];
    if (id === undefined) throw new Error("resolveAll returned nothing for one argument");

    // Neither is a read: whether the picture is the file's own is not
    // something a look at it can tell.
    if (!clear && image === undefined) {
      streams.out(
        chosenThumbnails(library, [id]).has(id)
          ? `${short(id)} has a custom thumbnail`
          : `${short(id)} uses its own thumbnail`,
      );
      return EXIT.ok;
    }

    if (clear) {
      const cleared = clearThumbnail(library, [id]);
      streams.out(
        cleared.length === 0
          ? `${short(id)} already uses its own thumbnail`
          : `${short(id)} back to its own thumbnail — run \`roost thumb\` to draw it`,
      );
      return EXIT.ok;
    }

    await chooseThumbnail(library, [id], resolve(image ?? ""));
    streams.out(`${short(id)} now has a custom thumbnail`);
    return EXIT.ok;
  });
}
