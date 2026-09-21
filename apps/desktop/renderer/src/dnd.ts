/**
 * What a drag inside the window carries (`UI_SPEC.md` §4.3).
 *
 * Two media types of Roost's own, and the reason they are Roost's own is
 * `DropZone`: the import overlay appears whenever a drag carries `Files`, which
 * is what a drag *from the desktop* carries and what a drag between two parts of
 * this window never does. Neither has to know about the other.
 *
 * **A `dragover` cannot read the data, only the types** — the browser withholds
 * the payload until the drop, so a target has to decide whether it will accept
 * a drag from the type list alone. That is why each of these is a pair.
 */

/** Content ids, as JSON. The selection, not the cell under the pointer. */
export const ASSET_DRAG_TYPE = "application/x-roost-assets";

/** One folder id, as text. A folder is dragged alone; there is no multi-select. */
export const FOLDER_DRAG_TYPE = "application/x-roost-folder";

/** Whether this drag is assets, decided from the types alone. */
export function carriesAssets(transfer: DataTransfer | null): boolean {
  return transfer !== null && [...transfer.types].includes(ASSET_DRAG_TYPE);
}

export function carriesFolder(transfer: DataTransfer | null): boolean {
  return transfer !== null && [...transfer.types].includes(FOLDER_DRAG_TYPE);
}

/**
 * The ids a drop is carrying, or none.
 *
 * Parsed defensively: `dataTransfer` is a channel anything on the page can
 * write to, and a payload that is not an array of strings is a drag this window
 * did not start.
 */
export function draggedAssets(transfer: DataTransfer | null): readonly string[] {
  if (transfer === null) return [];
  try {
    const parsed: unknown = JSON.parse(transfer.getData(ASSET_DRAG_TYPE));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/** The folder a drop is carrying, or `undefined` if it is not carrying one. */
export function draggedFolder(transfer: DataTransfer | null): number | undefined {
  if (transfer === null) return undefined;
  const folder = Number(transfer.getData(FOLDER_DRAG_TYPE));
  return Number.isSafeInteger(folder) && folder > 0 ? folder : undefined;
}
