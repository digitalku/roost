/**
 * `Ctrl+C` and **Copy image**, asserted against a **running window** and the
 * desktop's own clipboard (ADR-0034 §5).
 *
 *     node scripts/check-clipboard.mjs
 *
 * The component tests prove the window asks for the right thing. What they
 * cannot prove is what reaches the clipboard, because a fake engine has no
 * clipboard. This reads it back the way another application would, with
 * `wl-paste`, so it needs a Wayland session with `wl-clipboard` installed and
 * says so plainly otherwise.
 *
 * **The window runs under XWayland.** Wayland takes a clipboard write only from
 * the focused window, and a desktop that stops a new window from taking the
 * focus while somebody is working leaves a check's writes ignored. The paste
 * then brings back whatever was there before, which reads as the feature being
 * broken. X11 has no such rule, and XWayland hands the selection on to Wayland.
 *
 * **It replaces what is on your clipboard**, since that is the thing it tests.
 * It builds its own library in a temporary directory and deletes it again.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ledger } from "./lib/checks.mjs";
import { imageLibrary, scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

/** What another application would read, or `undefined` when nothing is there. */
const paste = (args) =>
  new Promise((resolve) => {
    execFile("wl-paste", args, { encoding: "buffer", maxBuffer: 1 << 28 }, (error, out) =>
      resolve(error ? undefined : out),
    );
  });

if (process.env.WAYLAND_DISPLAY === undefined || (await paste(["--version"])) === undefined) {
  console.log("needs a Wayland session with wl-paste (wl-clipboard) to read the clipboard back");
  process.exit(1);
}

const { dir, dispose } = await scratch("check-clipboard");
const root = await imageLibrary(dir, { count: 3, size: 64 });
const window = await launch({ library: root, args: ["--ozone-platform=x11"] });
const { cdp } = window;
const { check, section, report } = ledger();

const note = () =>
  cdp.settle(
    `document.querySelector(".status-note")?.textContent ?? ""`,
    (line) => typeof line === "string" && line.length > 0,
  );

const types = async () => ((await paste(["--list-types"])) ?? "").toString().trim().split("\n");

try {
  section("Ctrl+C on the selection");
  const cell = await cdp.box(".cell");
  await cdp.mouse.click(cell.x, cell.y);
  // The cell is labelled with the name the library shows, which leaves out
  // the extension; the fixture's pictures are all PNGs.
  const label = await cdp.settle(
    `document.querySelector('.cell[aria-selected="true"]')?.getAttribute("aria-label") ?? ""`,
    (text) => typeof text === "string" && text.length > 0,
  );
  const name = `${label}.png`;
  await cdp.keyboard.press("c", { ctrl: true });
  const said = await note();
  check("the status bar says what was copied", said === "Copied 1 asset to the clipboard", said);

  // One format, and which one depends on the desktop (ADR-0034 §3.4).
  const offered = await types();
  const format = offered.find((type) =>
    ["text/uri-list", "x-special/gnome-copied-files"].includes(type),
  );
  check("the clipboard holds files", format !== undefined, offered.join(", "));
  const listed = ((await paste(["-t", format ?? "text/uri-list"])) ?? "").toString();
  const uri = listed.split(/\r?\n/).find((line) => line.startsWith("file://"));
  const staged = uri === undefined ? "" : fileURLToPath(uri);
  check(
    "under the name the library shows, not the id it is stored as",
    basename(staged) === name,
    basename(staged),
  );
  check(
    "staged inside the library",
    staged.startsWith(join(root, "staging")),
    staged.slice(root.length),
  );

  section("Copy image");
  await cdp.mouse.click(cell.x, cell.y, { button: "right" });
  await cdp.settle(
    "[...document.querySelectorAll('[role=menuitem]')].some((i) => i.textContent === 'Copy image')",
    (found) => found === true,
  );
  await cdp.evaluate(
    `[...document.querySelectorAll("[role=menuitem]")].find((i) => i.textContent === "Copy image")?.click()`,
  );
  const saidImage = await cdp.settle(
    `document.querySelector(".status-note")?.textContent ?? ""`,
    (line) => typeof line === "string" && line.includes("picture"),
  );
  check("the status bar says the picture was copied", saidImage.startsWith("Copied"), saidImage);

  const picture = await paste(["-t", "image/png"]);
  // The fixture is a PNG, and a PNG goes on byte for byte: re-encoding it
  // would lose its colour profile for nothing.
  const original = await readFile(join(dir, "pictures", name));
  check("the clipboard holds a PNG", picture?.subarray(1, 4).toString() === "PNG");
  check(
    "the file's own bytes, not a re-encoding of them",
    picture?.equals(original) === true,
    `${picture?.length ?? 0} of ${original.length} bytes`,
  );
  const now = await types();
  check("and nothing but the picture", !now.includes("text/uri-list"), now.join(", "));
} finally {
  report();
  await window.close();
  await dispose();
}
