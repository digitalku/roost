/**
 * What an asset broadly is, decided from magic bytes rather than from the
 * extension (`ARCHITECTURE.md` §5). It selects the preview and the thumbnail
 * strategy; it is not a format.
 *
 * `other` is not a failure. A format Roost cannot draw still imports, still
 * carries tags, and still opens in the application that owns it.
 */
export const KINDS = ["image", "video", "audio", "document", "font", "other"] as const;

export type Kind = (typeof KINDS)[number];

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}
