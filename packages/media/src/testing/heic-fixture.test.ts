import { describe, expect, it } from "vitest";
import { hasHeicEncoder } from "./heic-fixture.js";

// Both listings are libheif 1.21.2's, the second with `LIBHEIF_PLUGIN_PATH`
// pointed at an empty directory, which is what an Ubuntu without
// `libheif-plugin-x265` looks like.
const withX265 = [
  "AVC encoders:",
  "AVIF encoders:",
  "- aom = AOMedia Project AV1 Encoder v3.13.1 [default]",
  "HEIC encoders:",
  "- x265 = x265 HEVC encoder (4.1+1-1d117be) [default]",
  "JPEG encoders:",
  "",
].join("\n");

const withNone = ["AVC encoders:", "AVIF encoders:", "HEIC encoders:", "JPEG encoders:", ""].join(
  "\n",
);

describe("whether a HEIC can be made here", () => {
  it("says yes when the listing names a HEIC encoder", () => {
    expect(hasHeicEncoder(withX265)).toBe(true);
  });

  it("says no when the heading has nothing under it", () => {
    // The 2026-11-17 case: `heif-enc` runs, so asking for its version said yes.
    expect(hasHeicEncoder(withNone)).toBe(false);
  });

  it("does not take another format's encoder for one", () => {
    const avifOnly = withNone.replace(
      "AVIF encoders:",
      "AVIF encoders:\n- aom = AOMedia Project AV1 Encoder [default]",
    );
    expect(hasHeicEncoder(avifOnly)).toBe(false);
  });

  it("says no to a listing with no HEIC heading at all", () => {
    expect(hasHeicEncoder("")).toBe(false);
  });
});
