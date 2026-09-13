import { execFile } from "node:child_process";
import { logger } from "@roost/core";
import { type Installable, installOffer } from "./install.js";

/**
 * The one place in Roost that causes software to be installed (ADR-0042).
 *
 * It runs the machine's own package manager, with a constant argument vector
 * from `install.ts` and never a shell. Nothing is fetched by Roost and no socket
 * is opened here — but a click does cause a download, so invariant 7 is written
 * about it rather than read around it (ADR-0042 §5): it is initiated by a
 * person, the command is printed above the button that starts it, and the
 * destination is the one the operating system chose.
 *
 * **Only where it needs no password.** `installOffer` answers `argv: null`
 * everywhere else, and this refuses rather than guessing — see ADR-0042 §3 for
 * why Linux is deliberately excluded on the platform Roost is for.
 */

const log = logger("install");

/** How long a package manager may take. It downloads; 30 s is not enough. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** The most of a package manager's chatter to carry back. */
const MAX_OUTPUT_BYTES = 64 * 1024;

/** What running it did, in the package manager's own words. */
export interface InstallOutcome {
  /** Whether it exited clean. "Already installed" is a refusal, not a success. */
  readonly installed: boolean;
  /**
   * What the package manager said, cleaned of its progress bars.
   *
   * Shown verbatim: this is the one place where a translation would be a
   * liability, because the reason a person needs it is that something did not
   * go the way either of us expected.
   */
  readonly detail: string;
}

/**
 * Installs a backend, where the platform allows it.
 *
 * Never throws for an install that failed — a package manager refusing is an
 * answer and belongs on screen. It throws only for the one case that is a
 * programming error: asking on a platform whose offer carries no argv.
 */
export async function installBackend(what: Installable): Promise<InstallOutcome> {
  const offer = installOffer(what);
  const [program, ...args] = offer.argv ?? [];
  if (program === undefined) {
    throw new Error(`nothing may be run to install ${what} on ${process.platform}`);
  }

  log.info("installing", { backend: what, program });
  const result = await run(program, args);
  log.info("install finished", { backend: what, installed: result.installed });

  // Only on success, and only then: the whole point is that the `PATH` a
  // successful install wrote is one this process cannot otherwise see.
  if (result.installed) await adoptUserPath();
  return result;
}

/**
 * Takes the user `PATH` as it is **now**, from the registry.
 *
 * This is the measurement in ADR-0042 §2 turned into code. winget's ffmpeg is a
 * portable install: it appends its own directory to the user `PATH` and says to
 * restart the shell. A process inherits its environment once and never re-reads
 * it, so without this the feature installs ffmpeg and then reports ffmpeg
 * missing — which is a worse answer than the one it replaced.
 *
 * **Additive.** Entries already present are left where they are and nothing is
 * removed, so a developer's own `PATH` — and `ROOST_FFMPEG` beside it — is
 * untouched.
 */
export async function adoptUserPath(): Promise<void> {
  if (process.platform !== "win32") return;

  const entries = await userPathEntries();
  if (entries.length === 0) return;

  const current = (process.env["PATH"] ?? "").split(";");
  const known = new Set(current.map(key));
  const added = entries.filter((entry) => !known.has(key(entry)));
  if (added.length === 0) return;

  process.env["PATH"] = [...current, ...added].join(";");
  log.info("adopted the user PATH", { added: added.length });
}

/** `HKCU\Environment`'s `Path`, expanded and split. Empty if it cannot be read. */
async function userPathEntries(): Promise<readonly string[]> {
  // `reg.exe` rather than a native module: it is the documented reader for this
  // key, it ships with Windows, and one registry value does not justify an
  // addon that would have to be rebuilt against Electron's ABI (ADR-0009).
  const query = await run("reg.exe", ["query", "HKCU\\Environment", "/v", "Path"]);
  if (!query.installed) return [];

  // `    Path    REG_EXPAND_SZ    C:\one;C:\two`
  const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(query.detail);
  const value = match?.[1];
  if (value === undefined) return [];

  return expand(value)
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** `%LOCALAPPDATA%\…` as a path. A `REG_EXPAND_SZ` is stored unexpanded. */
function expand(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
}

/** How two `PATH` entries are compared: Windows cares about neither. */
function key(entry: string): string {
  return entry.trim().replace(/\\+$/, "").toLowerCase();
}

/**
 * Runs a program and brings back what it said, whatever it exited with.
 *
 * `execFile` with an argument array and no shell, as ADR-0017 requires of every
 * external tool — with more force here than there, because this one writes to
 * the machine rather than reading a video.
 */
async function run(program: string, args: readonly string[]): Promise<InstallOutcome> {
  return new Promise((resolve) => {
    execFile(
      program,
      [...args],
      { timeout: INSTALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        const said = readable(`${stdout}${stderr}`);
        if (error === null) {
          resolve({ installed: true, detail: said });
          return;
        }
        // A program that could not be started says nothing at all, and "it
        // failed" with an empty box under it is not an answer.
        resolve({ installed: false, detail: said === "" ? error.message : said });
      },
    );
  });
}

/**
 * A package manager's output, without the parts that were animation.
 *
 * winget draws progress by rewriting one line with carriage returns and block
 * characters. Pasted into a dialog that is the same bar a hundred times over,
 * so only what followed the last `\r` of a line is kept, and a line that was
 * nothing but a bar is dropped.
 */
function readable(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => (line.split("\r").at(-1) ?? "").trim())
    .filter((line) => line !== "" && !/^[\s█▒░▓■\-\\|/.]+$/.test(line))
    .join("\n")
    .trim();
}
