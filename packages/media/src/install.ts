import { readFileSync } from "node:fs";

/**
 * What to type to get a missing backend, on the distribution you are actually
 * running (ADR-0040 §5).
 *
 * "Install libheif" is not an instruction anybody can follow — the package is
 * called something different everywhere, and on Fedora the piece that matters
 * is not in the distribution at all. So the line names a command, and the
 * command is chosen from `/etc/os-release` rather than guessed.
 *
 * **Nothing here fetches anything** (invariant 7): this is a string for a
 * person to read and run themselves, in a terminal Roost does not have.
 */

/** A backend that can be missing, and what installing it is called. */
export type Installable = "media" | "heif";

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
const COMMANDS: Readonly<Record<string, Readonly<Record<Installable, string>>>> = {
  fedora: {
    // `libheif-freeworld` is RPM Fusion's: Fedora ships libheif itself but no
    // HEVC decoder for it, which is a patent policy rather than an oversight —
    // the same reason `ffmpeg-free` cannot open these files either.
    heif: "sudo dnf install libheif-tools libheif-freeworld",
    media: "sudo dnf swap ffmpeg-free ffmpeg --allowerasing",
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

/** What to say when the system is not one of the four above. */
const FALLBACK: Readonly<Record<Installable, string>> = {
  heif: "install libheif's tools and its HEVC decoder plugin",
  media: "install ffmpeg",
};

/**
 * The command for this machine, or a plain sentence where none is known.
 *
 * `ID_LIKE` is read after `ID`, which is what makes Linux Mint answer with
 * Debian's line and Nobara with Fedora's without either being listed.
 */
export function installCommand(what: Installable, release = osRelease()): string {
  const ids = [release["ID"], ...(release["ID_LIKE"]?.split(/\s+/) ?? [])];
  for (const id of ids) {
    const family = id === undefined ? undefined : COMMANDS[id.toLowerCase()];
    if (family !== undefined) return family[what];
  }
  return FALLBACK[what];
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
