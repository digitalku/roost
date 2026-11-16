import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Library } from "../src/index.js";

/**
 * ADR-0066: the view menu remembered per place, All assets' at the top level of
 * `settings.json` and Recent's and the folders' under `placeViews`.
 */
describe("a view for each kind of place", () => {
  let dir: string;
  let root: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-place-views-"));
    root = join(dir, "library");
    await (await Library.create(root, "test")).close();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const raw = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(root, "settings.json"), "utf8"));

  it("keeps each place's change to itself, across a reopen", async () => {
    const library = await Library.open(root);
    await library.updateView("folders", { gridView: "compact", sortKey: "name" });
    await library.updateView("recent", { gridView: "details" });
    await library.close();

    const again = await Library.open(root);
    try {
      expect(again.settings.gridView).toBe("icons");
      expect(again.settings.sortKey).toBe("added");
      expect(again.settings.placeViews.folders).toMatchObject({
        gridView: "compact",
        sortKey: "name",
      });
      expect(again.settings.placeViews.recent).toMatchObject({
        gridView: "details",
        sortKey: "added",
      });
    } finally {
      await again.close();
    }
  });

  it("writes every set on the first change, so an untouched one stops following All assets", async () => {
    // Without this, a set the file does not hold reads as All assets' look, and
    // changing All assets would change every folder with it.
    await writeFile(join(root, "settings.json"), '{ "gridView": "details" }\n', "utf8");
    const library = await Library.open(root);
    try {
      await library.updateView("all", { gridView: "compact" });
      const written = await raw();
      expect(written["gridView"]).toBe("compact");
      expect(written["placeViews"]).toMatchObject({
        recent: { gridView: "details" },
        folders: { gridView: "details" },
      });
      expect(library.settings.placeViews.folders.gridView).toBe("details");
    } finally {
      await library.close();
    }
  });

  it("writes nothing on a read", async () => {
    // ADR-0019: a library opened and closed without a change keeps its file.
    await (await Library.open(root)).close();
    await expect(readFile(join(root, "settings.json"), "utf8")).rejects.toThrow();
  });
});
