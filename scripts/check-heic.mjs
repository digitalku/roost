/**
 * HEIC, asserted against a **running window** (ADR-0040).
 *
 *     node scripts/check-heic.mjs
 *
 * **It builds its own library** in a temporary directory and deletes it again,
 * with one HEIC encoded by libheif.
 *
 * Three facts here cannot be checked anywhere else, and the third is the one
 * that took a day to find. **The decode is the system's libheif**, so only a
 * real run proves the queue reaches it. **The window is Chromium**, and no
 * component test can say whether it drew a picture — a HEIC in an `<img>` is a
 * blank pane, which is exactly how this shipped for RAW and TIFF from M4 until
 * somebody opened a photograph. And **the parked state is a whole path of its
 * own**: with no decoder the job must park rather than fail, name the command,
 * and release itself when one arrives — which this drives by pointing
 * `ROOST_HEIF_DEC` at nothing.
 *
 * Skipped, loudly, where libheif is absent: it is an optional decoder by
 * decision (ADR-0040), and a check that quietly passed without it would be
 * asserting nothing on most machines.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importInto, Library, queueStatus, runDerives } from "@roost/library";
import { GRID_SIZE } from "@roost/media";
import { canMakeHeic, makeHeic } from "@roost/media/testing/heic-fixture";
import { ledger } from "./lib/checks.mjs";
import { launch } from "./lib/window.mjs";

if (!(await canMakeHeic())) {
  console.log("skipped: no libheif on this machine, so there is nothing to assert");
  console.log("  sudo dnf install -y libheif-tools libheif-freeworld   # README, Install");
  process.exit(0);
}

/** The size an iPhone writes, which is what makes libheif assemble a grid. */
const WIDTH = 3024;
const HEIGHT = 4032;

const dir = await mkdtemp(join(tmpdir(), "roost-check-heic-"));
const { check, section, report } = ledger();

/** What the pane is showing, in one round trip. */
const pictureExpression = `
  (() => {
    const image = document.querySelector(".preview-photo-image");
    if (image === null) return null;
    return {
      src: image.getAttribute("src"),
      width: image.naturalWidth,
      height: image.naturalHeight,
      drawn: image.naturalWidth > 0,
    };
  })()`;

/**
 * The status line, but only while it is a button.
 *
 * The bar is one element that changes what it is — a `span` reading "Deriving…"
 * while the queue works, a `button` when it has stopped — so a click aimed at
 * the button a moment earlier lands on the span and does nothing, which is what
 * the span is for. Measured on 2026-09-10, twice, in two different checks.
 */
const buttonExpression = `document.querySelector("button.status-job")?.textContent ?? null`;

const dialogExpression = `
  (() => {
    const dialog = document.querySelector(".dialog");
    if (dialog === null) return null;
    return {
      title: dialog.querySelector(".dialog-title")?.textContent ?? null,
      lines: [...dialog.querySelectorAll(".failure-line")].map((n) => n.textContent),
      install: [...dialog.querySelectorAll(".failure-install")].map((n) => n.textContent),
      buttons: [...dialog.querySelectorAll("button")].map((n) => n.textContent),
    };
  })()`;

/** Opens the asset in the preview pane, the way a person does. */
const openPreview = `
  (() => {
    const cell = document.querySelector(".cell");
    cell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    cell.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    cell.click();
    document.querySelector(".grid").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  })()`;

/**
 * Opens the parked list from the status bar, and tries again if the queue moved
 * under the click.
 */
async function openList(cdp) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await cdp.settle(buttonExpression, (text) => text !== null);
    await cdp.evaluate(`document.querySelector("button.status-job")?.click()`);
    try {
      return await cdp.settle(
        dialogExpression,
        (state) => state !== null && state.lines.length > 0,
        { attempts: 20 },
      );
    } catch {
      // The click landed on the queue rather than on the button. Ask again.
    }
  }
  throw new Error("the parked list never opened");
}

try {
  const root = await library();

  section("A photograph with a decoder present");
  {
    const window = await launch({ library: root });
    try {
      await window.cdp.settle("document.querySelectorAll('.cell').length", (n) => n === 1);
      check("the queue drew it, so the grid has a cell rather than a placeholder", true);

      await window.cdp.evaluate(openPreview);
      const picture = await window.cdp.settle(pictureExpression, (state) => state?.drawn === true, {
        attempts: 80,
      });
      check(
        "the pane asks for a rendition rather than the file a browser cannot read",
        picture.src === `roost://render/${await hashIn(root)}`,
        `src=${picture.src}`,
      );
      check(
        "and Chromium drew it, at the photograph's own size",
        picture.width === WIDTH && picture.height === HEIGHT,
        `${picture.width}×${picture.height}, wanted ${WIDTH}×${HEIGHT}`,
      );
    } finally {
      await window.close();
    }
  }

  section("The same library on a machine with no libheif");
  {
    // Pointed at a binary that does not exist rather than at a machine without
    // one: the path is identical, and this is the only way the absent case is
    // ever exercised where libheif happens to be installed.
    // Imported but **not** derived: the parking has to happen inside the
    // window's own engine, and a library derived here — where libheif is
    // present — would arrive with its picture already made.
    const bare = await library({ derive: false });
    const window = await launch({
      library: bare,
      env: { ROOST_HEIF_DEC: join(dir, "no-such-heif-dec") },
    });
    try {
      const status = await window.cdp.settle(buttonExpression, (text) =>
        text?.includes("install libheif"),
      );
      check(
        "the status bar names the backend rather than counting a failure",
        status.includes("install libheif"),
        `status=${JSON.stringify(status)}`,
      );

      const shown = await openList(window.cdp);
      check(
        "the list explains it in words",
        shown.lines.some((line) => line.includes("libheif")),
        `lines=${shown.lines.join(" / ")}`,
      );
      check(
        "and prints the command for this machine, beside its own Try again",
        shown.install.length === 1 && shown.buttons.includes("Try again"),
        `install=${shown.install.join(" / ")}`,
      );
    } finally {
      await window.close();
    }
  }

  report();
} catch (error) {
  console.error(error);
  process.exitCode = 2;
} finally {
  await rm(dir, { recursive: true, force: true });
}

/** A library holding one HEIC, derived here unless the caller wants it raw. */
async function library({ derive = true } = {}) {
  const source = await mkdtemp(join(dir, "photos-"));
  await mkdir(source, { recursive: true });
  await makeHeic(source, "iphone.heic", WIDTH, HEIGHT);

  const root = await mkdtemp(join(dir, "library-"));
  const opened = await Library.create(join(root, "HEIC.roost"), "HEIC");
  try {
    await importInto(opened, [source]);
    if (derive) {
      // Derived here rather than left to the window: the check is about what
      // the window does with the result, and racing the queue would make it
      // flake rather than fail.
      await runDerives(opened, { sizes: [GRID_SIZE] });
      if (queueStatus(opened).failed > 0) throw new Error("the fixture failed to derive");
    }
  } finally {
    await opened.close();
  }
  return join(root, "HEIC.roost");
}

/** The one asset's hash, for asserting the address the pane asked for. */
async function hashIn(root) {
  const opened = await Library.open(root, { readOnly: true });
  try {
    return opened.db.repo.allHashes()[0];
  } finally {
    await opened.close();
  }
}
