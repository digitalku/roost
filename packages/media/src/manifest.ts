import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";

/**
 * The version of a package that actually resolved.
 *
 * Not a constant in this repository and not a read of `package.json` through
 * the specifier: both of the WASM backends export a narrow set of subpaths and
 * neither includes its own manifest, so the manifest is found by walking up
 * from a file that *is* exported. What this reports is therefore the version
 * that loaded, which is the only version a bug report cares about.
 */
export function packageVersion(exportedFile: string, resolve: (id: string) => string): string {
  try {
    let directory = dirname(resolve(exportedFile));
    const { root } = parse(directory);
    while (true) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        const version = (parsed as { version?: unknown }).version;
        if (typeof version === "string") return version;
      } catch {
        // No manifest at this level, or an unreadable one: keep walking.
      }
      if (directory === root) return "unknown";
      directory = dirname(directory);
    }
  } catch {
    return "unknown";
  }
}
