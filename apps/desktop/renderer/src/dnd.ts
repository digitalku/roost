import type { HandoffCost } from "@roost/contract";

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

/** Tag names, as JSON: the tags chosen on the tags page, onto a group (ADR-0061). */
export const TAG_DRAG_TYPE = "application/x-roost-tags";

/**
 * The assets this window is dragging **out**, while it is (ADR-0034 §4).
 *
 * A drag that can leave the window is a native one, and a native drag carries
 * `Files` and nothing of Roost's own, even when it is dropped back on the
 * window that started it. It is how the grid drags, so a folder row has to
 * take one. This is what tells it which assets those files are: the ids the
 * window asked to drag, remembered from `dragstart` until main says the drag
 * has ended. The paths it carries are staged copies and name nothing in the
 * library, so they are never read back.
 *
 * Module state rather than React state, because a `dragover` reads it
 * dozens of times a second and nothing is drawn from it.
 */
let outgoing: readonly string[] | undefined;

/** The window has started dragging these out. */
export function dragOutStarted(ids: readonly string[]): void {
  outgoing = ids;
}

/** Main says the drag has ended, dropped or abandoned. */
export function dragOutEnded(): void {
  outgoing = undefined;
}

/**
 * Whether a drag carrying `Files` is this window's own, which `DropZone`
 * must not offer to import: dropping a selection back onto the grid would
 * otherwise import the staged copies of it.
 */
export function isOwnDrag(transfer: DataTransfer | null): boolean {
  return outgoing !== undefined && transfer !== null && [...transfer.types].includes("Files");
}

/** Whether this drag is assets, decided from the types alone. */
export function carriesAssets(transfer: DataTransfer | null): boolean {
  return (
    transfer !== null && ([...transfer.types].includes(ASSET_DRAG_TYPE) || isOwnDrag(transfer))
  );
}

/**
 * What a folder's `dragover` should say the drop will do.
 *
 * A drag inside the window allows both and the key decides. **A drag going
 * out allows only a copy**: that is what `startDrag` offers the desktop, and a
 * target that answered `move` would have the drop refused. Nothing is lost by
 * it. Whether a drop onto a folder moves is decided by what is on screen
 * (ADR-0033 §5.1), never by this, so the only difference is the cursor.
 */
export function dropEffectFor(transfer: DataTransfer, copy: boolean): "copy" | "move" {
  if (![...transfer.types].includes(ASSET_DRAG_TYPE)) return "copy";
  return copy ? "copy" : "move";
}

/**
 * The most a drag out may copy on a filesystem that cannot clone a file
 * (ADR-0034 §4). About two seconds of an ordinary disk: past it, the hand holds
 * a drag that does not move while the copies are written.
 */
export const DRAG_OUT_BUDGET = 200 * 1024 * 1024;

/**
 * Whether a drag of these assets can go out as files, or stays inside the
 * window, and how much it would have copied if not.
 *
 * Decided in `dragstart`, synchronously, from what the window already holds:
 * whether a copy is free here, and each asset's size. **A size not yet known
 * counts against the drag**, because a file nobody has read yet may be any
 * size at all. `bytes` is `null` when that is the reason.
 */
export function dragGoesOut(
  cost: HandoffCost,
  sizes: readonly (number | null | undefined)[],
): { readonly out: true } | { readonly out: false; readonly bytes: number | null } {
  if (cost === "free") return { out: true };
  let bytes = 0;
  for (const size of sizes) {
    if (size === null || size === undefined) return { out: false, bytes: null };
    bytes += size;
  }
  return bytes <= DRAG_OUT_BUDGET ? { out: true } : { out: false, bytes };
}

/**
 * Starts the drag of one asset from a picture of it, as a cell's drag does
 * (ADR-0034 §7).
 *
 * Out of the window as a file where `out` allows, in which case this drag is
 * cancelled and main starts a native one in its place. Otherwise it stays
 * inside the window carrying the id, so a folder in the sidebar takes it.
 */
export function dragOneAsset(
  event: React.DragEvent,
  id: string,
  out: ((ids: readonly string[]) => boolean) | undefined,
): void {
  if (out?.([id]) === true) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify([id]));
  event.dataTransfer.effectAllowed = "copyMove";
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
  if (outgoing !== undefined && !transfer.types.includes(ASSET_DRAG_TYPE)) {
    return isOwnDrag(transfer) ? outgoing : [];
  }
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
