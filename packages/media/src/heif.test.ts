import { describe, expect, it } from "vitest";
import { hasHeicDecoder, primaryIn } from "./heif.js";
import { carriesTools, installCommand, installOffer, repositoryEnabled } from "./install.js";

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
  it("knows a Flatpak carries its own tools, from FLATPAK_ID", () => {
    expect(carriesTools({ FLATPAK_ID: "com.digitalku.roost" })).toBe(true);
    expect(carriesTools({})).toBe(false);
  });

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

describe("which image of a HEIC is the photograph", () => {
  // Verbatim from `heif-info` 1.23.4 on a three-image burst (2026-09-25).
  // `heif-dec` wrote `decoded-1.jpg` … `decoded-3.jpg` for it and no
  // `decoded.jpg`, and the derive failed reading a file that never existed.
  it("finds the one marked primary, counted as heif-dec numbers them", () => {
    const burst = [
      "MIME type: image/heic",
      "image: 1024x768 (id=1), primary",
      "image: 1024x768 (id=2)",
      "image: 1024x768 (id=3)",
    ].join("\n");
    expect(primaryIn(burst)).toBe(1);
    expect(
      primaryIn("image: 640x480 (id=4)\nimage: 4032x3024 (id=9), primary\n  thumbnail: 320x240"),
    ).toBe(2);
  });

  it("takes the first where nothing is marked", () => {
    expect(primaryIn("")).toBe(1);
    expect(primaryIn("image: 10x10 (id=1)\nimage: 10x10 (id=2)")).toBe(1);
  });
});

describe("what to tell somebody to install", () => {
  it("names Fedora's two packages, one of which is not Fedora's", () => {
    // Verified on Fedora 44 on 2026-09-10: `libheif-freeworld` is RPM Fusion's,
    // because Fedora ships no HEVC decoder at all.
    expect(installCommand("heif", { ID: "fedora" }, "linux", () => true)).toBe(
      "sudo dnf install libheif-tools libheif-freeworld",
    );
  });

  it("switches RPM Fusion on first where it is off", () => {
    // Found on Fedora 44 on 2026-09-24: GNOME Software's third-party switch
    // brings RPM Fusion's nonfree NVIDIA and Steam repositories and not the
    // free one, which is where both packages live — so the bare line was
    // "No match for argument" on the machine it was written for.
    const enable =
      "sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm && ";
    expect(installCommand("heif", { ID: "fedora" }, "linux", () => false)).toBe(
      `${enable}sudo dnf install libheif-tools libheif-freeworld`,
    );
    expect(installCommand("media", { ID: "fedora" }, "linux", () => false)).toBe(
      `${enable}sudo dnf swap ffmpeg-free ffmpeg --allowerasing`,
    );
    // A derivative that ships it on — Nobara — gets the bare line.
    expect(installCommand("media", { ID: "nobara", ID_LIKE: "fedora" }, "linux", () => true)).toBe(
      "sudo dnf swap ffmpeg-free ffmpeg --allowerasing",
    );
  });

  it("replaces an ffmpeg that lacks decoders only where the distribution's is the one lacking", () => {
    // Fedora's own ffmpeg is the one without HEVC, so the answer is the swap.
    expect(installCommand("decoders", { ID: "fedora" }, "linux", () => true)).toBe(
      "sudo dnf swap ffmpeg-free ffmpeg --allowerasing",
    );
    // Debian's and Windows' decode all of it: one that does not is somebody's
    // own build, and installing the distribution's would install what they have.
    expect(installCommand("decoders", { ID: "debian" }, "linux")).toBe(
      "install an ffmpeg build with the decoders this one lacks",
    );
    expect(installCommand("decoders", {}, "win32")).toBe(
      "install an ffmpeg build with the decoders this one lacks",
    );
    expect(installOffer("decoders", {}, "win32").argv).toBeNull();
  });

  it("asks about RPM Fusion on Fedora and nowhere else", () => {
    let asked = 0;
    const probe = (): boolean => {
      asked += 1;
      return false;
    };
    installCommand("media", { ID: "debian" }, "linux", probe);
    installCommand("media", { ID: "plan9" }, "linux", probe);
    installCommand("media", {}, "win32", probe);
    expect(asked).toBe(0);
  });

  it("reads a repository as dnf does", () => {
    const repo = (enabled: string): string =>
      `[rpmfusion-free]\nname=RPM Fusion\n${enabled}\n\n[rpmfusion-free-debuginfo]\nenabled=1\n`;
    expect(repositoryEnabled(repo("enabled=1"), "rpmfusion-free")).toBe(true);
    expect(repositoryEnabled(repo("enabled=0"), "rpmfusion-free")).toBe(false);
    expect(repositoryEnabled(repo("enabled = False"), "rpmfusion-free")).toBe(false);
    // No `enabled=` line is enabled, which is dnf's default.
    expect(repositoryEnabled(repo(""), "rpmfusion-free")).toBe(true);
    // Another section's setting is not this one's.
    expect(repositoryEnabled(repo("enabled=0"), "rpmfusion-free-debuginfo")).toBe(true);
    expect(repositoryEnabled("[rpmfusion-nonfree]\nenabled=1\n", "rpmfusion-free")).toBe(false);
  });

  it("follows ID_LIKE, so a derivative gets its parent's line", () => {
    // Linux Mint is not listed and never will be; `ID_LIKE=ubuntu debian` is
    // what makes it answerable anyway.
    expect(
      installCommand("heif", { ID: "linuxmint", ID_LIKE: "ubuntu debian" }, "linux"),
    ).toContain("apt install");
    expect(installCommand("media", { ID: "nobara", ID_LIKE: "fedora" }, "linux")).toContain("dnf");
  });

  it("answers Windows from the platform, not from a file it cannot have", () => {
    // Verified: winget's is a user-scope install that wants no administrator.
    expect(installCommand("media", {}, "win32")).toBe("winget install --id Gyan.FFmpeg");
    // And HEIC keeps the sentence, because nothing in winget ships `heif-dec`
    // and a command nobody has run is worse than no command.
    expect(installCommand("heif", {}, "win32")).toBe(
      "install libheif's tools and its HEVC decoder plugin",
    );
  });

  it("offers an argv only where running it needs no password", () => {
    // Windows, and ffmpeg alone: winget's package is a portable install that
    // wants no administrator, which is the measurement the button rests on
    // (ADR-0042 §2).
    expect(installOffer("media", {}, "win32").argv).toEqual([
      "winget",
      "install",
      "--id",
      "Gyan.FFmpeg",
      "--exact",
      "--source",
      "winget",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ]);
    // Nothing in winget ships `heif-dec`, so there is a sentence and no argv.
    expect(installOffer("heif", {}, "win32").argv).toBeNull();
    // And Linux has an argv nowhere, deliberately: every line begins with sudo.
    expect(installOffer("media", { ID: "fedora" }, "linux").argv).toBeNull();
    expect(installOffer("heif", { ID: "fedora" }, "linux").argv).toBeNull();
  });

  it("carries the same command an offer shows and a person would type", () => {
    expect(installOffer("media", { ID: "fedora" }, "linux", () => false).command).toBe(
      installCommand("media", { ID: "fedora" }, "linux", () => false),
    );
  });

  it("names the thing rather than a command when the system is unknown", () => {
    // A wrong package name is worse than none: it sends somebody to a terminal
    // to be told nothing matches.
    expect(installCommand("heif", {}, "linux")).toBe(
      "install libheif's tools and its HEVC decoder plugin",
    );
    expect(installCommand("media", { ID: "plan9" }, "linux")).toBe("install ffmpeg");
  });
});
