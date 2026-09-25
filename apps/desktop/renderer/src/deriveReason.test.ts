import { describe, expect, it } from "vitest";
import { badgeOf, capabilityOfReason, explainFailure, isParked } from "./deriveReason.js";

/**
 * The sentences the failure list is read for.
 *
 * The messages here are the real ones, copied from what the backends actually
 * produce — sharp's corrupt-header line is what a truncated download looks like
 * from inside the queue, and it is the one that sent the user asking what "36
 * could not be drawn" meant.
 */
describe("saying what a backend's complaint means", () => {
  it("reads sharp's corrupt header as a damaged file", () => {
    const explained = explainFailure(
      "Input file has corrupt header: VipsJpeg: premature end of JPEG image",
    );

    expect(explained.line).toBe("The file is damaged or incomplete");
    expect(explained.hint).toContain("fresh copy");
  });

  it("reads an unsupported format as a file that is not what it is called", () => {
    expect(explainFailure("Input buffer contains unsupported image format").line).toBe(
      "Not the kind of file its name says",
    );
  });

  it("puts a missing original before ffmpeg, whichever of them said it", () => {
    // ffmpeg reports a missing file in its own voice, and "ffmpeg could not
    // read this" is the least useful of the two true answers.
    expect(explainFailure("ffmpeg: /photos/a.mov: No such file or directory").line).toBe(
      "Roost could not open the file",
    );
  });

  it("reads a refused read as a permission problem", () => {
    expect(explainFailure("open failed on … : EACCES").line).toBe(
      "Roost is not allowed to read the file",
    );
  });

  it("falls back to a plain line rather than guessing", () => {
    const explained = explainFailure("something nobody has seen before");

    expect(explained.line).toBe("Roost could not draw this file");
    // And says where the words underneath come from, since they are all the
    // reader has to go on.
    expect(explained.hint).toContain("backend's own");
  });
});

describe("an ffmpeg that runs and cannot decode", () => {
  it("names the codec, in the words a phone uses for it", () => {
    // Parked by the queue, which checked before trying (ADR-0017, amended
    // 2026-09-24).
    const explained = explainFailure("missing:decoder:hevc");

    expect(explained.line).toBe("The installed ffmpeg cannot decode HEVC (H.265)");
    expect(explained.hint).toContain("The file is fine");
  });

  it("says the same of ffmpeg's own words, on a row derived before the check", () => {
    // What every such file in a library derived before 2026-09-24 carries — or
    // would have, had the line not been buried under `Invalid argument`. Ahead
    // of the ffmpeg pattern, which would send somebody to another player.
    expect(explainFailure("ffmpeg: Decoding requested, but no decoder found for: eac3").line).toBe(
      "The installed ffmpeg cannot decode E-AC-3 (Dolby Digital Plus)",
    );
  });

  it("spells a codec it has no name for as ffmpeg does, capitalised", () => {
    expect(explainFailure("missing:decoder:cavs").line).toBe(
      "The installed ffmpeg cannot decode CAVS",
    );
  });

  it("waits on the media backend, as a missing ffmpeg does", () => {
    expect(capabilityOfReason("missing:decoder:hevc")).toBe("media");
    expect(capabilityOfReason("missing:ffmpeg")).toBe("media");
    expect(capabilityOfReason("missing:libheif")).toBe("heif");
    expect(capabilityOfReason("unsupported:zip")).toBeUndefined();
  });
});

describe("the few words a cell has room for", () => {
  it("names what to install, short enough for a tile", () => {
    expect(badgeOf("missing:libheif")).toBe("Needs libheif");
    expect(badgeOf("missing:ffmpeg")).toBe("Needs ffmpeg");
    expect(badgeOf("missing:decoder:hevc")).toBe("No HEVC decoder");
    // ffmpeg's own spelling of the same fault, from a library derived before
    // the queue checked.
    expect(badgeOf("[hevc @ 0x0] Decoding requested, but no decoder found for: hevc")).toBe(
      "No HEVC decoder",
    );
  });

  it("reads a GIMP file as any other format nothing here draws", () => {
    // An `.xcf` is `other`, like a `.zip` (2026-09-24): it opens in GIMP, and
    // the list says of it exactly what it says of an archive.
    expect(explainFailure("unsupported:xcf").line).toBe("Nothing in this build draws this format");
    expect(badgeOf("unsupported:xcf")).toBeUndefined();
  });

  it("says nothing on a format nothing draws, which is not a fault", () => {
    expect(badgeOf("unsupported:zip")).toBeUndefined();
    expect(badgeOf("unsupported:unknown")).toBeUndefined();
  });

  it("calls anything a backend said a failure", () => {
    expect(badgeOf("Input file has corrupt header: VipsJpeg: premature end")).toBe(
      "Could not be drawn",
    );
    expect(badgeOf("")).toBe("Could not be drawn");
  });

  it("tells the queue's parking from a backend's failure", () => {
    expect(isParked("missing:libheif")).toBe(true);
    expect(isParked("missing:decoder:hevc")).toBe(true);
    expect(isParked("ambiguous:file")).toBe(true);
    expect(isParked("unsupported:zip")).toBe(true);
    expect(isParked("ffmpeg: missing: something")).toBe(false);
    expect(isParked("sharp: unsupported image format")).toBe(false);
  });
});
