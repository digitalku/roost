/**
 * Writes the desktop entry that puts Roost in the application menu.
 *
 *   node scripts/install-launcher.mjs
 *
 * Roost is not packaged yet — that is M6 — so the way to use it every day is
 * this checkout. A desktop entry is most of the difference between a checkout
 * and an application: the icon, the name, and a click that needs no terminal.
 *
 * **The entry launches the built output and never builds.** A menu click that
 * ran `tsc -b` first would spend a couple of seconds on it and, when it failed,
 * would have nowhere to print the error. Bringing a checkout up to date is
 * `pnpm refresh`, deliberately a separate and visible step.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

/** The launched program, the window's script, and the icon it opens with. */
const ELECTRON = await electronBinary();
const ENTRY = fileURLToPath(new URL("apps/desktop/main/dist/main.js", root));
const ICON = fileURLToPath(new URL("assets/brand/icon-512.png", root));

/**
 * `roost.desktop`, and the name matters beyond tidiness: `distrobox-export
 * --app roost` finds an entry by this basename.
 */
const FILE = "roost.desktop";

await main();

async function main() {
  if (!(await exists(ENTRY))) {
    fail(`no build at ${ENTRY}\nRun \`pnpm start\` once (or \`pnpm refresh\`) and try again.`);
  }

  const dir = join(
    process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"),
    "applications",
  );
  const path = join(dir, FILE);

  await mkdir(dir, { recursive: true });
  await writeFile(path, entry(), "utf8");

  console.log(`wrote ${path}`);
  console.log(`      ${ELECTRON}`);
  if (await inContainer()) {
    // The entry is now in the container's menu, which nothing draws. Exporting
    // is what puts it in the host's, and it is run from in here rather than out
    // there.
    console.log(
      "\nThis is a container, so the host's menu cannot see the entry yet. Run, still in here:\n" +
        "  distrobox-export --app roost",
    );
  }
}

/** The desktop entry, as the spec wants it written. */
function entry() {
  return `${[
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=Roost",
    "GenericName=Digital Asset Manager",
    "Comment=A local-first digital asset manager",
    // The same flag `pnpm dev` passes: without it the window is XWayland on a
    // Wayland session, which is blurry on a HiDPI screen and wrong under
    // fractional scaling (TODO.md §2).
    `Exec=${quote(ELECTRON)} ${quote(ENTRY)} --ozone-platform-hint=auto`,
    `Icon=${ICON}`,
    "Terminal=false",
    "Categories=Graphics;Photography;Viewer;",
    "Keywords=assets;images;photos;tags;library;",
    "StartupNotify=true",
    // Measured, not guessed: an unpackaged Electron reports WM_CLASS "electron"
    // whatever it is launched as — neither `--class` nor a renamed symlink
    // moves it. Without this line the window would not group under its own
    // icon. Packaging gives the binary its own name and settles it (M6).
    "StartupWMClass=electron",
  ].join("\n")}\n`;
}

/**
 * A value for `Exec`, which is not shell quoting.
 *
 * The desktop entry spec reserves its own set of characters and escapes them
 * inside double quotes with a backslash. No path here has a space today; one
 * will the first time this repository is cloned somewhere with one in the name.
 */
function quote(value) {
  return `"${value.replace(/(["`$\\])/g, "\\$1")}"`;
}

/**
 * Where the `electron` package put its binary.
 *
 * Read rather than assumed: the package publishes the name in `path.txt`, and
 * `dist/electron` is only right on Linux by coincidence.
 */
async function electronBinary() {
  const dist = new URL("node_modules/electron/dist/", root);
  const name = (await readFile(new URL("node_modules/electron/path.txt", root), "utf8")).trim();
  return fileURLToPath(new URL(name, dist));
}

/** Podman and Docker both leave this behind; distrobox is podman. */
async function inContainer() {
  return await exists("/run/.containerenv");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
