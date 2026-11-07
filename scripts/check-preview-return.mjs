/**
 * Closing the preview, asserted against a **running window** (`UI_SPEC.md` §7).
 *
 * The grid is unmounted while the preview is open, so what it comes back to is
 * a fresh scroller at the top, and the window has to put it back. happy-dom does
 * no layout and scrolls nothing, so only a window can say whether it did.
 * Reported 2026-11-07: a photograph opened halfway down and closed again left
 * the grid near the top.
 *
 *     node scripts/check-preview-return.mjs
 *
 * **It builds its own library** in a temporary directory and deletes it again.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { ledger } from "./lib/checks.mjs";
import { imageLibrary, scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

/** Enough that the grid scrolls, with room below the middle to step into. */
const ASSETS = 120;

/** How far the second section steps through the preview before closing it. */
const STEPS = 40;

const { dir, dispose } = await scratch("check-preview-return");
const root = await imageLibrary(dir, { count: ASSETS });
const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

const gridExpression = `
  (() => {
    const grid = document.querySelector(".grid");
    if (grid === null) return null;
    const ring = grid.getAttribute("aria-activedescendant");
    const cell = ring === null ? null : document.getElementById(ring);
    const frame = grid.getBoundingClientRect();
    const box = cell?.getBoundingClientRect();
    return {
      top: grid.scrollTop,
      ring: cell?.dataset.id ?? null,
      inView: box !== undefined && box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1,
    };
  })()`;

/** The asset in the middle of the grid, and where to click it. */
const middleExpression = `
  (() => {
    const frame = document.querySelector(".grid").getBoundingClientRect();
    const y = frame.top + frame.height / 2;
    const cell = [...document.querySelectorAll(".cell:not(.cell-folder)")].find((c) => {
      const box = c.getBoundingClientRect();
      return box.top < y && box.bottom > y;
    });
    if (cell === undefined) return null;
    const box = cell.getBoundingClientRect();
    return { id: cell.dataset.id, x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`;

/** Scrolls to `fraction` of the way down, then opens the asset in the middle. */
async function openFromMiddle(fraction) {
  const room = await cdp.evaluate(
    '(() => { const g = document.querySelector(".grid"); return g.scrollHeight - g.clientHeight; })()',
  );
  await cdp.evaluate(`document.querySelector(".grid").scrollTop = ${Math.floor(room * fraction)}`);
  await sleep(300);
  const scrolled = await cdp.evaluate('document.querySelector(".grid").scrollTop');
  const middle = await cdp.evaluate(middleExpression);
  await cdp.mouse.click(middle.x, middle.y);
  await cdp.keyboard.press("Enter");
  await cdp.settle("document.querySelector('.preview') !== null", (open) => open === true);
  await sleep(300);
  return { room, scrolled, middle };
}

async function closePreview() {
  await cdp.keyboard.press("Escape");
  await cdp.settle(gridExpression, (state) => state !== null);
  // Long enough for the grid to be measured and laid out again, which is the
  // frame the offset used to be lost in.
  await sleep(400);
  return cdp.evaluate(gridExpression);
}

try {
  await cdp.settle("document.querySelectorAll('.cell').length", (n) => n > 1);

  section("Opened and closed again");
  const first = await openFromMiddle(0.5);
  check("the fixture is tall enough to scroll", first.room > 400, `room=${first.room}px`);
  const back = await closePreview();
  check(
    "the grid is where it was scrolled to",
    Math.abs(back.top - first.scrolled) <= 2,
    `${first.scrolled}px -> ${back.top}px`,
  );
  check(
    "and the ring is on the asset that was opened",
    back.ring === first.middle.id && back.inView,
    `ring=${back.ring?.slice(0, 8) ?? null}… inView=${back.inView}`,
  );

  section("Stepped through and closed");
  const second = await openFromMiddle(0.3);
  for (let step = 0; step < STEPS; step += 1) await cdp.keyboard.press("ArrowRight");
  await sleep(300);
  const stepped = await closePreview();
  check(
    "the asset the preview ended on is in view",
    stepped.ring !== null && stepped.ring !== second.middle.id && stepped.inView,
    `ring=${stepped.ring?.slice(0, 8) ?? null}… inView=${stepped.inView}`,
  );
  check(
    "and the grid went down to it rather than back to the top",
    stepped.top > second.scrolled,
    `${second.scrolled}px -> ${stepped.top}px`,
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
