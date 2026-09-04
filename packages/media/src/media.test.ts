import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decoderVersions, isRenderable, sniff } from "./index.js";
import { probe } from "./probe.js";
import { gradient, gradientPixels, SYNTHETIC_FORMATS } from "./synth.js";
import { GRID_SIZE, generateThumbnails, PREVIEW_SIZE } from "./thumbnail.js";

describe("probing a real file", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-media-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (name: string, bytes: Buffer | Uint8Array): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, bytes);
    return path;
  };

  it.each(SYNTHETIC_FORMATS)("reads %s back as what it is, with its dimensions", async (format) => {
    const path = await write(`sample.${format}`, await gradient(320, 200, 7, format));
    expect(await probe(path)).toEqual({
      format,
      kind: "image",
      width: 320,
      height: 200,
    });
  });

  it("believes the bytes over the extension, on a real file", () => {
    // The unit test proves the sniffer; this proves nothing between it and the
    // filesystem quietly re-reads the name.
    return (async () => {
      const path = await write("actually-a-png.jpg", await gradient(64, 48, 1, "png"));
      expect((await probe(path)).format).toBe("png");
    })();
  });

  it("reports an unrenderable format without dimensions and without complaint", async () => {
    const path = await write("doc.pdf", Buffer.from("%PDF-1.7\nnot really a pdf\n"));
    expect(await probe(path)).toEqual({ format: "pdf", kind: "document" });
  });

  it("survives a file too short to carry any signature", async () => {
    const path = await write("tiny.bin", Buffer.from([0x00, 0x01]));
    expect(await probe(path)).toEqual({ format: "unknown", kind: "other" });
  });
});

describe("generating thumbnails", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-thumb-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sample = async (
    name: string,
    width: number,
    height: number,
    format: "png" | "jpeg" = "png",
  ): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, await gradient(width, height, 3, format));
    return path;
  };

  it("writes WebP at both sizes, fitted inside the longest edge", async () => {
    const path = await sample("wide.png", 1200, 800);
    const thumbs = await generateThumbnails(path, [GRID_SIZE, PREVIEW_SIZE]);

    expect(thumbs.map((t) => t.size)).toEqual([PREVIEW_SIZE, GRID_SIZE]);
    for (const thumb of thumbs) {
      expect(Math.max(thumb.width, thumb.height)).toBe(thumb.size);
      // 3:2 in, 3:2 out.
      expect(thumb.width / thumb.height).toBeCloseTo(1200 / 800, 1);
      expect(sniff(thumb.data)).toBe("webp");
      expect(thumb.data.length).toBeGreaterThan(0);
    }
  });

  it("never enlarges an image smaller than the requested size", async () => {
    // Upscaling would inflate the BLOB while adding no detail, and would make a
    // 64px icon claim to be a 256px thumbnail.
    const path = await sample("icon.png", 64, 64);
    const [thumb] = await generateThumbnails(path, [GRID_SIZE]);
    expect(thumb?.width).toBe(64);
    expect(thumb?.height).toBe(64);
    expect(thumb?.size).toBe(GRID_SIZE);
  });

  it("returns nothing, rather than throwing, for a format it cannot draw", async () => {
    // A PDF, a video, and a font all import normally and simply have no
    // thumbnail until the backend that draws them arrives in M4.
    const path = join(dir, "doc.pdf");
    await writeFile(path, Buffer.from("%PDF-1.7\n"));
    expect(await generateThumbnails(path)).toEqual([]);
  });

  it("has no thumbnail for BMP, which libvips cannot read", async () => {
    // Measured against libvips 8.18.3, and a real difference from the Rust
    // build, whose `image` crate did read BMP. Pinned here so that it stays a
    // decision rather than becoming a surprise (ADR-0013).
    expect(isRenderable("bmp")).toBe(false);
    const path = join(dir, "old.bmp");
    await writeFile(path, Buffer.concat([Buffer.from("BM"), Buffer.alloc(64)]));
    expect(await generateThumbnails(path)).toEqual([]);
  });

  it("has no thumbnail for SVG, whose renderer reads files off disk", async () => {
    // librsvg follows external references: an `<image href="secret.png">` beside
    // the SVG is loaded and drawn. That makes an imported SVG a way to read
    // local files through the thumbnailer, and the same path reaches remote
    // URLs, which invariant 7 forbids.
    expect(isRenderable("svg")).toBe(false);

    const secret = join(dir, "secret.png");
    await writeFile(secret, await gradient(40, 40, 9, "png"));
    const path = join(dir, "probe.svg");
    await writeFile(
      path,
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" ' +
          'xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="40">' +
          '<image xlink:href="secret.png" width="40" height="40"/></svg>',
      ),
    );

    expect(await generateThumbnails(path)).toEqual([]);
  });
});

describe("synthetic images", () => {
  const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

  it("is deterministic for a seed and different across seeds", async () => {
    expect(digest(gradientPixels(64, 64, 42))).toBe(digest(gradientPixels(64, 64, 42)));
    expect(digest(gradientPixels(64, 64, 42))).not.toBe(digest(gradientPixels(64, 64, 43)));
    expect(digest(await gradient(64, 64, 42, "png"))).toBe(
      digest(await gradient(64, 64, 42, "png")),
    );
  });

  it("gives three thousand seeds three thousand distinct images", () => {
    // The Rust build's first version offset by `seed % 256`, which yielded 256
    // distinct images: a 3,000-image fixture deduplicated down to 1,824 assets,
    // and the benchmark built on it was measuring the wrong thing. The offsets
    // are taken modulo three distinct primes for exactly this reason.
    const seen = new Set<string>();
    for (let seed = 0; seed < 3000; seed += 1) seen.add(digest(gradientPixels(32, 32, seed)));
    expect(seen.size).toBe(3000);
  });
});

describe("which sharp binary is loaded", () => {
  it("is a source build on Linux and the prebuilt everywhere else", () => {
    // ADR-0013. On Linux the prebuilt bundles its own GLib, collides with the
    // one Electron links, and takes the engine down on the first decode; the
    // source build links the same GLib and survives. Both report libvips
    // 8.18.3, so the version cannot tell them apart and this can.
    //
    // What this really guards is the `postinstall` hook: `pnpm install`
    // replaces the sharp package and deletes `src/build`, and a missing source
    // build does not fail — it silently falls back to the binary that
    // segfaults. Under Node, where these tests run, it segfaults nowhere.
    expect(decoderVersions().build).toBe(process.platform === "linux" ? "source" : "prebuilt");
  });
});
