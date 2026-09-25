import type { SidebarFolderRow } from "@roost/contract";
import { useEffect, useState } from "react";
import { invoke } from "../bridge.js";
import { gridSrc } from "../thumbnail.js";

/**
 * The pictures each folder tile on screen draws (ADR-0043 §7).
 *
 * Asked once per list of rows. The list is the sidebar's, and the sidebar is
 * read again whenever the library changes — an import, a derive run finishing,
 * an asset filed or trashed — so a cover follows the same signal every count
 * in the window does, and never a timer. What comes back is addresses:
 * `roost://thumb/<id>@256` with the cache key a re-derive moves (ADR-0047).
 */
export function useFolderCovers(
  rows: readonly SidebarFolderRow[] | undefined,
): ReadonlyMap<number, readonly string[]> {
  const [covers, setCovers] = useState<ReadonlyMap<number, readonly string[]>>(EMPTY);

  useEffect(() => {
    const folders = (rows ?? []).map((row) => row.folder);
    if (folders.length === 0) {
      setCovers(EMPTY);
      return;
    }
    let current = true;
    void (async () => {
      // A failed read leaves the sheets empty rather than saying anything: a
      // cover is decoration on a control that works without it. `invoke` throws
      // outright where there is no bridge at all, hence the `try`.
      try {
        const outcome = await invoke({ type: "folder:covers", folders });
        if (!current || !outcome.ok) return;
        setCovers(
          new Map(
            outcome.value.map((cover) => [
              cover.folder,
              cover.assets.map((asset) => gridSrc(asset.id, asset.posterMs, asset.derivedAt)),
            ]),
          ),
        );
      } catch {
        // No engine to ask; nothing to draw.
      }
    })();
    return () => {
      current = false;
    };
  }, [rows]);

  return covers;
}

const EMPTY: ReadonlyMap<number, readonly string[]> = new Map();
