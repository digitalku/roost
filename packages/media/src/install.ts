import { readFileSync } from "node:fs";

/**
 * What to type to get a missing backend, on the distribution you are actually
 * running (ADR-0040 §5).
 *
 * "Install libheif" is not an instruction anybody can follow — the package is
 * called something different everywhere, and on Fedora the piece that matters
 * is not in the distribution at all. So the line names a command, and the
 * command is chosen from `/etc/os-release` — or, on Windows, from the platform
 * itself — rather than guessed.
 *
 * **Nothing here fetches anything** (invariant 7): this is a string for a
 * person to read and run themselves, in a terminal Roost does not have.
 */

/**
 * A backend that can be missing, and what installing it is called.
 *
 * `decoders` is the one that is not a backend: ffmpeg is present and runs, and
 * lacks the decoders a phone's video needs (ADR-0017, amended 2026-09-24). The
 * answer is to replace it, which is a different command from installing one
 * where there was none.
 */
export type Installable = "media" | "heif" | "decoders";

/**
 * Commands per distribution family.
 *
 * **Only the Fedora lines are verified** — on this machine, on 2026-09-10,
 * which is where the HEIC work was done. The others are written from each
 * distribution's own package index and are marked as unverified in ADR-0040 §5
 * so that a wrong package name is a known gap rather than a surprise. The
 * fallback below is what an unrecognised system gets, and it names the thing
 * rather than a command.
 */
const COMMANDS: Readonly<Record<string, Readonly<Partial<Record<Installable, string>>>>> = {
  fedora: {
    // `libheif-freeworld` is RPM Fusion's: Fedora ships libheif itself but no
    // HEVC decoder for it, which is a patent policy rather than an oversight —
    // the same reason `ffmpeg-free` cannot open these files either.
    heif: "sudo dnf install libheif-tools libheif-freeworld",
    media: "sudo dnf swap ffmpeg-free ffmpeg --allowerasing",
    // The same line, because the ffmpeg Fedora installs is the one that lacks
    // them. The other families are absent on purpose: their own ffmpeg decodes
    // all of these, so one that does not is somebody's build, and a command to
    // install the distribution's would be a command to install what they have.
    decoders: "sudo dnf swap ffmpeg-free ffmpeg --allowerasing",
  },
  debian: {
    heif: "sudo apt install libheif-examples libheif-plugin-libde265",
    media: "sudo apt install ffmpeg",
  },
  arch: {
    heif: "sudo pacman -S libheif",
    media: "sudo pacman -S ffmpeg",
  },
  suse: {
    heif: "sudo zypper install libheif-tools",
    media: "sudo zypper install ffmpeg",
  },
};

/**
 * The line that switches RPM Fusion's free repository on, as RPM Fusion's own
 * instructions give it.
 *
 * Both of Fedora's answers above live there and nowhere else, and a Fedora
 * that has only the nonfree NVIDIA and Steam repositories — which is what
 * GNOME Software's *third-party repositories* switch gives — answers the bare
 * line with "No match for argument". So the line is prefixed wherever the
 * repository is not already on, and left alone where it is: Nobara ships with
 * it, and telling somebody to install what they have is noise.
 */
const RPM_FUSION_FREE =
  "sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm";

/** What to say when the system is not one of the four above. */
const FALLBACK: Readonly<Record<Installable, string>> = {
  heif: "install libheif's tools and its HEVC decoder plugin",
  media: "install ffmpeg",
  decoders: "install an ffmpeg build with the decoders this one lacks",
};

/**
 * Windows, where the answer is the platform rather than a distribution.
 *
 * There is no `/etc/os-release` here, so every Windows machine was given the
 * fallback — and for ffmpeg the answer is known and verified: winget's
 * `Gyan.FFmpeg` is a user-scope install that wants no administrator and brings
 * HEVC with it. It appends its own directory to the user `PATH`, which a
 * running window cannot be made to re-read, so **Try again** will not see it
 * until Roost is opened again.
 *
 * **HEIC keeps the fallback deliberately.** Nothing in winget ships
 * `heif-dec`, MSYS2's package has not been tried, and naming a command that
 * might not exist is what the fallback is there to avoid.
 */
const WINDOWS: Readonly<Record<Installable, string>> = {
  heif: FALLBACK.heif,
  media: "winget install --id Gyan.FFmpeg",
  // winget's would land on the PATH behind the ffmpeg already there.
  decoders: FALLBACK.decoders,
};

/**
 * What Roost may run, on the one platform where running it needs no password.
 *
 * A **constant** argument vector, spawned with `execFile` and never a shell
 * (ADR-0042 §4). The window names a backend and nothing it sends reaches this
 * array: there is no field here in which a program, a flag or a path could
 * travel.
 *
 * Windows is the only entry, and that is the decision rather than a gap. Every
 * line in `COMMANDS` begins with `sudo`, and a window that asked for a root
 * password would be teaching people to type one into whatever asks.
 *
 * The flags are the difference between a command a person runs and one nothing
 * is watching. winget asks about its source agreements on a first run and would
 * sit there for the timeout behind `execFile`, so it is told the answers; and
 * `--exact` keeps an id from matching something adjacent.
 */
const ARGV: Readonly<Partial<Record<Installable, readonly string[]>>> = {
  media: [
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
  ],
};

/** A command to read, and — where Roost may run it — what running it is. */
export interface InstallOffer {
  /** The command, for a person to read, copy, or type. There is always one. */
  readonly command: string;
  /**
   * What {@link import("./installer.js").installBackend} would spawn, or `null`
   * where Roost may not run anything.
   *
   * Two fields rather than one because "there is a command" and "Roost may run
   * it" have different answers on every platform (ADR-0042 §6).
   */
  readonly argv: readonly string[] | null;
}

/** What to show, and what a button may do, for a backend that is missing. */
export function installOffer(
  what: Installable,
  release?: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  rpmFusion: () => boolean = rpmFusionFreeEnabled,
): InstallOffer {
  return {
    command: installCommand(what, release, platform, rpmFusion),
    argv: platform === "win32" ? (ARGV[what] ?? null) : null,
  };
}

/**
 * The command for this machine, or a plain sentence where none is known.
 *
 * `ID_LIKE` is read after `ID`, which is what makes Linux Mint answer with
 * Debian's line and Nobara with Fedora's without either being listed. Windows
 * is answered ahead of all of it, because the question there is the platform.
 */
export function installCommand(
  what: Installable,
  release?: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  rpmFusion: () => boolean = rpmFusionFreeEnabled,
): string {
  // Ahead of `osRelease()` rather than after it, so Windows never reads for a
  // file it cannot have.
  if (platform === "win32") return WINDOWS[what];

  const found = release ?? osRelease();
  const ids = [found["ID"], ...(found["ID_LIKE"]?.split(/\s+/) ?? [])];
  for (const id of ids) {
    const key = id?.toLowerCase();
    const family = key === undefined ? undefined : COMMANDS[key];
    if (family === undefined) continue;
    // Asked only here, so no other system reads a file it cannot have.
    const command = family[what];
    if (command === undefined) return FALLBACK[what];
    if (key === "fedora" && !rpmFusion()) return `${RPM_FUSION_FREE} && ${command}`;
    return command;
  }
  return FALLBACK[what];
}

/**
 * Whether RPM Fusion's free repository is switched on, read from the file its
 * release package installs.
 *
 * A file that is present with the repository disabled counts as off. The
 * prefix is then a no-op — the release package is already installed — and the
 * second command fails the way it would have without the prefix: a known gap,
 * left because switching a repository back on is a decision somebody made, not
 * one to reverse from a copied line.
 */
export function rpmFusionFreeEnabled(): boolean {
  try {
    return repositoryEnabled(
      readFileSync("/etc/yum.repos.d/rpmfusion-free.repo", "utf8"),
      "rpmfusion-free",
    );
  } catch {
    return false;
  }
}

/**
 * Whether a `.repo` file's `[name]` section is enabled.
 *
 * dnf reads a section with no `enabled=` line as enabled, so only an explicit
 * `0`, `false` or `no` turns it off.
 */
export function repositoryEnabled(text: string, name: string): boolean {
  let inside = false;
  let enabled = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section !== null) {
      if (inside) break;
      inside = section[1] === name;
      enabled = inside;
      continue;
    }
    const setting = /^enabled\s*=\s*(\S+)$/i.exec(line);
    if (inside && setting?.[1] !== undefined) {
      enabled = !["0", "false", "no"].includes(setting[1].toLowerCase());
    }
  }
  return enabled;
}

/**
 * `/etc/os-release` as a map, or an empty one.
 *
 * Read synchronously and not cached: it is asked for once per missing backend,
 * on a path that has already started a process to find out the backend was
 * missing. An unreadable file is an answer — the fallback — rather than an
 * error, because a machine with no `os-release` is exactly the machine that
 * cannot be given a package name.
 */
export function osRelease(): Record<string, string> {
  try {
    const text = readFileSync("/etc/os-release", "utf8");
    const found: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match?.[1] === undefined || match[2] === undefined) continue;
      found[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
    }
    return found;
  } catch {
    return {};
  }
}
