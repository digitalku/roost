import { attachSubtitle, detachSubtitle, subtitles as tracksOf } from "@roost/library";
import { resolveAll, short } from "../assets.js";
import { EXIT, type Streams, usage } from "../io.js";
import { withLibrary } from "../open.js";

/**
 * Which subtitle captions which video (ADR-0025).
 *
 * A verb here because ADR-0005 makes the headless CLI a first-class frontend:
 * the attachment is user-authored state, so it must be writable without a
 * window — and the rebuild conformance test needs a way to author one.
 *
 * Import finds a subtitle sitting beside its film on its own; this is for the
 * rest, where the two arrived by different routes or under different names.
 */
export async function subtitle(
  root: string,
  needle: string | undefined,
  track: string | undefined,
  options: { readonly detach: boolean; readonly lang: string | undefined },
  streams: Streams,
): Promise<number> {
  if (needle === undefined) return usage(streams, "subtitle", "subtitle needs an asset");
  if (options.detach && track === undefined) {
    return usage(streams, "subtitle", "--detach needs the track to detach");
  }

  return withLibrary(root, async (library) => {
    const [hash] = resolveAll(library, [needle]);
    if (hash === undefined) throw new Error("resolveAll returned nothing for one argument");

    // Neither a flag nor a track is a read: `roost subtitle <ASSET>` lists what
    // is attached, which is the only way to find out without a window.
    if (track === undefined) {
      const attached = tracksOf(library, hash);
      if (attached.length === 0) {
        streams.out(`${short(hash)} has no subtitles`);
        return EXIT.ok;
      }
      for (const row of attached) {
        const language = row.lang === null ? "" : ` [${row.lang}]`;
        streams.out(`${short(row.trackId)}  ${row.label ?? row.name}${language}`);
      }
      return EXIT.ok;
    }

    const [trackId] = resolveAll(library, [track]);
    if (trackId === undefined) throw new Error("resolveAll returned nothing for one argument");

    if (options.detach) {
      await detachSubtitle(library, hash, trackId);
      streams.out(`${short(trackId)} no longer captions ${short(hash)}`);
      return EXIT.ok;
    }

    await attachSubtitle(
      library,
      hash,
      trackId,
      options.lang === undefined ? {} : { lang: options.lang },
    );
    streams.out(`${short(trackId)} captions ${short(hash)}`);
    return EXIT.ok;
  });
}
