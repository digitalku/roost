/**
 * What could not be drawn, asserted against a **running window** (ADR-0050,
 * `UI_SPEC.md` §3.13).
 *
 *     node scripts/check-failures.mjs
 *
 * **It builds its own library** in a temporary directory and deletes it again.
 * Two of the files in it are deliberately broken — a PNG signature with nothing
 * behind it — because the whole feature is about what the window says when a
 * decode throws, and no fixture of valid images can produce that state.
 *
 * Since 2026-09-25 the window says it **on the file**, not in the status bar:
 * the bar counts nothing, the cell carries its badge, and selecting the file
 * puts a card in the inspector — what went wrong, what to try, and Try again,
 * Open externally and Show in folder. The preview says the same at full size.
 * Three things here cannot be checked anywhere else: the **message is the
 * backend's**, so only a run with `sharp` in it proves the sentence the card
 * shows is the one this build's failures map to; **Try again ignores the
 * attempts cap**, which is only visible by retrying and asking the queue; and
 * nothing the card adds may push the frame past the window.
 *
 * Open externally and Show in folder are found and not pressed: each hands
 * something to the desktop, and a check has no business opening applications
 * on somebody's screen.
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

/** A card, wherever it is drawn, in one round trip. */
const cardExpression = (where) => `
  (() => {
    const card = document.querySelector(${JSON.stringify(`${where} .file-problem`)});
    if (card === null) return null;
    return {
      line: card.querySelector(".file-problem-line")?.textContent ?? null,
      steps: [...card.querySelectorAll(".file-problem-steps li")].map((n) => n.textContent),
      said: card.querySelector(".file-problem-said")?.textContent ?? null,
      buttons: [...card.querySelectorAll(".file-problem-actions button")].map((n) => n.textContent),
    };
  })()`;

/** The ids of the cells whose badge says they could not be drawn. */
const brokenCells = `
  [...document.querySelectorAll(".cell")]
    .filter((cell) => cell.querySelector(".placeholder-badge")?.textContent === "Could not be drawn")
    .map((cell) => cell.dataset.id)`;

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
  await cdp.settle(brokenCells, (ids) => Array.isArray(ids) && ids.length === BROKEN);
  const bar = await cdp.evaluate(
    `[...document.querySelectorAll(".status .status-job")].map((n) => n.textContent)`,
  );
  check("it counts no failures — the file says it (ADR-0050)", bar.length === 0, bar.join(" | "));

  section("The grid");
  const ids = await cdp.evaluate(brokenCells);
  check("each broken file carries its badge", ids.length === BROKEN, `${ids.length} badged`);

  section("Selecting one");
  const box = await cdp.box(`[data-id="${ids[0]}"]`);
  await cdp.mouse.click(box.x, box.y);
  const card = await cdp.settle(cardExpression(".inspector"), (state) => state !== null);
  check(
    "the inspector says what went wrong, in words",
    card.line === "The file is damaged or incomplete",
    `line=${JSON.stringify(card.line)}`,
  );
  check("and what to try, as steps", card.steps.length >= 2, card.steps.join(" / "));
  check(
    "the backend's own message is kept, with no path in it",
    card.said !== null && card.said.length > 0 && !card.said.includes(dir),
    `said=${JSON.stringify(card.said)}`,
  );
  check(
    "with the three buttons the user chose",
    JSON.stringify(card.buttons) ===
      JSON.stringify(["Try again", "Open externally", "Show in folder"]),
    card.buttons.join(", "),
  );

  section("The window, which is not a page");
  const frame = await cdp.evaluate(overflowExpression);
  check(
    "nothing hangs out of the frame, so the window has no scrollbar of its own",
    frame.over === 0 && frame.wide === 0,
    `${frame.over}px below and ${frame.wide}px past the right, from ${frame.culprits.join(", ")}`,
  );

  section("Trying again");
  const attempts = () =>
    cdp.evaluate(
      `window.roost.invoke({ type: "derive:failures", state: "failed" }).then((o) => o.value.groups.map((g) => g.attempts))`,
    );
  check("one try so far", JSON.stringify(await attempts()) === "[1]");
  await cdp.evaluate(`
    [...document.querySelectorAll(".inspector .file-problem-actions button")]
      .find((button) => button.textContent === "Try again")?.click()`);
  // It fails again, and the second try is what shows the cap on attempts is
  // not the button's: a queue that refused would still say one.
  const tried = await cdp
    .settle(attempts, (list) => Array.isArray(list) && list.includes(2), {
      attempts: 100,
    })
    .catch(async () => await attempts());
  check(
    "the queue really did try this file again",
    Array.isArray(tried) && tried.includes(2),
    JSON.stringify(tried),
  );

  section("The preview");
  await cdp.keyboard.press("Enter");
  const big = await cdp
    .settle(
      `document.querySelector(".preview-unshowable .file-problem") !== null`,
      (value) => value === true,
    )
    .catch(() => false);
  check("the preview draws the same card, full size", big === true);
  const line = await cdp.evaluate(
    `document.querySelector(".preview-unshowable-line")?.textContent ?? null`,
  );
  check("under the same line", line === "The file is damaged or incomplete", JSON.stringify(line));
  await cdp.keyboard.press("Escape");

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
 * here (RL-11), so two copies of the same wreck would
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
