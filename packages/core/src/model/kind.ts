/**
 * What an asset broadly is, decided from magic bytes rather than from the
 * extension (`ARCHITECTURE.md` §5). It selects the preview and the thumbnail
 * strategy; it is not a format.
 *
 * `other` is not a failure. A format Roost cannot draw still imports, still
 * carries tags, and still opens in the application that owns it.
 *
 * **`text` is Markdown and plain text** (ADR-0070), shown and edited in the
 * pane. It was added on 2026-09-03 and withdrawn the next day, when a save still
 * made a new asset; ADR-0046 made a save a write, and the owner asked again.
 */
export const KINDS = ["image", "video", "audio", "document", "font", "text", "other"] as const;

export type Kind = (typeof KINDS)[number];

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}
