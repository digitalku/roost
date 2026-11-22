import type {
  OwnViewPlace,
  SidebarFolderRow,
  SidebarRow,
  ViewPlace,
  WirePlaceView,
  WireSettings,
} from "@roost/contract";

/**
 * Which view menu a place uses (ADR-0066): All assets', Recent's, or the one
 * every folder shares.
 *
 * Decided by comparing the **place** with the queries the engine sent for the
 * sidebar's rows, as `inTrash` and `openFolder` are, and never by reading a
 * term here: the renderer assembles no RQL (`UI_SPEC.md` §4.1). Everything
 * that is neither Recent nor a folder — No folder, Untagged, Trash, a smart
 * folder, a rating, a search — is All assets, because each is a cut of the
 * whole library.
 *
 * The place, not the query: a folder with a tag ticked in the filter bar is
 * still a folder.
 */
export function placeOf(
  place: string,
  rows:
    | {
        readonly places: readonly SidebarRow[];
        readonly folders: readonly SidebarFolderRow[];
      }
    | undefined,
): ViewPlace {
  if (place === "" || rows === undefined) return "all";
  if (rows.places.some((row) => row.id === "recent" && row.query === place)) return "recent";
  if (rows.folders.some((row) => row.query === place)) return "folders";
  return "all";
}

/** The view menu's six for one place. All assets' are the top-level keys. */
export function viewOf(settings: WireSettings, place: ViewPlace): WirePlaceView {
  if (place !== "all") return settings.placeViews[place];
  return {
    gridView: settings.gridView,
    matchImageProportions: settings.matchImageProportions,
    gridZooms: settings.gridZooms,
    showFolders: settings.showFolders,
    sortKey: settings.sortKey,
    sortDescending: settings.sortDescending,
  };
}

/**
 * `settings` with one place's view changed, as the engine will hold it once
 * the write lands — drawn first so the grid does not wait a round trip.
 */
export function withView(
  settings: WireSettings,
  place: ViewPlace,
  patch: Partial<WirePlaceView>,
): WireSettings {
  if (place === "all") return { ...settings, ...patch };
  return {
    ...settings,
    placeViews: {
      ...settings.placeViews,
      [place]: { ...settings.placeViews[place], ...patch },
    },
  };
}

/**
 * The sets a library has before any of them was changed: All assets' look, in
 * the library's default order (ADR-0066 §3.5), which is what the engine reads
 * for a set `settings.json` does not hold.
 */
export function seededPlaceViews(
  all: Omit<WireSettings, "placeViews">,
): Readonly<Record<OwnViewPlace, WirePlaceView>> {
  const seed: WirePlaceView = {
    gridView: all.gridView,
    matchImageProportions: all.matchImageProportions,
    gridZooms: all.gridZooms,
    showFolders: all.showFolders,
    sortKey: "added",
    sortDescending: true,
  };
  return { recent: seed, folders: seed };
}
