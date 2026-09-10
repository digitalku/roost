import { describe, expect, it } from "vitest";
import { hasHeicDecoder } from "./heif.js";
import { installCommand } from "./install.js";

/**
 * Telling a libheif that can decode a photograph from one that cannot.
 *
 * The distinction is the whole reason this check exists: Fedora ships
 * `libheif-tools` in its own repositories and the HEVC decoder in none of them,
 * so `heif-dec` installs, runs, reports a version — and then refuses every
 * photograph anybody owns (ADR-0040 §3). The listing below is verbatim from
 * `heif-dec --list-decoders` on Fedora 44 with RPM Fusion's plugin present.
 */
const WITH_PLUGIN = `AVC decoders:
- ffmpeg = FFMPEG AVC/HEVC decoder 8.1.2
- openh264 = OpenH264 2.6.0
AVIF decoders:
- dav1d = dav1d v7.0.0
- aom = AOMedia Project AV1 Decoder v3.13.3
HEIC decoders:
- libde265 = libde265 HEVC decoder, version 1.0.18
- ffmpeg = FFMPEG AVC/HEVC decoder 8.1.2
JPEG decoders:
- jpeg = libjpeg-turbo 3.1.2 (libjpeg 6.2)
`;

/** The same libheif with the section empty, which is Fedora without the plugin. */
const WITHOUT_PLUGIN = `AVIF decoders:
- dav1d = dav1d v7.0.0
HEIC decoders:
JPEG decoders:
- jpeg = libjpeg-turbo 3.1.2 (libjpeg 6.2)
`;

describe("whether a libheif can decode HEIC", () => {
  it("believes a listing that names a decoder", () => {
    expect(hasHeicDecoder(WITH_PLUGIN)).toBe(true);
  });

  it("does not believe an empty section", () => {
    // The trap: the tool is installed and the version call succeeds. Only the
    // listing separates "installed" from "can do the one thing it is for".
    expect(hasHeicDecoder(WITHOUT_PLUGIN)).toBe(false);
  });

  it("is not fooled by the decoders for other formats", () => {
    // AVIF is HEIF too, and its decoders are always there — sharp's own libvips
    // has one. Reading the wrong section would report every machine as capable
    // and turn a parked job into a failed one.
    expect(hasHeicDecoder("AVIF decoders:\n- aom = AOMedia\n")).toBe(false);
  });

  it("says nothing about a listing it cannot read", () => {
    expect(hasHeicDecoder("")).toBe(false);
  });
});

describe("what to tell somebody to install", () => {
  it("names Fedora's two packages, one of which is not Fedora's", () => {
    // Verified on Fedora 44 on 2026-09-10: `libheif-freeworld` is RPM Fusion's,
    // because Fedora ships no HEVC decoder at all.
    expect(installCommand("heif", { ID: "fedora" })).toBe(
      "sudo dnf install libheif-tools libheif-freeworld",
    );
  });

  it("follows ID_LIKE, so a derivative gets its parent's line", () => {
    // Linux Mint is not listed and never will be; `ID_LIKE=ubuntu debian` is
    // what makes it answerable anyway.
    expect(installCommand("heif", { ID: "linuxmint", ID_LIKE: "ubuntu debian" })).toContain(
      "apt install",
    );
    expect(installCommand("media", { ID: "nobara", ID_LIKE: "fedora" })).toContain("dnf");
  });

  it("names the thing rather than a command when the system is unknown", () => {
    // A wrong package name is worse than none: it sends somebody to a terminal
    // to be told nothing matches.
    expect(installCommand("heif", {})).toBe("install libheif's tools and its HEVC decoder plugin");
    expect(installCommand("media", { ID: "plan9" })).toBe("install ffmpeg");
  });
});
