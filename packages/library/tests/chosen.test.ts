import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetId } from "@roost/core";
import {
  chooseThumbnail,
  chosenThumbnails,
  clearThumbnail,
  ensurePreview,
  importInto,
  Library,
  NotAPictureError,
  queueStatus,
  redrawPoster,
  refreshAsset,
  runDerives,
  transferAssets,
  UnknownAssetError,
} from "@roost/library";
import { GRID_SIZE, gradient, PREVIEW_SIZE } from "@roost/media";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Thumbnails somebody chose (ADR-0060): drawn from an image they supply, kept
 * in `thumbs/` and nowhere else, and never drawn over.
 */
describe("a thumbnail somebody chose", () => {
  let dir: string;
  let incoming: string;
  let library: Library;
  /** The image offered as a thumbnail, outside the library. */
  let image: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-chosen-"));
    incoming = join(dir, "incoming");
    await mkdir(incoming, { recursive: true });
    image = join(dir, "cover.png");
    await writeFile(image, await gradient(300, 200, 99, "png"));
    library = await Library.create(join(dir, "Chosen.roost"), "Chosen");
  });

  afterEach(async () => {
    await library.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Imports one file into `library` and answers its id. */
  async function file(into: Library, name: string, bytes: Uint8Array | string): Promise<AssetId> {
    const path = join(incoming, name);
    await writeFile(path, bytes);
    const report = await importInto(into, [path]);
    await rm(path, { force: true });
    const id = report.importedIds[0];
    if (id === undefined) throw new Error(`${name} was not imported`);
    return id;
  }

  const picture = (id: AssetId, size = GRID_SIZE): string | undefined =>
    library.db.repo.thumbnail(id, size)?.toString("base64");

  it("gives a file nothing can draw a picture, and its badge goes", async () => {
    const archive = await file(library, "backup.zip", "PK not really an archive");
    await runDerives(library, { sizes: [GRID_SIZE] });
    expect(library.db.repo.stalledReasons("derive", [archive]).get(archive)).toMatch(
      /^unsupported:/,
    );

    const redrawn = await chooseThumbnail(library, [archive], image);

    expect(redrawn).toEqual([
      { id: archive, derivedAt: expect.any(Number), undrawn: null, chosen: true },
    ]);
    // Both sizes every asset has, so nothing is ever drawn from the file to fill
    // a gap beside them.
    expect(picture(archive, GRID_SIZE)).toBeDefined();
    expect(picture(archive, PREVIEW_SIZE)).toBeDefined();
    expect(library.db.repo.stalledReasons("derive", [archive]).size).toBe(0);
    expect(chosenThumbnails(library, [archive]).has(archive)).toBe(true);
    // Nothing journalled: the user chose `thumbs/` as its only home.
    expect(library.db.repo.assetDetail(archive)?.derivedAt).toBe(redrawn[0]?.derivedAt);
  });

  it("keeps the picture when the file changes, and measures the file again", async () => {
    const photo = await file(library, "photo.png", await gradient(120, 90, 1, "png"));
    await runDerives(library, { sizes: [GRID_SIZE] });
    await chooseThumbnail(library, [photo], image);
    const chosen = picture(photo);

    // Saved over by another application, and noticed (ADR-0047).
    const detail = library.db.repo.assetDetail(photo);
    const path = library.storage.locate(photo, detail?.ext ?? "png");
    await writeFile(path, await gradient(200, 100, 7, "png"));
    await refreshAsset(library, photo);
    // Still there between the notice and the derive: nothing dropped it.
    expect(picture(photo)).toBe(chosen);

    const report = await runDerives(library, { sizes: [GRID_SIZE] });

    expect(report.kept).toBe(1);
    expect(picture(photo)).toBe(chosen);
    const measured = library.db.repo.assetDetail(photo);
    expect([measured?.width, measured?.height]).toEqual([200, 100]);
    expect(library.db.repo.pictureSource(photo)?.chosen).toBe(true);

    // And the next pass keeps it without measuring anything again.
    await refreshAsset(library, photo);
    expect(queueStatus(library).ready).toBe(0);
  });

  it("is not drawn over by a frame, nor filled in from the file", async () => {
    const photo = await file(library, "photo.png", await gradient(120, 90, 2, "png"));
    await runDerives(library, { sizes: [GRID_SIZE] });
    await chooseThumbnail(library, [photo], image);
    const chosen = [picture(photo, GRID_SIZE), picture(photo, PREVIEW_SIZE)];

    expect(await redrawPoster(library, photo)).toBe(true);
    library.db.repo.dropThumbnail(photo, PREVIEW_SIZE);
    expect(await ensurePreview(library, photo)).toBe(true);

    expect([picture(photo, GRID_SIZE), picture(photo, PREVIEW_SIZE)]).toEqual(chosen);
  });

  it("gives the file its own picture back", async () => {
    const photo = await file(library, "photo.png", await gradient(120, 90, 3, "png"));
    await runDerives(library, { sizes: [GRID_SIZE] });
    const own = picture(photo);
    await chooseThumbnail(library, [photo], image);
    expect(picture(photo)).not.toBe(own);

    const cleared = clearThumbnail(library, [photo]);
    // A new address at once: the old one is cached `immutable`, and would go
    // on showing the removed picture (found in a window, 2026-10-05).
    expect(cleared).toEqual([
      { id: photo, derivedAt: expect.any(Number), undrawn: null, chosen: false },
    ]);
    expect(library.db.repo.assetDetail(photo)?.derivedAt).toBe(cleared[0]?.derivedAt);
    expect(picture(photo)).toBeUndefined();
    expect(queueStatus(library).ready).toBe(1);

    await runDerives(library, { sizes: [GRID_SIZE] });
    expect(picture(photo)).toBe(own);
    // Asked again, nothing to give back.
    expect(clearThumbnail(library, [photo])).toEqual([]);
  });

  it("outlives a rebuild, which keeps thumbs/ (ADR-0051)", async () => {
    const archive = await file(library, "backup.zip", "PK not really an archive");
    await runDerives(library, { sizes: [GRID_SIZE] });
    await chooseThumbnail(library, [archive], image);
    const chosen = picture(archive);

    await library.rebuild();
    await runDerives(library, { sizes: [GRID_SIZE] });

    expect(picture(archive)).toBe(chosen);
    expect(library.db.repo.stalledReasons("derive", [archive]).size).toBe(0);
  });

  it("refuses an image nothing can draw, and changes nothing", async () => {
    const photo = await file(library, "photo.png", await gradient(120, 90, 4, "png"));
    await runDerives(library, { sizes: [GRID_SIZE] });
    const own = picture(photo);
    const text = join(dir, "notes.txt");
    await writeFile(text, "not a picture");

    await expect(chooseThumbnail(library, [photo], text)).rejects.toBeInstanceOf(NotAPictureError);
    await expect(
      chooseThumbnail(library, ["ZZZZZZZZZZZZ" as AssetId], image),
    ).rejects.toBeInstanceOf(UnknownAssetError);
    expect(picture(photo)).toBe(own);
    expect(chosenThumbnails(library, [photo]).size).toBe(0);
  });

  it("travels with its asset to another library (ADR-0060 §3.6)", async () => {
    const target = await Library.create(join(dir, "Target.roost"), "Target");
    try {
      const archive = await file(library, "backup.zip", "PK not really an archive");
      await chooseThumbnail(library, [archive], image);
      const chosen = picture(archive);

      await transferAssets(library, target, [archive], { take: "copy" });

      const [arrived] = target.db.repo.allIds();
      if (arrived === undefined) throw new Error("nothing arrived");
      expect(target.db.repo.thumbnail(arrived, GRID_SIZE)?.toString("base64")).toBe(chosen);
      expect(chosenThumbnails(target, [arrived]).has(arrived)).toBe(true);
      // The target's own derive measures the file and keeps the picture.
      await runDerives(target, { sizes: [GRID_SIZE] });
      expect(target.db.repo.thumbnail(arrived, GRID_SIZE)?.toString("base64")).toBe(chosen);
      expect(target.db.repo.stalledReasons("derive", [arrived]).size).toBe(0);
    } finally {
      await target.close();
    }
  });
});
