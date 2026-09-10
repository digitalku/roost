/**
 * What could not be drawn, asserted against a **running window**
 * (`UI_SPEC.md` §3.13).
 *
 *     node scripts/check-failures.mjs
 *
 * **It builds its own library** in a temporary directory and deletes it again.
 * Two of the files in it are deliberately broken — a PNG signature with nothing
 * behind it — because the whole feature is about what the queue says when a
 * decode throws, and no fixture of valid images can produce that state.
 *
 * Three things here cannot be checked anywhere else. The **message is the
 * backend's**, so only a run with `sharp` in it proves the sentence the window
 * shows is the one this build's failures actually map to. The **clipboard is
 * main's** (invariant 11), so `clipboard:copyText` reaching it is a fact about
 * the request allowlist and not about the renderer. And **Try again ignores the
 * attempts cap** — the bug that made the old button do nothing at all after
 * three tries — which is only visible by retrying and asking the queue again.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { importInto, Library, runDerives } from "@roost/library";
import { GRID_SIZE, gradient } from "@roost/media";
import { ledger } from "./lib/checks.mjs";
import { scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

/** Broken files, and therefore failed derives. */
const BROKEN = 2;

/** Whole ones, so the library is a library rather than a pile of wreckage. */
const WHOLE = 2;

const { dir, dispose } = await scratch("check-failures");
const root = await brokenLibrary(dir);

const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

/** What the dialog is showing, in one round trip. */
const dialogExpression = `
  (() => {
    const dialog = document.querySelector(".dialog");
    if (dialog === null) return null;
    return {
      title: dialog.querySelector(".dialog-title")?.textContent ?? null,
      lines: [...dialog.querySelectorAll(".failure-line")].map((n) => n.textContent),
      reasons: [...dialog.querySelectorAll(".failure-reason")].map((n) => n.textContent),
      asides: [...dialog.querySelectorAll(".failure-aside")].map((n) => n.textContent),
      files: [...dialog.querySelectorAll(".failure-files li")].map((n) => n.textContent),
      buttons: [...dialog.querySelectorAll("button")].map((n) => n.textContent),
    };
  })()`;

/** The status bar's line, but only while it is a button — that is, while the
 * queue has stopped and there is something to open. */
const buttonExpression = `
  document.querySelector("button.status-job")?.textContent ?? null`;

/**
 * Opens the list from the status bar, the way a person does.
 *
 * Two things here are the check being careful rather than the window being
 * fragile, and both were measured on 2026-09-10. The status bar is **one
 * element that changes what it is** — a `span` reading "Deriving… 2 to go"
 * while a run is in flight, a `button` when it has stopped — so a click aimed
 * at the button a moment earlier can land on the span and do exactly nothing,
 * which is what the span is for. And a **retry puts the queue back in flight**,
 * so the state after one oscillates for a second or so before it settles.
 *
 * So this waits for a button, clicks it with a real pointer, and tries again if
 * the list did not open. A dispatched `element.click()` was tried first and is
 * worse: it reaches the span too.
 */
const openList = async () => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await cdp.settle(buttonExpression, (text) => text !== null);
    const box = await cdp.evaluate(`
      (() => {
        const node = document.querySelector("button.status-job");
        if (node === null) return null;
        const rect = node.getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      })()`);
    if (box === null) continue;
    await cdp.mouse.click(box.x, box.y);
    try {
      return await cdp.settle(
        dialogExpression,
        (state) => state !== null && state.lines.length > 0,
        {
          attempts: 20,
        },
      );
    } catch {
      // The click landed on the queue rather than on the button. Ask again.
    }
  }
  throw new Error("the failure list never opened");
};

const clickButton = (label) => `
  [...document.querySelectorAll(".dialog button")]
    .find((button) => button.textContent === ${JSON.stringify(label)})?.click()`;

/**
 * What, if anything, hangs out of the window — and what it was.
 *
 * The state this check is already in is the one that found the defect on
 * 2026-09-10: the failure count is the only line in the status bar that is a
 * `button`, a button takes `--control-height` from the element rule, and the
 * bar's content box is that height *minus its own top border*. Half a pixel
 * over the bottom of the window was enough for Chromium to draw a second
 * scrollbar down the right edge — outside the inspector's — and to let the
 * whole layout be dragged up under a status bar that stayed where it was.
 *
 * It reads `scrollHeight` rather than whether a bar is on screen, because the
 * viewport is clipped (`app.css`): the frame is what must fit, and hiding the
 * symptom must not pass for fixing it. The names come back with it, since
 * "3px" on its own is a puzzle rather than a report.
 */
const overflowExpression = `
  (() => {
    const frame = document.documentElement;
    const culprits = [];
    const walk = (element) => {
      for (const child of element.children) {
        const style = getComputedStyle(child);
        const box = child.getBoundingClientRect();
        if (box.height > 0 && (box.bottom > frame.clientHeight + 0.4 || box.right > frame.clientWidth + 0.4)) {
          culprits.push(child.tagName.toLowerCase() + "." + (child.className || "?"));
        }
        // A scroller holds its own overflow; only what is laid out against the
        // frame can push the frame around.
        if (style.overflowX === "visible" && style.overflowY === "visible") walk(child);
      }
    };
    walk(document.body);
    return {
      over: frame.scrollHeight - frame.clientHeight,
      wide: frame.scrollWidth - frame.clientWidth,
      culprits: culprits.slice(0, 6),
    };
  })()`;

try {
  section("The status bar");
  const status = await cdp.settle(buttonExpression, (text) => text?.includes("could not be drawn"));
  check(
    "it counts what failed, and does not offer a retry it cannot explain",
    status === `${BROKEN} could not be drawn`,
    `status=${JSON.stringify(status)}`,
  );

  section("The window, which is not a page");
  const frame = await cdp.evaluate(overflowExpression);
  check(
    "nothing hangs out of the frame, so the window has no scrollbar of its own",
    frame.over === 0 && frame.wide === 0,
    `${frame.over}px below and ${frame.wide}px past the right, from ${frame.culprits.join(", ")}`,
  );

  section("The list");
  const shown = await openList();

  check(
    "the title is the count somebody clicked on",
    shown.title === `${BROKEN} could not be drawn`,
    `title=${JSON.stringify(shown.title)}`,
  );
  check(
    "one row, because both files broke the same way",
    shown.lines.length === 1 && shown.reasons.length === 1,
    `${shown.lines.length} rows: ${shown.lines.join(" / ")}`,
  );
  check(
    "and it says what that way was, in words",
    shown.lines[0] === "The file is damaged or incomplete",
    `line=${JSON.stringify(shown.lines[0])}`,
  );
  check(
    "the backend's own message is kept, with no path in it",
    shown.reasons[0].length > 0 && !shown.reasons[0].includes(dir),
    `reason=${JSON.stringify(shown.reasons[0])}`,
  );
  check(
    "and the files are named, which is what makes it something to act on",
    shown.files.length === BROKEN && shown.files.every((name) => name.startsWith("broken-")),
    `files=${shown.files.join(", ")}`,
  );

  section("The clipboard, which is main's");
  await cdp.evaluate(clickButton("Copy list"));
  const copied = await cdp.settle(dialogExpression, (state) => state.buttons.includes("Copied"));
  check(
    "Copy list reaches main and comes back having written something",
    copied.buttons.includes("Copied"),
    `buttons=${copied.buttons.join(", ")}`,
  );

  section("Trying again");
  await cdp.evaluate(clickButton("Try again"));
  await cdp.settle(dialogExpression, (state) => state === null);
  check("the list closes on the retry, rather than sitting over the answer", true);

  // The retry re-runs the derive, it fails again, and the count comes back.
  // What matters is the *second* opening: a queue that had refused to retry
  // would still say one attempt.
  const again = await openList();
  check(
    "and the queue really did try again — the cap on attempts is not the button's",
    again.asides.some((line) => line.startsWith("Tried 2 times")),
    `asides=[${again.asides.join(" / ")}] reasons=[${again.reasons.join(" / ")}]`,
  );

  report();
} catch (error) {
  console.error(error);
  console.error(window.noise().slice(-4000));
  process.exitCode = 2;
} finally {
  await window.close();
  await dispose();
}

/**
 * A library holding two whole images and two that only claim to be images.
 *
 * The broken pair differ in length on purpose: identical bytes are one asset
 * here (`STORAGE_SPEC.md` invariant 1), so two copies of the same wreck would
 * import as one file and fail once.
 */
async function brokenLibrary(where) {
  const source = join(where, "pictures");
  await mkdir(source, { recursive: true });
  for (let index = 0; index < WHOLE; index += 1) {
    await writeFile(join(source, `shot-${index}.png`), await gradient(64, 64, index + 1, "png"));
  }
  for (let index = 0; index < BROKEN; index += 1) {
    await writeFile(
      join(source, `broken-${index}.png`),
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(64 + index),
      ]),
    );
  }

  const root = join(where, "Failures.roost");
  const library = await Library.create(root, "Failures");
  try {
    await importInto(library, [source]);
    // Run the queue here rather than leaving it to the window: the check is
    // about what the window says once the failures exist, and a race between
    // the two would make it flake rather than fail.
    await runDerives(library, { sizes: [GRID_SIZE] });
  } finally {
    await library.close();
  }
  return root;
}
