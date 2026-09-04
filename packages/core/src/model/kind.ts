/**
 * What an asset broadly is, decided from magic bytes rather than from the
 * extension (`ARCHITECTURE.md` §5). It selects the preview and the thumbnail
 * strategy; it is not a format.
 *
 * `other` is not a failure. A format Roost cannot draw still imports, still
 * carries tags, and still opens in the application that owns it.
 *
 * `text` is the one kind with no signature to sniff for — it is decided by what
 * the bytes are *not* (ADR-0026 §Stages). It exists because Roost shows a text
 * file itself rather than handing it to another application, which is also what
 * a subtitle needs (ADR-0025).
 */
export const KINDS = ["image", "video", "audio", "document", "font", "text", "other"] as const;

export type Kind = (typeof KINDS)[number];

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}
