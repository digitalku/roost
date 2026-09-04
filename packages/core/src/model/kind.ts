/**
 * What an asset broadly is, decided from magic bytes rather than from the
 * extension (`ARCHITECTURE.md` §5). It selects the preview and the thumbnail
 * strategy; it is not a format.
 *
 * `other` is not a failure. A format Roost cannot draw still imports, still
 * carries tags, and still opens in the application that owns it.
 *
 * **There is deliberately no `text`.** One was added on 2026-09-03 and withdrawn
 * on 2026-09-04: showing a text file in the pane means owning an editor to go
 * with it, and the user's answer was that an external editor is enough. A `.txt`
 * is `other`, and `other` opens in the application that owns it.
 */
export const KINDS = ["image", "video", "audio", "document", "font", "other"] as const;

export type Kind = (typeof KINDS)[number];

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}
