import type { Checked } from "@roost/contract";
import { bad, ok } from "@roost/contract";
import { type ContentHash, isContentHash } from "@roost/core";
import { THUMBNAIL_SIZES } from "@roost/media/serving";

/**
 * What a `roost://` URL asks for, once it has been proved to ask for anything.
 *
 * ADR-0008 gives the scheme two routes and no others. Parsing is separated from
 * serving so that the rejections — a bad hash, an unknown size, a third route
 * nobody registered — can be asserted without an Electron process, and so that
 * `protocol.ts` stays a handler rather than a parser.
 */
export type Route =
  | { readonly kind: "thumb"; readonly hash: ContentHash; readonly size: ThumbSize }
  | { readonly kind: "original"; readonly hash: ContentHash };

export type ThumbSize = (typeof THUMBNAIL_SIZES)[number];

function isThumbSize(value: number): value is ThumbSize {
  return (THUMBNAIL_SIZES as readonly number[]).includes(value);
}

/**
 * Parses `roost://thumb/<hash>@<size>` or `roost://original/<hash>`.
 *
 * **The hash is validated before anything touches the filesystem**, and
 * `isContentHash` accepts only 64 lowercase hex characters — so `..`, a
 * separator, and a percent-encoded one are all rejected as hashes rather than
 * handled as traversal. That is the whole of the path safety here, and it is
 * why nothing below re-checks it.
 *
 * The size is not free-form. Serving `@37` would mean generating a thumbnail
 * nobody stored, on main's thread, for a URL a renderer bug could mint by the
 * thousand; the two sizes the schema's `thumbs.size` column expects are the two
 * this answers.
 */
export function parseRoostUrl(url: string): Checked<Route> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return bad("not a URL");
  }
  if (parsed.protocol !== "roost:") return bad(`expected roost:, got ${parsed.protocol}`);

  // The scheme is registered as standard, so `thumb` and `original` arrive as
  // the host and the rest as an absolute path.
  const rest = decodeURIComponent(parsed.pathname).replace(/^\//, "");

  if (parsed.host === "thumb") {
    const at = rest.lastIndexOf("@");
    if (at === -1) return bad("a thumbnail URL needs a @<size>");
    const hash = rest.slice(0, at);
    if (!isContentHash(hash)) return bad("not a content hash");
    const size = Number(rest.slice(at + 1));
    if (!isThumbSize(size)) return bad(`no such thumbnail size: ${rest.slice(at + 1)}`);
    return ok({ kind: "thumb", hash, size });
  }

  if (parsed.host === "original") {
    if (!isContentHash(rest)) return bad("not a content hash");
    return ok({ kind: "original", hash: rest });
  }

  return bad(`no such route: ${parsed.host}`);
}
