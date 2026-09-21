import type { Checked } from "@roost/contract";
import { bad, ok } from "@roost/contract";
import { type AssetId, isAssetId } from "@roost/core";
import { THUMBNAIL_SIZES } from "@roost/media/serving";

/**
 * What a `roost://` URL asks for, once it has been proved to ask for anything.
 *
 * ADR-0008 gave the scheme two routes; M4 adds a third, for a document page
 * that is neither a stored thumbnail nor the file itself (`UI_SPEC.md` §7). Parsing is separated from
 * serving so that the rejections — a bad hash, an unknown size, a third route
 * nobody registered — can be asserted without an Electron process, and so that
 * `protocol.ts` stays a handler rather than a parser.
 */
export type Route =
  | { readonly kind: "thumb"; readonly id: AssetId; readonly size: ThumbSize }
  | { readonly kind: "file"; readonly id: AssetId }
  /**
   * A caption track, always answered as WebVTT (ADR-0025).
   *
   * A route of its own rather than `original`, because what comes back is a
   * *conversion*: `<track>` accepts WebVTT and nothing else, and the format
   * people have is SubRip. Serving the original bytes under a `text/vtt`
   * content type would be a lie that shows an empty track and no error.
   */
  | { readonly kind: "subtitle"; readonly id: AssetId }
  /**
   * A picture a browser can draw, for an asset whose own bytes are not one
   * (ADR-0040 §7).
   *
   * A route of its own for the same reason `subtitle` is: what comes back is a
   * rendition — HEIC assembled by libheif, a RAW's embedded JPEG, a TIFF
   * re-encoded — and an address that promises the file's bytes must hand back
   * the file's bytes.
   */
  | { readonly kind: "render"; readonly id: AssetId }
  | {
      readonly kind: "page";
      readonly id: AssetId;
      /** Zero-based, as the document backend counts. */
      readonly index: number;
      readonly width: PageWidth;
    };

/**
 * Widths a page may be rendered at.
 *
 * Fixed for the same reason a thumbnail size is: a free-form width would let a
 * renderer bug ask for a ten-thousand-pixel page, and rendering happens on the
 * process that draws the window.
 */
export const PAGE_WIDTHS = [512, 1024] as const;

export type PageWidth = (typeof PAGE_WIDTHS)[number];

/** How many pages a document may be asked for. A safety rail, not a format limit. */
export const MAX_PAGE_INDEX = 9999;

function isPageWidth(value: number): value is PageWidth {
  return (PAGE_WIDTHS as readonly number[]).includes(value);
}

export type ThumbSize = (typeof THUMBNAIL_SIZES)[number];

function isThumbSize(value: number): value is ThumbSize {
  return (THUMBNAIL_SIZES as readonly number[]).includes(value);
}

/**
 * Parses `roost://thumb/<id>@<size>` or `roost://file/<id>`.
 *
 * **The id is validated before anything touches the filesystem**, and
 * `isAssetId` accepts only twelve characters of Crockford base32 (RL-14) — so
 * `..`, a separator, and a percent-encoded one are all rejected as ids rather
 * than handled as traversal. That is the whole of the path safety here, and it
 * is why nothing below re-checks it.
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

  // The scheme is registered as standard, so `thumb` and `file` arrive as the
  // host and the rest as an absolute path.
  const rest = decodeURIComponent(parsed.pathname).replace(/^\//, "");

  if (parsed.host === "thumb") {
    const at = rest.lastIndexOf("@");
    if (at === -1) return bad("a thumbnail URL needs a @<size>");
    const id = rest.slice(0, at);
    if (!isAssetId(id)) return bad("not an asset id");
    const size = Number(rest.slice(at + 1));
    if (!isThumbSize(size)) return bad(`no such thumbnail size: ${rest.slice(at + 1)}`);
    return ok({ kind: "thumb", id, size });
  }

  if (parsed.host === "page") {
    // `<id>/<index>@<width>`: the page is part of the path because it is part
    // of what is being addressed, and the width is a rendering choice, spelled
    // the way a thumbnail's size is.
    const at = rest.lastIndexOf("@");
    if (at === -1) return bad("a page URL needs a @<width>");
    const slash = rest.indexOf("/");
    if (slash === -1) return bad("a page URL needs a page number");

    const id = rest.slice(0, slash);
    if (!isAssetId(id)) return bad("not an asset id");

    const index = Number(rest.slice(slash + 1, at));
    if (!Number.isInteger(index) || index < 0 || index > MAX_PAGE_INDEX) {
      return bad(`no such page: ${rest.slice(slash + 1, at)}`);
    }

    const width = Number(rest.slice(at + 1));
    if (!isPageWidth(width)) return bad(`no such page width: ${rest.slice(at + 1)}`);

    return ok({ kind: "page", id, index, width });
  }

  // `file` rather than version 1's `original`: there are no originals any
  // more, only the asset's file, which the person is free to edit (RL-20).
  if (parsed.host === "file") {
    if (!isAssetId(rest)) return bad("not an asset id");
    return ok({ kind: "file", id: rest });
  }

  if (parsed.host === "subtitle") {
    if (!isAssetId(rest)) return bad("not an asset id");
    return ok({ kind: "subtitle", id: rest });
  }

  if (parsed.host === "render") {
    if (!isAssetId(rest)) return bad("not an asset id");
    return ok({ kind: "render", id: rest });
  }

  return bad(`no such route: ${parsed.host}`);
}
