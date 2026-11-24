/**
 * **Copy this frame**, asserted against a **running window** and the desktop's
 * own clipboard (ADR-0034 §9).
 *
 *     node scripts/check-frame.mjs
 *
 * The component tests prove the menu hands the clipboard a PNG promise. What
 * they cannot prove is the part only Chromium decides: that a canvas drawn from
 * a `roost://file/` video is readable at all (a missing `crossOrigin` or header
 * taints it and the copy fails), that the picture is the video's own size and
 * not the pane's, and that `navigator.clipboard` reaches the desktop. This reads
 * it back with `wl-paste`, as another application would.
 *
 * Under XWayland, for `check-clipboard.mjs`'s reason: Wayland takes a clipboard
 * write only from the focused window. **It replaces what is on your clipboard.**
 * It builds its own library with ffmpeg and deletes it again.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { importInto, Library } from "@roost/library";
import { ledger } from "./lib/checks.mjs";
import { scratch, videoClip } from "./lib/fixtures.mjs";
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

const { dir, dispose } = await scratch("check-frame");
// Not the pane's shape, so a frame drawn at the size it is shown would differ.
const clip = await videoClip(join(dir, "clip.mp4"), { seconds: 6, size: "640x360" });
const root = join(dir, "Frames.roost");
const library = await Library.create(root, "Frames");
try {
  await importInto(library, [clip]);
} finally {
  await library.close();
}

const window = await launch({ library: root, args: ["--ozone-platform=x11"] });
const { cdp } = window;
const { check, section, report } = ledger();

const menuItem = (label) => `
  [...document.querySelectorAll("[role=menuitem]")].find((i) => i.textContent === ${JSON.stringify(label)})`;

try {
  section("a video open in the preview, stopped on a frame");
  const cell = await cdp.box(".cell");
  await cdp.mouse.click(cell.x, cell.y);
  await cdp.keyboard.press("Enter");
  await cdp.settle(
    `document.querySelector(".preview video")?.readyState ?? 0`,
    (state) => state >= 2,
  );
  await cdp.evaluate(`
    new Promise((done) => {
      const video = document.querySelector(".preview video");
      video.pause();
      video.addEventListener("seeked", () => done(true), { once: true });
      video.currentTime = 2.5;
    })`);
  const at = await cdp.evaluate(`document.querySelector(".preview video").currentTime`);
  check("the player stands at 2.5 s", Math.abs(at - 2.5) < 0.01, String(at));

  section("Copy this frame");
  const shown = await cdp.box(".preview video");
  await cdp.mouse.click(shown.x, shown.y, { button: "right" });
  await cdp.settle(`${menuItem("Copy this frame")} !== undefined`, (found) => found === true);
  check(
    "it sits between the thumbnail's two rows",
    await cdp.evaluate(`(() => {
      const labels = [...document.querySelectorAll("[role=menuitem]")].map((i) => i.textContent);
      const at = labels.indexOf("Copy this frame");
      return labels[at - 1] === "Set this frame as the thumbnail"
        && labels[at + 1] === "Use the default frame";
    })()`),
  );
  await cdp.evaluate(`${menuItem("Copy this frame")}?.click()`);
  const said = await cdp.settle(
    `document.querySelector(".status-note")?.textContent ?? ""`,
    (line) => typeof line === "string" && line.includes("frame"),
  );
  check("the status bar says which frame", said === "Copied the frame at 0:02.5", said);

  let picture;
  for (let left = 50; left > 0 && picture === undefined; left -= 1) {
    picture = await paste(["-t", "image/png"]);
    if (picture === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check("the clipboard holds a PNG", picture?.subarray(1, 4).toString() === "PNG");
  // The IHDR chunk follows the signature: width and height, big-endian.
  const width = picture?.readUInt32BE(16);
  const height = picture?.readUInt32BE(20);
  check(
    "at the video's own size, not the pane's",
    width === 640 && height === 360,
    `${width}×${height}`,
  );
  // An undrawn canvas is one flat colour and deflates to a few hundred bytes at
  // this size; testsrc's bars, gradient and counter come to tens of kilobytes.
  check(
    "and it is the picture, not an empty canvas",
    (picture?.length ?? 0) > 10_000,
    `${picture?.length ?? 0} bytes`,
  );
  const offered = ((await paste(["--list-types"])) ?? "").toString();
  check("and nothing but the picture", !offered.includes("text/uri-list"), offered.trim());
} finally {
  report();
  await window.close();
  await dispose();
}
