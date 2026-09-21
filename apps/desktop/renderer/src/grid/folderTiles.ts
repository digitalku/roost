/**
 * The folders drawn among the thumbnails (ADR-0043).
 *
 * A folder tile is a **control, not a result**: it is not paged, not selected,
 * not swept by the marquee, and not counted in what the grid says it is
 * showing. What it shares with an asset cell is the layout — it is laid out by
 * the same arithmetic, ahead of the first page — and that is why it needs an id
 * that can travel through `layout()` and `SelectionStore` beside a id.
 *
 * The prefix is safe against a collision by construction: an asset is addressed
 * by its BLAKE3 digest, which is 64 hexadecimal characters, so no id begins
 * with a letter outside `a`–`f` and none of them can spell this.
 */

/** What the tile carries, which is everything `FolderCell` draws. */
export interface GridFolder {
  readonly folder: number;
  readonly name: string;
  /** How many assets the row's own query finds, or `null` where none was counted. */
  readonly count: number | null;
  /** The query that opens it — the engine's, never assembled here. */
  readonly query: string;
}

const PREFIX = "folder-";

export function folderTileId(folder: number): string {
  return `${PREFIX}${folder}`;
}

export function isFolderTile(id: string): boolean {
  return id.startsWith(PREFIX);
}

/** The folder a tile id names, or `undefined` for an asset's id. */
export function folderIdOf(id: string): number | undefined {
  if (!isFolderTile(id)) return undefined;
  const parsed = Number.parseInt(id.slice(PREFIX.length), 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
