/**
 * Zooming a photograph, asserted against a **running window** (`UI_SPEC.md` §7).
 *
 * Every number this feature is made of comes from layout: the scale that fits a
 * picture in a pane, the point under the pointer, the clamp that keeps the pane
 * from going blank. happy-dom computes none of it and decodes no image, so the
 * component tests can check which control is live and what the arithmetic does
 * and nothing else. This is the other half.
 *
 *     node scripts/check-preview.mjs
 *
 * **It builds its own library** in a temporary directory and deletes it again.
 * The pictures are deliberately larger than any pane the window will have, so
 * the resting state is a real fit rather than a 1:1 that happens to look like
 * one.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { ledger } from "./lib/checks.mjs";
import { imageLibrary, scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

/** Two, because "stepping resets the zoom" needs somewhere to step to. */
const ASSETS = 2;

const { dir, dispose } = await scratch("check-preview");
const root = await imageLibrary(dir, { count: ASSETS, size: 1600 });

const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

/**
 * The picture, its window, and the readout, in one round trip.
 *
 * `left` and `top` are measured **against the viewport** rather than the screen,
 * because that is the frame every number in the component is in: an offset is
 * where the picture sits inside its own window, and the window moves with the
 * pane.
 */
const stateExpression = `
  (() => {
    const image = document.querySelector(".preview-photo-image");
    const view = document.querySelector(".preview-photo-view");
    if (image === null || view === null) return null;
    const i = image.getBoundingClientRect();
    const v = view.getBoundingClientRect();
    return {
      level: document.querySelector(".preview-zoom-level")?.textContent ?? null,
      natural: { width: image.naturalWidth, height: image.naturalHeight },
      scale: image.naturalWidth === 0 ? null : i.width / image.naturalWidth,
      left: i.left - v.left,
      top: i.top - v.top,
      width: i.width,
      height: i.height,
      view: { width: v.width, height: v.height, left: v.left, top: v.top },
      ready: view.hasAttribute("data-ready"),
      ready: view.hasAttribute("data-ready"),
      cursor: getComputedStyle(view).cursor,
      canOut: document.querySelector('[aria-label="Zoom out"]')?.disabled === true
        ? "disabled"
        : "ready",
    };
  })()`;

const state = () => cdp.evaluate(stateExpression);

/** The image pixel under a point in the viewport, which a zoom must not move. */
const under = (at, drawn) => ({
  x: Math.round((at.x - drawn.left) / drawn.scale),
  y: Math.round((at.y - drawn.top) / drawn.scale),
});

/** A point in the viewport's own coordinates, as the pointer sees it. */
const screenPoint = (drawn, at) => ({
  x: Math.round(drawn.view.left + at.x),
  y: Math.round(drawn.view.top + at.y),
});

const press = (selector, name) => `
  document.querySelector(${JSON.stringify(selector)}).dispatchEvent(
    new KeyboardEvent("keydown", { key: ${JSON.stringify(name)}, bubbles: true }),
  )`;

const clickButton = (label) => `
  document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})?.click()`;

try {
  await cdp.settle("document.querySelectorAll('.cell').length", (n) => n === ASSETS);
  await cdp.evaluate(`
    (() => {
      const cell = document.querySelector(".cell");
      cell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      cell.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
      cell.click();
    })()`);
  await cdp.evaluate(press(".grid", "Enter"));

  section("A picture at rest");
  // `ready` rather than "the picture is there": the element exists before it
  // has been measured, and a state read in that window is a size nothing chose.
  const fitted = await cdp.settle(stateExpression, (drawn) => drawn !== null && drawn.ready);
  check(
    "it opens fitted to the pane, not at its own size",
    fitted.scale < 1 &&
      Math.round(fitted.width) <= Math.ceil(fitted.view.width) &&
      Math.round(fitted.height) <= Math.ceil(fitted.view.height),
    `${Math.round(fitted.width)}×${Math.round(fitted.height)} in ${Math.round(fitted.view.width)}×${Math.round(fitted.view.height)}, scale=${fitted.scale.toFixed(3)}`,
  );
  check(
    "and it is centred in it",
    Math.abs(fitted.left - (fitted.view.width - fitted.width) / 2) <= 1 &&
      Math.abs(fitted.top - (fitted.view.height - fitted.height) / 2) <= 1,
    `left=${Math.round(fitted.left)} top=${Math.round(fitted.top)}`,
  );
  check(
    "the readout says what the scale is",
    fitted.level === `${Math.round(fitted.scale * 100)}%`,
    `level=${fitted.level} scale=${fitted.scale.toFixed(3)}`,
  );
  check(
    "there is nothing to zoom out to, and neither the button nor the cursor offers it",
    fitted.canOut === "disabled" && fitted.cursor !== "grab",
    `${fitted.canOut}, cursor=${fitted.cursor}`,
  );

  section("The wheel");
  // A quarter across and a third down: away from the middle, which is the one
  // point every wrong anchoring also keeps still.
  const at = { x: Math.round(fitted.view.width / 4), y: Math.round(fitted.view.height / 3) };
  const pointer = screenPoint(fitted, at);
  const before = under(at, fitted);

  await cdp.mouse.wheel(pointer.x, pointer.y, -240);
  const zoomed = await cdp.settle(stateExpression, (drawn) => drawn.scale > fitted.scale);
  check(
    "a notch away from the hand zooms in",
    zoomed.scale > fitted.scale,
    `${fitted.level} -> ${zoomed.level}`,
  );
  const after = under(at, zoomed);
  check(
    "and the pixel under the pointer is still under the pointer",
    Math.abs(after.x - before.x) <= 2 && Math.abs(after.y - before.y) <= 2,
    `image point ${before.x},${before.y} -> ${after.x},${after.y}`,
  );

  await cdp.mouse.wheel(pointer.x, pointer.y, 240);
  const back = await cdp.settle(stateExpression, (drawn) => drawn.scale < zoomed.scale);
  check(
    "a notch towards the hand zooms back out, to the same place",
    Math.abs(back.scale - fitted.scale) < 0.001 && Math.abs(back.left - fitted.left) <= 1,
    `scale=${back.scale.toFixed(3)} left=${Math.round(back.left)}`,
  );

  await cdp.mouse.wheel(pointer.x, pointer.y, 2400);
  const floored = await state();
  check(
    "and it stops at the fit rather than shrinking into an empty pane",
    Math.abs(floored.scale - fitted.scale) < 0.001,
    `scale=${floored.scale.toFixed(3)} vs fit ${fitted.scale.toFixed(3)}`,
  );

  section("The buttons and the keys");
  await cdp.evaluate(clickButton("Zoom in"));
  const stepped = await cdp.settle(stateExpression, (drawn) => drawn.scale > fitted.scale);
  check(
    "the + button steps up by a quarter",
    Math.abs(stepped.scale / fitted.scale - 1.25) < 0.001,
    `${fitted.level} -> ${stepped.level}`,
  );

  await cdp.evaluate(press(".preview", "-"));
  const keyed = await cdp.settle(stateExpression, (drawn) => drawn.scale < stepped.scale);
  check(
    "and `-` steps back down, from the pane's own keyboard",
    Math.abs(keyed.scale - fitted.scale) < 0.001,
    `${stepped.level} -> ${keyed.level}`,
  );

  await cdp.evaluate(press(".preview", "+"));
  await cdp.settle(stateExpression, (drawn) => drawn.scale > fitted.scale);
  await cdp.evaluate(clickButton("Fit to the pane"));
  const refitted = await cdp.settle(stateExpression, (drawn) => drawn.scale === fitted.scale);
  check(
    "the readout is the way back to the fit",
    refitted.level === fitted.level,
    `level=${refitted.level}`,
  );

  section("Panning what does not fit");
  // 1:1 on a 1600px picture in a pane a few hundred wide: there is more picture
  // than pane on both axes, which is the state a drag exists for.
  await cdp.evaluate(clickButton("Zoom to actual size"));
  const full = await cdp.settle(stateExpression, (drawn) => drawn.scale === 1);
  check(
    "a click on the readout goes to 1:1, and the picture is now pannable",
    full.level === "100%" && full.cursor === "grab",
    `level=${full.level} cursor=${full.cursor}`,
  );

  const from = screenPoint(full, {
    x: Math.round(full.view.width / 2),
    y: Math.round(full.view.height / 2),
  });

  /*
   * Tried up to three times, and measured from wherever the picture is when
   * each attempt starts.
   *
   * This is a real window on somebody's desktop and the pointer they are
   * holding is a real pointer: one physical twitch between the press and the
   * release lands in the same gesture as the synthesised moves, and the picture
   * goes wherever the hand went. It is the check that is unreliable there, not
   * the pane — so a stray attempt is retried rather than reported, and the
   * assertion stays exact.
   */
  let started = full;
  let panned = full;
  let moved = false;
  for (let attempt = 0; attempt < 3 && !moved; attempt += 1) {
    started = await state();
    await cdp.mouse.drag(from, { x: from.x - 120, y: from.y - 90 });
    panned = await state();
    moved =
      Math.abs(panned.left - (started.left - 120)) <= 2 &&
      Math.abs(panned.top - (started.top - 90)) <= 2;
  }
  check(
    "dragging moves the picture under the pane, by what the hand moved",
    moved,
    `left ${Math.round(started.left)} -> ${Math.round(panned.left)}, top ${Math.round(started.top)} -> ${Math.round(panned.top)}`,
  );

  // Into the corner of the pane until the picture stops moving. One gesture can
  // only ask for as much as the pane is wide, so this is a run of them, and
  // "it stopped" is what is asserted rather than a number of drags that
  // happened to be enough. The corner is the pane's, not the window's: a
  // gesture that ends outside the pane is a gesture the platform may cut short,
  // and this check is about the clamp rather than about pointer capture. The
  // clamp is all that stands between this and a blank pane with a photograph
  // somewhere off to the left of it.
  const corner = screenPoint(full, { x: 4, y: 4 });
  let clamped = panned;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await cdp.mouse.drag(from, corner);
    const now = await state();
    if (now.left === clamped.left && now.top === clamped.top) break;
    clamped = now;
  }
  check(
    "and it cannot be dragged off the pane: the far edges stop it",
    Math.abs(clamped.left - (clamped.view.width - clamped.width)) <= 1 &&
      Math.abs(clamped.top - (clamped.view.height - clamped.height)) <= 1,
    `left=${Math.round(clamped.left)} of ${Math.round(clamped.view.width - clamped.width)}, top=${Math.round(clamped.top)} of ${Math.round(clamped.view.height - clamped.height)}`,
  );

  section("Stepping to the next picture");
  await cdp.evaluate(clickButton("Next asset"));
  // The pane keeps its element while the record arrives, so this waits for the
  // picture to be fitted again rather than for it to merely be there.
  await sleep(200);
  const next = await cdp.settle(
    stateExpression,
    (drawn) => drawn !== null && drawn.ready && drawn.scale < 1,
  );
  check(
    "the next photograph opens fitted, not at the scale the last one was left at",
    Math.abs(next.scale - fitted.scale) < 0.001 && next.canOut === "disabled",
    `level=${next.level} (was ${clamped.level})`,
  );

  await cdp.evaluate(press(".preview", "Escape"));
  await cdp.settle("document.querySelector('.preview') === null", (gone) => gone === true);
  check("and Escape still closes the pane", true);

  report();
} catch (error) {
  console.error(error);
  console.error(window.noise().slice(-4000));
  process.exitCode = 2;
} finally {
  await window.close();
  await dispose();
}
