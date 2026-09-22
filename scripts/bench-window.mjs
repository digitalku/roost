/**
 * Cold start and scroll frames, measured in a real window.
 *
 * `ROADMAP.md` M3 accepts on two numbers: a 100k-asset library open in under
 * 1.5 seconds, and a grid that scrolls at 60fps — **measured rather than
 * eyeballed**. This is the measuring.
 *
 *   node scripts/bench-window.mjs <LIBRARY.roost>
 *
 * Cold start is wall clock from spawning Electron to the first frame that has
 * grid rows in it, which the renderer stamps as `window.roostBench
 * .firstPaintAt`. Not "the window appeared" and not "the engine replied": a
 * window with nothing in it is not a started application.
 *
 * The scroll numbers come from the renderer's own benchmark, which **refuses to
 * report** when the window is not being composited. That refusal is the point.
 * Chromium throttles `requestAnimationFrame` for a hidden or occluded window,
 * and the numbers from one are not slow, they are meaningless — so this exits
 * non-zero rather than printing them, and on a headless machine that is the
 * correct outcome rather than a failure of the grid.
 */
import { firstPaint, launch, openLibrary } from "./lib/window.mjs";

const library = process.argv[2];
if (library === undefined) {
  console.error("usage: node scripts/bench-window.mjs <LIBRARY.roost>");
  process.exit(2);
}

// Opened after the window is up, and measured from there, because what is being
// measured is a page starting against a library that is already open — which is
// what a second launch does.
const window = await launch({ library, open: false });
const { cdp, spawnedAt } = window;

try {
  const openedAt = await openLibrary(cdp, library);
  const firstPaintAt = await firstPaint(cdp);

  console.log(`Library   ${library}`);
  console.log(`Assets    ${(await stats(cdp)).toLocaleString()}`);
  console.log("");
  console.log("Cold start");
  console.log(`  launch to first grid rows   ${firstPaintAt - spawnedAt} ms   (budget 1500)`);
  console.log(`  of which, opening the library ${firstPaintAt - openedAt} ms`);

  const result = await cdp.evaluate("window.roostBench.scroll({ durationMs: 5000 })");
  console.log("");
  if (result.refused !== undefined) {
    console.log(`Scroll    refused: ${result.refused}`);
    console.log("");
    console.log("That is the correct outcome on a machine that is not compositing this");
    console.log("window. Run it on a desktop session with the window visible.");
    process.exitCode = 1;
  } else {
    console.log("Scroll");
    console.log(
      `  frames                      ${result.frames.toLocaleString()} in ${Math.round(result.elapsedMs)} ms`,
    );
    console.log(`  scrolled                    ${result.scrolledPx.toLocaleString()} px`);
    console.log(
      `  rate                        ${result.fps} fps, steady at ~${result.steadyHz} Hz`,
    );
    console.log(`  median frame                ${result.medianMs} ms`);
    console.log(
      `  p95 / p99 / worst           ${result.p95Ms} / ${result.p99Ms} / ${result.worstMs} ms`,
    );
    console.log(`  hitches (1.5x the rhythm)   ${result.missed} (${result.missedPercent}%)`);
    console.log(`  over the 60fps budget       ${result.over60} (${result.over60Percent}%)`);
  }
} finally {
  await window.close();
}

async function stats(cdp) {
  const outcome = await cdp.evaluate(
    'window.roost.invoke({ type: "library:stats" }).then((o) => (o.ok ? o.value.assets : 0))',
  );
  return typeof outcome === "number" ? outcome : 0;
}
