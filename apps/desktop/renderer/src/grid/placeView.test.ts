import type { SidebarFolderRow, SidebarRow, WireSettings } from "@roost/contract";
import { describe, expect, it } from "vitest";
import { placeOf, seededPlaceViews, viewOf, withView } from "./placeView.js";

const row = (id: string, query: string): SidebarRow => ({
  id,
  name: id,
  query,
  count: null,
  depth: 0,
  stars: null,
  group: null,
});

const folder = (id: number, path: string): SidebarFolderRow => ({
  ...row(`folder-${id}`, `infolder:"${path}"`),
  folder: id,
  path,
});

const SIDEBAR = {
  places: [
    row("all", ""),
    row("recent", "imported:>2026-11-10"),
    row("untagged", "is:untagged"),
    row("trash", "is:trashed"),
  ],
  folders: [folder(1, "Design"), folder(2, "Design/Icons")],
};

const BASE: Omit<WireSettings, "placeViews"> = {
  showSubfolderContents: false,
  fitVideoToWindow: false,
  mediaVolume: 100,
  mediaMuted: false,
  sortKey: "name",
  sortDescending: false,
  gridView: "details",
  matchImageProportions: false,
  gridZooms: { details: 60 },
  showFolders: true,
  showSidebar: true,
  showInspector: true,
  sidebarWidth: 240,
  inspectorWidth: 280,
  handOutByName: true,
};
const SETTINGS: WireSettings = { ...BASE, placeViews: seededPlaceViews(BASE) };

describe("which view menu a place uses (ADR-0066)", () => {
  it("names All assets, Recent and every folder", () => {
    expect(placeOf("", SIDEBAR)).toBe("all");
    expect(placeOf("imported:>2026-11-10", SIDEBAR)).toBe("recent");
    expect(placeOf('infolder:"Design"', SIDEBAR)).toBe("folders");
    expect(placeOf('infolder:"Design/Icons"', SIDEBAR)).toBe("folders");
  });

  it("puts every other place with All assets", () => {
    // Untagged, Trash, a smart folder, a rating, a search: each a cut of the
    // whole library, at the user's choosing.
    for (const place of ["is:untagged", "is:trashed", "rating:5", "olahraga", "tag:x"]) {
      expect(placeOf(place, SIDEBAR)).toBe("all");
    }
  });

  it("is All assets until the sidebar has arrived", () => {
    expect(placeOf('infolder:"Design"', undefined)).toBe("all");
  });
});

describe("one place's settings", () => {
  it("reads All assets from the top level", () => {
    expect(viewOf(SETTINGS, "all")).toEqual({
      gridView: "details",
      matchImageProportions: false,
      gridZooms: { details: 60 },
      showFolders: true,
      sortKey: "name",
      sortDescending: false,
    });
  });

  it("seeds the others with All assets' look and the default order", () => {
    // ADR-0066 §3.5: the grid looks as it did on the first open, and every
    // place starts in Date added, newest first, until it is changed there.
    expect(viewOf(SETTINGS, "folders")).toEqual({
      gridView: "details",
      matchImageProportions: false,
      gridZooms: { details: 60 },
      showFolders: true,
      sortKey: "added",
      sortDescending: true,
    });
  });

  it("changes one place and leaves the others", () => {
    const changed = withView(SETTINGS, "folders", { gridView: "compact" });
    expect(viewOf(changed, "folders").gridView).toBe("compact");
    expect(viewOf(changed, "recent").gridView).toBe("details");
    expect(viewOf(changed, "all").gridView).toBe("details");

    const all = withView(SETTINGS, "all", { sortKey: "size" });
    expect(viewOf(all, "all").sortKey).toBe("size");
    expect(viewOf(all, "recent").sortKey).toBe("added");
  });
});
