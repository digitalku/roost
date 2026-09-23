import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir, logger } from "@roost/core";

/**
 * Electron's fontconfig, kept away from every other program's caches.
 *
 * Chromium links its own fontconfig rather than the system's, and fontconfig
 * reads every `<cachedir>` its configuration names. When `~/.cache/fontconfig`
 * holds a cache a *newer* fontconfig wrote — another Electron of a later major
 * is enough — this build's copy refuses to regenerate it and finds no fonts at
 * all: the window draws with every glyph zero-width, or dies with `SIGTRAP` on
 * the first text it lays out (`SETUP.md` §7). Moving the files aside lasts
 * until that other program next starts, so the fix is to stop sharing them.
 *
 * `FONTCONFIG_FILE` points at a copy of the system's configuration with its
 * cache directories replaced by one of Roost's own. Everything else — the font
 * directories, `conf.d`, every alias and substitution — is the system's, so the
 * window resolves exactly the fonts it would have. A second cache directory
 * beside the shared one would not do: the refusal is triggered by the newer
 * file wherever it is found.
 *
 * It has to be in the environment before Chromium first reads its configuration,
 * and main's module scope is early enough — measured, not assumed. A
 * `FONTCONFIG_FILE` or `FONTCONFIG_PATH` somebody set is theirs and is left
 * alone. What the window launches inherits the variable, and sees the same
 * configuration with its cache in Roost's directory rather than the shared one.
 */

const log = logger("main:fonts");

/** Where fontconfig looks by default, and what `conf.d` resolves against. */
const SYSTEM_CONFIG = "/etc/fonts/fonts.conf";

const CACHE_DIRECTORY = /<cachedir\b[^>]*>[^<]*<\/cachedir>/g;
const CLOSING = "</fontconfig>";

/**
 * The system's configuration with every `<cachedir>` replaced by `directory`,
 * or `undefined` when the text is not one fontconfig would read.
 */
export function privateFontConfig(system: string, directory: string): string | undefined {
  const end = system.lastIndexOf(CLOSING);
  if (end < 0) return undefined;
  const stripped = system.slice(0, end).replace(CACHE_DIRECTORY, "");
  return `${stripped}\t<cachedir>${escapeXml(directory)}</cachedir>\n${system.slice(end)}`;
}

/** Points this process's fontconfig at a private cache. Linux only; never throws. */
export function isolateFontCache(): void {
  if (process.platform !== "linux") return;
  if (process.env["FONTCONFIG_FILE"] !== undefined) return;
  if (process.env["FONTCONFIG_PATH"] !== undefined) return;
  try {
    const root = cacheDir();
    const config = privateFontConfig(readFileSync(SYSTEM_CONFIG, "utf8"), join(root, "fontconfig"));
    if (config === undefined) {
      log.warn(`${SYSTEM_CONFIG} has no closing tag; fonts use the shared cache`);
      return;
    }
    mkdirSync(root, { recursive: true });
    const file = join(root, "fonts.conf");
    writeFileSync(file, config);
    process.env["FONTCONFIG_FILE"] = file;
  } catch (error) {
    // A system with no /etc/fonts, or a cache directory nobody can write: the
    // window starts as it did before this existed.
    log.warn("fonts use the shared cache", { error: String(error) });
  }
}

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
