import { poster as posterOf, setPoster } from "@roost/library";
import { resolveAll, short } from "../assets.js";
import { EXIT, type Streams, usage } from "../io.js";
import { parseMoment, timecode } from "../moment.js";
import { withLibrary } from "../open.js";

/**
 * Which frame a video's thumbnail comes from (ADR-0024 stage 4).
 *
 * A verb here because ADR-0005 makes the headless CLI a first-class frontend:
 * every user-authored mutation has one, and the rebuild conformance test needs
 * a way to author a poster without a window.
 *
 * **The picture is not drawn here.** The moment is journalled and the derive is
 * queued; `roost thumb` is what works the queue, exactly as `import` and
 * `thumb` are separate commands. A command that redrew a thumbnail as a side
 * effect of recording a decision would be two verbs wearing one name.
 */
export async function poster(
  root: string,
  needle: string,
  at: string | undefined,
  clear: boolean,
  streams: Streams,
): Promise<number> {
  if (clear && at !== undefined) {
    return usage(streams, "poster", "--clear and --at ask for different things");
  }

  const moment = at === undefined ? null : parseMoment(at);
  if (moment === undefined) {
    return usage(streams, "poster", `${at} is not a moment — try 1:31.5, 91.5s, or 91500ms`);
  }

  return withLibrary(root, async (library) => {
    const hashes = resolveAll(library, [needle]);
    const hash = hashes[0];
    if (hash === undefined) throw new Error("resolveAll returned nothing for one argument");

    // Neither flag is a read: `roost poster <ASSET>` says where the thumbnail
    // is taken from, which is the only way to find out without looking at it.
    if (!clear && at === undefined) {
      const held = posterOf(library, hash);
      streams.out(
        held === null
          ? `${short(hash)} uses the default frame`
          : `${short(hash)} uses the frame at ${timecode(held)}`,
      );
      return EXIT.ok;
    }

    const changed = await setPoster(library, hash, moment);
    if (!changed) {
      streams.out(
        moment === null
          ? `${short(hash)} already uses the default frame`
          : `${short(hash)} already uses the frame at ${timecode(moment)}`,
      );
      return EXIT.ok;
    }

    streams.out(
      moment === null
        ? `${short(hash)} back to the default frame — run \`roost thumb\` to redraw it`
        : `${short(hash)} pinned to ${timecode(moment)} — run \`roost thumb\` to redraw it`,
    );
    return EXIT.ok;
  });
}
