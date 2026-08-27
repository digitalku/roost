import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GRID_SIZE, mediaTypeOf, PREVIEW_SIZE, THUMBNAIL_SIZES } from "./serving.js";

describe("the decoder-free serving surface", () => {
  it("names the two sizes the schema expects", () => {
    expect(THUMBNAIL_SIZES).toEqual([GRID_SIZE, PREVIEW_SIZE]);
    expect([GRID_SIZE, PREVIEW_SIZE]).toEqual([256, 512]);
  });

  it("gives a format nothing can draw a type that offers to save it", () => {
    expect(mediaTypeOf("webp")).toBe("image/webp");
    expect(mediaTypeOf("unknown")).toBe("application/octet-stream");
  });

  it("loads without pulling sharp into the process", () => {
    // ADR-0008 puts the protocol handler in main, the process that draws the
    // window. sharp `dlopen`s libvips there, and M3 accepts on cold start.
    // Run in a fresh process because this one has already loaded sharp for the
    // other tests in this package — asserting it here would prove nothing.
    const built = fileURLToPath(new URL("../dist/serving.js", import.meta.url));
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(built)}).then(() => {
           const loaded = process.report.getReport().sharedObjects;
           const sharp = loaded.filter((o) => /sharp|vips/i.test(o));
           console.log(JSON.stringify(sharp));
         });`,
      ],
      { encoding: "utf8" },
    );
    expect(probe.status).toBe(0);
    expect(JSON.parse(probe.stdout.trim())).toEqual([]);
  });
});
