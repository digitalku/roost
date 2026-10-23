/**
 * Writes the launcher that puts Roost in the application menu.
 *
 *   node scripts/install-launcher.mjs
 *
 * Roost is not packaged yet — that is M6 — so the way to use it every day is
 * this checkout. A menu entry is most of the difference between a checkout and
 * an application: the icon, the name, and a click that needs no terminal. It is
 * a desktop entry on Linux and a Start Menu shortcut on Windows, and both point
 * at the same two absolute paths.
 *
 * **The launcher launches the built output and never builds.** A click that ran
 * `tsc -b` first would spend a couple of seconds on it and, when it failed,
 * would have nowhere to print the error. Bringing a checkout up to date is
 * `pnpm refresh`, deliberately a separate and visible step.
 */
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { linkAs } from "./lib/launch.mjs";

const root = new URL("../", import.meta.url);

/** Electron, the window's script, and the icons it opens with. */
const ELECTRON = await electronBinary();
const ENTRY = fileURLToPath(new URL("apps/desktop/main/dist/main.js", root));
const ICON = fileURLToPath(new URL("assets/brand/icon-512.png", root));
const ICO = fileURLToPath(new URL("assets/brand/roost.ico", root));

/**
 * `roost.desktop`, and the name matters beyond tidiness: `distrobox-export
 * --app roost` finds an entry by this basename.
 */
const FILE = "roost.desktop";

/** What the shortcut is called in the Start Menu, and so what it is found as. */
const LINK = "Roost.lnk";

/** The program the launcher runs, settled once `main` has checked Electron is there. */
let binary = ELECTRON;

await main();

async function main() {
  if (!(await exists(ENTRY))) {
    fail(`no build at ${ENTRY}\nRun \`pnpm start\` once (or \`pnpm refresh\`) and try again.`);
  }
  if (!(await exists(ELECTRON))) {
    fail(`no electron at ${ELECTRON}\nRun \`pnpm install\` and try again.`);
  }
  // Electron under the name `roost`, so the system monitor says so
  // (`lib/launch.mjs`). An install removes it, which is why `pnpm refresh`
  // makes it again.
  binary = linkAs(ELECTRON, "roost");

  if (process.platform === "linux") return await desktopEntry();
  if (process.platform === "win32") return await startMenuShortcut();
  // macOS is the platform `dirs.ts` refuses (ADR-0041), so there is nothing for
  // a launcher there to open.
  fail(`no launcher for ${process.platform}; run \`pnpm start\` from this checkout instead`);
}

/** Linux: an entry under `$XDG_DATA_HOME/applications`. */
async function desktopEntry() {
  const dir = join(
    process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"),
    "applications",
  );
  const path = join(dir, FILE);

  await mkdir(dir, { recursive: true });
  await writeFile(path, entry(), "utf8");

  console.log(`wrote ${path}`);
  console.log(`      ${binary}`);
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
    `Exec=${quote(binary)} ${quote(ENTRY)} --ozone-platform-hint=auto`,
    `Icon=${ICON}`,
    "Terminal=false",
    "Categories=Graphics;Photography;Viewer;",
    "Keywords=assets;images;photos;tags;library;",
    "StartupNotify=true",
    // Measured, not guessed: an unpackaged Electron reports WM_CLASS "electron"
    // whatever it is launched as — neither `--class`, a renamed symlink, nor
    // the hard link named `roost` this entry runs moves it, so the name is not
    // where Electron reads it from. Without this line the window would not
    // group under its own icon. Packaging settles it (M6).
    "StartupWMClass=electron",
  ].join("\n")}\n`;
}

/**
 * Windows: a shortcut in the user's own Start Menu.
 *
 * **A `.lnk` is a COM object rather than a file format to assemble by hand**,
 * so this asks Windows Script Host — through the PowerShell every Windows ships
 * — to create it. The two things that look like alternatives are not: a `.cmd`
 * puts a console window behind the application and leaves it there for as long
 * as it runs, and a `.url` carries neither arguments nor an icon.
 *
 * It goes in the *user's* Start Menu (`%APPDATA%`) and never the machine's,
 * because nothing here needs an administrator and a launcher that asked for one
 * would be a launcher most people could not install.
 */
async function startMenuShortcut() {
  const dir = join(
    process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
  );
  const path = join(dir, LINK);
  await mkdir(dir, { recursive: true });

  // `roost.ico` is committed beside the PNGs, but a checkout older than it
  // should still get a shortcut — wearing Electron's own icon, which at least
  // does not lie about what is being launched.
  const icon = (await exists(ICO)) ? ICO : ELECTRON;

  const script = [
    "$shell = New-Object -ComObject WScript.Shell",
    `$link = $shell.CreateShortcut(${literal(path)})`,
    `$link.TargetPath = ${literal(binary)}`,
    // One argument, quoted for the command line rather than for PowerShell:
    // `main.js` is inside this checkout, and a checkout can sit in a directory
    // whose name has a space in it.
    `$link.Arguments = ${literal(`"${ENTRY}"`)}`,
    `$link.WorkingDirectory = ${literal(fileURLToPath(root))}`,
    `$link.IconLocation = ${literal(icon)}`,
    `$link.Description = ${literal("A local-first digital asset manager")}`,
    "$link.Save()",
  ].join("\n");

  // The script arrives on stdin rather than in the command line, which is what
  // keeps a path holding a quote or a semicolon from becoming syntax.
  const powershell = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "-"],
    { input: script, encoding: "utf8" },
  );
  if (powershell.error) fail(`could not run powershell: ${powershell.error.message}`);
  if (powershell.status !== 0) {
    fail(`powershell refused to write the shortcut:\n${powershell.stderr.trim()}`);
  }

  console.log(`wrote ${path}`);
  console.log(`      ${binary}`);
  console.log(
    "\nIt is in the Start Menu as Roost; right-click it there to pin it to Start or to the" +
      "\ntaskbar. Deleting that file is how it is removed.",
  );
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
 * A PowerShell single-quoted string, which is the one kind that expands
 * nothing. A Windows path is full of backslashes and may carry a `$`, and both
 * are live inside double quotes; a quote of its own is doubled.
 */
function literal(value) {
  return `'${value.replace(/'/g, "''")}'`;
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
