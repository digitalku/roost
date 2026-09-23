/**
 * What is on screen is drawn first, asserted against a **running window**.
 *
 *     node scripts/check-derive-order.mjs
 *
 * **It builds its own library** in a temporary directory and deletes it again:
 * two thousand pictures imported and none of them derived, which is what a
 * large library looks like on its first open.
 *
 * The claim is about three processes at once, which is why it is a window
 * check. A cell asks `roost://thumb` for a picture that is not there; **main**
 * hears the miss and passes it on as `derive:wanted`; the **engine**'s queue
 * starts that asset next; and the renderer redraws the cell when the derive
 * event arrives. Every other test of this runs one of those pieces alone.
 *
 * **The screen it watches is the one the queue would reach last.** An import
 * queues its files in the order it met them, and the grid opens on the newest
 * import first — so the cells a window opens on are at the far end of the
 * queue's own order. The first draft of this check scrolled to the bottom of
 * the grid instead, and passed with the hint switched off: the bottom is the
 * oldest import, which the queue does first anyway. A check that cannot fail is
 * not one.
 *
 * The engine is started with a threadpool of one, so the queue takes long
 * enough to watch.
 */
import { ledger } from "./lib/checks.mjs";
import { imageLibrary, scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

const COUNT = 2000;

const { dir, dispose } = await scratch("check-derive-order");
const root = await imageLibrary(dir, { count: COUNT, size: 256 });

const window = await launch({ library: root, env: { UV_THREADPOOL_SIZE: "1" } });
const opened = Date.now();
const { cdp } = window;
const { check, section, report } = ledger();

/**
 * The cells inside the grid's viewport, and whether each has a picture.
 *
 * Whether the `<img>` actually **loaded**, not whether its address carries a
 * derive time: import already measures a file, so `v=` is on every address
 * from the start, and the first draft of this check passed on it with nothing
 * drawn at all.
 */
const visibleExpression = `
  (() => {
    const grid = document.querySelector(".grid");
    const box = grid.getBoundingClientRect();
    return [...document.querySelectorAll(".cell")]
      .filter((cell) => {
        const r = cell.getBoundingClientRect();
        return r.bottom > box.top && r.top < box.bottom;
      })
      .map((cell) => ({
        id: cell.dataset.id ?? null,
        drawn: (() => {
          const image = cell.querySelector(".cell-image");
          return image !== null && image.complete && image.naturalWidth > 0;
        })(),
      }));
  })()`;

const queuedExpression = `
  window.roost.invoke({ type: "derive:status" })
    .then((o) => (o.ok ? o.value.ready + o.value.running : null))`;

try {
  section("a library opened with its whole queue still to do");

  const start = await cdp.evaluate(queuedExpression);
  check("most of the queue is waiting when the grid first draws", start > COUNT / 2, start);

  section("the screen the window opened on");

  const onScreen = await cdp.settle(
    visibleExpression,
    (cells) => cells.length > 0 && cells.every((cell) => cell.drawn),
    { attempts: 300, everyMs: 100 },
  );
  const tookMs = Date.now() - opened;
  const left = await cdp.evaluate(queuedExpression);

  check("every cell on screen has its picture", onScreen.length > 0, `${onScreen.length} cells`);
  check(
    "they arrived while most of the queue was still waiting",
    left > COUNT / 2,
    `${left} of ${COUNT} still queued, ${tookMs} ms after the grid drew`,
  );
} finally {
  await window.close();
  await dispose();
}

report();
