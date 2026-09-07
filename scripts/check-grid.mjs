/**
 * The grid, asserted against a **running window** (`UI_SPEC.md` §6, ADR-0018).
 *
 * This is the check six separate findings were waiting on, and every one of
 * them is invisible to a component test for the same two reasons: happy-dom
 * lays nothing out, so no box has a width, and it loads no stylesheet, so the
 * cascade is not there to get wrong. What was found by hand and had no guard:
 *
 * - The grid laid out against `clientWidth`, which includes the scroller's own
 *   padding, so every view was one gutter too wide and the rightmost column ran
 *   under the scrollbar with its edge cut off.
 * - The details header's `em` tracks resolved at `--text-sm` and a row's at
 *   `--text-base`, so the columns drifted 24px apart by the last one.
 * - Icons drew a ring on the picture and a fill on the caption, with a 4px seam
 *   of page background between them: two marks for one selected thing.
 * - Compact and Details drew that same treatment where a filled row was wanted.
 * - `.grid[data-view] .cell:hover` outranks `.cell[data-view][data-selected]`,
 *   so **hovering a selected row erased its fill**. Only a real pointer can see
 *   this: a dispatched `PointerEvent` is not a pointer, and `:hover` never
 *   matches for one.
 * - `--select-border` and `--border-focus` resolved to the same colour in both
 *   themes, so "the focused one is brighter" was a claim nothing could see.
 * - The scrollbar was Chromium's own — a stepper at each end and a thumb
 *   brighter than the pictures under it, the one widget in the window that
 *   ignored `data-theme`. Found in a screenshot, because a scrollbar has no
 *   computed style to read: the strip's width is the only handle on it, and
 *   only a real window has one.
 *
 * And the marquee, whose autoscroll, paint, and refusal to start on the
 * scrollbar strip are all gestures rather than state.
 *
 *   node scripts/check-grid.mjs
 *
 * Builds its own library in a temporary directory and deletes it again.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { ledger } from "./lib/checks.mjs";
import { imageLibrary, scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

/** Enough to overflow the scroller in every view, which is what autoscroll needs. */
const ASSETS = 60;

const { dir, dispose } = await scratch("check-grid");
const root = await imageLibrary(dir, { count: ASSETS });
const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

/** The scroller's content box, which is the box the layout is owed. */
const frameExpression = `
  (() => {
    const grid = document.querySelector(".grid");
    const frame = document.querySelector(".grid-frame");
    const style = getComputedStyle(grid);
    const box = grid.getBoundingClientRect();
    const pad = { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
    const cells = [...document.querySelectorAll(".cell")].map((cell) => {
      const r = cell.getBoundingClientRect();
      return { hash: cell.dataset.hash, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    return {
      contentLeft: box.left + pad.left,
      // clientWidth is the padding box: the strip the scrollbar reserves is
      // already outside it, and the padding is not.
      contentRight: box.left + grid.clientWidth - pad.right,
      bottom: box.bottom,
      scrollbar: getComputedStyle(frame).getPropertyValue("--scrollbar").trim(),
      overflow: Math.max(...cells.map((c) => c.right)) - (box.left + grid.clientWidth - pad.right),
      cells,
    };
  })()`;

/** The header's tracks and a row's, in the one place they have to agree. */
const headerExpression = `
  (() => {
    const header = document.querySelector(".details-header");
    const cell = document.querySelector('.cell[data-view="details"]');
    if (header === null || cell === null) return null;
    const lefts = (node) => [...node.children].map((c) => Math.round(c.getBoundingClientRect().left));
    const rights = (node) => [...node.children].map((c) => Math.round(c.getBoundingClientRect().right));
    return {
      headerLefts: lefts(header),
      cellLefts: lefts(cell),
      headerRights: rights(header),
      cellRights: rights(cell),
    };
  })()`;

const cellStyle = (index) => `
  (() => {
    const cell = document.querySelectorAll(".cell")[${index}];
    if (cell === undefined) return null;
    const style = getComputedStyle(cell);
    const name = cell.querySelector(".cell-name");
    const thumb = cell.querySelector(".cell-thumb");
    return {
      hash: cell.dataset.hash,
      selected: cell.dataset.selected !== undefined,
      focused: cell.dataset.focused !== undefined,
      background: style.backgroundColor,
      boxShadow: style.boxShadow,
      outlineColor: style.outlineColor,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
      nameBackground: name === null ? null : getComputedStyle(name).backgroundColor,
      thumbShadow: thumb === null ? null : getComputedStyle(thumb).boxShadow,
      thumbOutline: thumb === null ? null : getComputedStyle(thumb).outlineStyle,
    };
  })()`;

/**
 * A token's *resolved* colour.
 *
 * Reading the custom property gives back `var(--accent-4)`, which is why two
 * tokens holding one colour read as different for as long as nobody resolves
 * them.
 */
/**
 * What the scroller reserves, against what the token asks for.
 *
 * Measured off the element rather than read off a rule, because a scrollbar
 * pseudo-element is not in the computed style of anything.
 */
const stripExpression = `
  (() => {
    const grid = document.querySelector(".grid");
    const asked = getComputedStyle(document.documentElement)
      .getPropertyValue("--scrollbar-size");
    return { measured: grid.offsetWidth - grid.clientWidth, asked: parseFloat(asked) };
  })()`;

const resolve = (...tokens) => `
  (() => {
    const probe = document.createElement("span");
    document.body.append(probe);
    const seen = ${JSON.stringify(tokens)}.map((token) => {
      probe.style.color = \`var(\${token})\`;
      return getComputedStyle(probe).color;
    });
    probe.remove();
    return seen;
  })()`;

const selectedHashes = `
  [...document.querySelectorAll('.cell[aria-selected="true"]')].map((c) => c.dataset.hash)`;

async function setView(view) {
  await cdp.keyboard.press(String(["icons", "compact", "details"].indexOf(view) + 1), {
    ctrl: true,
  });
  await cdp.settle(
    `document.querySelector(".grid")?.dataset.view ?? null`,
    (seen) => seen === view,
  );
  // The layout runs off a measurement, and the measurement runs on a frame.
  await sleep(200);
}

/** Parks the pointer somewhere that is not the grid, so no `:hover` is left over. */
async function unhover() {
  const sidebar = await cdp.box(".sidebar");
  await cdp.mouse.move(sidebar.x, sidebar.y);
  await sleep(120);
}

/** A click on the scroller's own padding, which is background rather than a cell. */
async function clearSelection() {
  const grid = await cdp.box(".grid");
  await cdp.mouse.click(grid.left + 3, grid.top + 3);
  await cdp.settle(`${selectedHashes}.length`, (n) => n === 0);
}

async function clickCell(index) {
  const box = await cdp.evaluate(`
    (() => {
      const cell = document.querySelectorAll(".cell")[${index}];
      const r = cell.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
  await cdp.mouse.click(box.x, box.y);
  await cdp.settle(`${selectedHashes}.length`, (n) => n > 0);
  return box;
}

try {
  // Everything below reads either a layout the grid recomputes on a
  // `ResizeObserver` or a gesture drawn on an animation frame, and Chromium
  // stops delivering both for a window nothing is drawing. Measured rather than
  // assumed, and refused rather than reported: an uncomposited window makes the
  // grid keep the width it measured at mount and makes the marquee never
  // appear, which reads as two defects and is neither. `bench-window.mjs` sets
  // the precedent.
  const frames = await cdp.frameRate();
  if (frames < 5) {
    console.log(`Refused: ${frames} frames in 400ms — the window is not being composited.`);
    console.log("");
    console.log("That is the correct outcome on a machine that is not drawing this window.");
    console.log("Run it on a desktop session with the window visible.");
    process.exitCode = 1;
    throw new Uncomposited();
  }

  section("Layout, at the window's real width");
  await setView("icons");
  const icons = await cdp.evaluate(frameExpression);
  // One gutter too wide put the rightmost column under the scrollbar with its
  // edge cut off. In Icons that reads as a crop rather than as a bug.
  check(
    "no cell runs past the scroller's content box",
    icons.overflow <= 0,
    `overflow=${Math.round(icons.overflow)}px`,
  );
  check(
    "the scroller reserves a strip for its scrollbar, and says how wide",
    /^\d+(\.\d+)?px$/.test(icons.scrollbar) && parseFloat(icons.scrollbar) > 0,
    `--scrollbar=${icons.scrollbar}`,
  );

  await setView("details");
  const details = await cdp.evaluate(frameExpression);
  check(
    "and no row does either, where a clipped column loses a date",
    details.overflow <= 0,
    `overflow=${Math.round(details.overflow)}px`,
  );

  const header = await cdp.evaluate(headerExpression);
  // 24px apart by the sixth column, when the tracks were `em` and the two
  // places resolved them at different font sizes.
  const leftDrift = Math.max(
    ...header.headerLefts.map((left, at) => Math.abs(left - header.cellLefts[at])),
  );
  const rightDrift = Math.max(
    ...header.headerRights.map((right, at) => Math.abs(right - header.cellRights[at])),
  );
  check(
    "every header label starts over the column it names",
    header.headerLefts.length === 6 && leftDrift <= 1,
    `worst drift ${leftDrift}px across ${header.headerLefts.length}`,
  );
  check(
    "and ends over it, which is what giving the scrollbar strip back means",
    rightDrift <= 1,
    `worst drift ${rightDrift}px`,
  );

  section("The scrollbar is drawn, not inherited (UI_SPEC.md §2.5)");
  // A pseudo-element scrollbar has no computed style to read back, so the strip
  // is what stands in for it: Chromium's own is 15px on Linux and ours is what
  // `--scrollbar-size` asks for. If a `scrollbar-width` ever appears in the
  // stylesheet, Chromium drops the whole `::-webkit-scrollbar` block and this
  // is the line that notices.
  for (const density of ["comfortable", "compact"]) {
    await cdp.evaluate(`document.documentElement.dataset.density = ${JSON.stringify(density)}`);
    const strip = await cdp.evaluate(stripExpression);
    check(
      `the strip is the width the token asks for (${density})`,
      Math.abs(strip.measured - strip.asked) <= 1,
      `--scrollbar-size=${strip.asked}px measured=${strip.measured}px`,
    );
  }
  await cdp.evaluate('document.documentElement.dataset.density = "comfortable"');

  section("Two tokens, two roles");
  for (const theme of ["dark", "light"]) {
    await cdp.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    const [select, focus] = await cdp.evaluate(resolve("--select-border", "--border-focus"));
    // Both held one colour, in both themes: a selected card and a
    // selected-and-focused card differed by one pixel of ring width, and the
    // stylesheet read as though they differed.
    check(
      `--select-border is calmer than --border-focus (${theme})`,
      select !== focus,
      `${select} vs ${focus}`,
    );
  }
  await cdp.evaluate('document.documentElement.dataset.theme = "dark"');

  section("A selected row is filled, whole (Compact and Details)");
  await unhover();
  const unselected = await cdp.evaluate(cellStyle(1));
  const row = await clickCell(1);
  const selected = await cdp.evaluate(cellStyle(1));
  check(
    "the row itself is filled",
    selected.background !== unselected.background,
    `${unselected.background} → ${selected.background}`,
  );
  check(
    "the thumbnail carries no ring of its own",
    selected.thumbShadow === "none" && selected.thumbOutline === "none",
    `shadow=${selected.thumbShadow}`,
  );
  check(
    "and the label no pill of its own",
    selected.nameBackground === "rgba(0, 0, 0, 0)",
    `name=${selected.nameBackground}`,
  );
  check(
    "the roving ring is inside the fill and hairline, not a second rectangle around it",
    selected.focused && selected.outlineWidth === "1px" && selected.outlineOffset === "-1px",
    `${selected.outlineWidth} at ${selected.outlineOffset}`,
  );

  // The one that needs a real pointer. `:hover` does not match for a dispatched
  // event, so this claim could not be made from a page expression at all.
  await cdp.mouse.move(row.x, row.y);
  await sleep(150);
  const hovered = await cdp.evaluate(cellStyle(1));
  check(
    "hovering a selected row does not erase its fill",
    hovered.background === selected.background,
    `${selected.background} → ${hovered.background}`,
  );
  // Otherwise the check above passes on a build where hover does nothing at all.
  const neighbour = await cdp.evaluate(cellStyle(2));
  const neighbourBox = await cdp.evaluate(`
    (() => {
      const r = document.querySelectorAll(".cell")[2].getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
  await cdp.mouse.move(neighbourBox.x, neighbourBox.y);
  await sleep(150);
  const neighbourHovered = await cdp.evaluate(cellStyle(2));
  check(
    "while an unselected one does raise under the pointer",
    neighbourHovered.background !== neighbour.background,
    `${neighbour.background} → ${neighbourHovered.background}`,
  );
  await unhover();

  // Zebra striping is `nth-child(even)`, so whether a selected row keeps its
  // fill must not depend on which row it is.
  await cdp.keyboard.press("a", { ctrl: true });
  await cdp.settle(`${selectedHashes}.length`, (n) => n > 2);
  const [even, odd] = await Promise.all([cdp.evaluate(cellStyle(1)), cdp.evaluate(cellStyle(2))]);
  check(
    "and striping never shows through a selection",
    even.background === odd.background,
    `${even.background} / ${odd.background}`,
  );

  section("A selected card is one object (Icons)");
  await setView("icons");
  await unhover();
  // `Ctrl+A` above is still in force, and a card read while it is selected has
  // nothing to be compared against.
  await clearSelection();
  const plainCard = await cdp.evaluate(cellStyle(0));
  await clickCell(0);
  const card = await cdp.evaluate(cellStyle(0));
  // The ring was on the picture and the fill on the caption, with the 4px seam
  // between them showing page background — two marks for one selected thing.
  check(
    "the cell is filled behind the picture, the seam and the caption alike",
    card.background !== plainCard.background,
    `${plainCard.background} → ${card.background}`,
  );
  check(
    "and ringed at its own edge rather than around the thumbnail",
    card.boxShadow !== "none" && card.thumbShadow === "none",
    `cell=${card.boxShadow.slice(0, 40)}…`,
  );
  check(
    "the caption is not separately filled",
    card.nameBackground === "rgba(0, 0, 0, 0)",
    `name=${card.nameBackground}`,
  );
  check(
    "focus thickens the one ring instead of adding a second",
    card.focused && card.outlineColor === "rgba(0, 0, 0, 0)" && card.boxShadow.includes("3px"),
    `outline=${card.outlineColor}`,
  );

  section("The marquee");
  await setView("details");
  await unhover();
  const box = await cdp.evaluate(frameExpression);
  // Visual order, not DOM order: the grid is virtualised, so a recycled cell
  // can sit anywhere in the document whatever row it draws.
  const rows = [...box.cells].sort((a, b) => a.top - b.top);
  // The scroller's left padding: a press there is on the background, which is
  // where a sweep begins.
  const gutterX = Math.round(box.contentLeft - 3);
  const from = { x: gutterX, y: Math.round(rows[1].top + 2) };
  const to = { x: gutterX + 260, y: Math.round(rows[4].bottom - 2) };

  await cdp.mouse.move(from.x, from.y);
  await cdp.mouse.down(from.x, from.y);
  for (let step = 1; step <= 10; step += 1) {
    await cdp.mouse.move(
      Math.round(from.x + ((to.x - from.x) * step) / 10),
      Math.round(from.y + ((to.y - from.y) * step) / 10),
      { buttons: 1 },
    );
    await sleep(16);
  }
  await sleep(120);
  const inFlight = await cdp.evaluate(`
    (() => {
      const marquee = document.querySelector(".grid-marquee");
      if (marquee === null) return null;
      const style = getComputedStyle(marquee);
      const r = marquee.getBoundingClientRect();
      const crossed = [...document.querySelectorAll(".cell")]
        .filter((cell) => {
          const c = cell.getBoundingClientRect();
          return c.right > r.left && c.left < r.right && c.bottom > r.top && c.top < r.bottom;
        })
        .map((cell) => cell.dataset.hash);
      return {
        background: style.backgroundColor,
        border: style.borderTopColor,
        borderWidth: style.borderTopWidth,
        crossed,
        selected: ${selectedHashes},
        userSelect: getComputedStyle(document.querySelector(".grid")).userSelect,
      };
    })()`);
  check(
    "it is drawn while the hand is down",
    inFlight !== null &&
      inFlight.background !== "rgba(0, 0, 0, 0)" &&
      inFlight.border !== "rgba(0, 0, 0, 0)",
    inFlight === null ? "no marquee" : `${inFlight.background} inside ${inFlight.border}`,
  );
  check(
    "it takes exactly what it crosses",
    JSON.stringify([...inFlight.crossed].sort()) === JSON.stringify([...inFlight.selected].sort()),
    `crossed=${inFlight.crossed.length} selected=${inFlight.selected.length}`,
  );
  check(
    "and nothing under it is text to be dragged",
    inFlight.userSelect === "none",
    `user-select: ${inFlight.userSelect}`,
  );
  await cdp.mouse.up(to.x, to.y);
  await sleep(150);
  const swept = await cdp.evaluate(selectedHashes);
  check("the selection survives the release", swept.length === inFlight.crossed.length);
  check(
    "and the marquee does not",
    (await cdp.evaluate('document.querySelector(".grid-marquee") === null')) === true,
  );

  // `Ctrl` adds rather than toggling: a rect that grows and shrinks over the
  // same cell would otherwise flip it on and off as the hand wobbled.
  const lowerFrom = { x: gutterX, y: Math.round(rows[6].top + 2) };
  const lowerTo = { x: gutterX + 260, y: Math.round(rows[7].bottom - 2) };
  await cdp.mouse.move(lowerFrom.x, lowerFrom.y, { modifiers: 2 });
  await cdp.mouse.down(lowerFrom.x, lowerFrom.y, { modifiers: 2 });
  for (let step = 1; step <= 8; step += 1) {
    await cdp.mouse.move(
      Math.round(lowerFrom.x + ((lowerTo.x - lowerFrom.x) * step) / 8),
      Math.round(lowerFrom.y + ((lowerTo.y - lowerFrom.y) * step) / 8),
      { buttons: 1, modifiers: 2 },
    );
    await sleep(16);
  }
  await sleep(120);
  await cdp.mouse.up(lowerTo.x, lowerTo.y, { modifiers: 2 });
  await sleep(150);
  const added = await cdp.evaluate(selectedHashes);
  check(
    "Ctrl adds to what was already selected",
    added.length > swept.length && swept.every((hash) => added.includes(hash)),
    `${swept.length} + 2 → ${added.length}`,
  );

  // The press on the background is a sweep until it turns out to be a click,
  // and the clear happens on release — clearing on press would empty the
  // inspector at the start of every drag.
  const still = { x: gutterX, y: Math.round(rows[1].top + 4) };
  await cdp.mouse.move(still.x, still.y);
  await cdp.mouse.down(still.x, still.y);
  await sleep(120);
  const duringPress = await cdp.evaluate(`${selectedHashes}.length`);
  await cdp.mouse.up(still.x, still.y);
  await cdp.settle(`${selectedHashes}.length`, (n) => n === 0);
  check(
    "a press on the background clears on release, not on press",
    duringPress === added.length,
    `held ${duringPress} while down, 0 after`,
  );

  // The scrollbar strip is inside the scroller's box and outside its content: a
  // press there means "scroll", not "select nothing".
  await clickCell(1);
  const beforeStrip = await cdp.evaluate(`${selectedHashes}.length`);
  const stripX = await cdp.evaluate(`
    (() => {
      const grid = document.querySelector(".grid");
      const r = grid.getBoundingClientRect();
      return Math.round(r.left + grid.clientWidth + (r.width - grid.clientWidth) / 2);
    })()`);
  await cdp.mouse.down(stripX, Math.round(rows[3].top));
  await sleep(100);
  const strip = await cdp.evaluate(
    `({ marquee: document.querySelector(".grid-marquee") !== null, selected: ${selectedHashes}.length })`,
  );
  await cdp.mouse.up(stripX, Math.round(rows[3].top));
  await sleep(150);
  check(
    "a press on the scrollbar strip starts no sweep and clears nothing",
    !strip.marquee &&
      strip.selected === beforeStrip &&
      (await cdp.evaluate(`${selectedHashes}.length`)) === beforeStrip,
    `marquee=${strip.marquee} selected=${strip.selected}`,
  );

  // The sweep has to keep pulling while the pointer sits at the edge, even if
  // it never moves again — otherwise it stops the moment the hand does.
  await cdp.evaluate('document.querySelector(".grid").scrollTop = 0');
  await sleep(100);
  const edgeFrom = { x: gutterX, y: Math.round(rows[1].top + 2) };
  await cdp.mouse.move(edgeFrom.x, edgeFrom.y);
  await cdp.mouse.down(edgeFrom.x, edgeFrom.y);
  await cdp.mouse.move(edgeFrom.x + 40, Math.round(box.bottom - 4), { buttons: 1 });
  await sleep(900);
  const scrolled = await cdp.evaluate('document.querySelector(".grid").scrollTop');
  await cdp.mouse.up(edgeFrom.x + 40, Math.round(box.bottom - 4));
  check(
    "a sweep held at the bottom edge keeps pulling the scroller",
    scrolled > 0,
    `scrollTop=${Math.round(scrolled)}px`,
  );

  report();
} catch (error) {
  if (!(error instanceof Uncomposited)) {
    console.error(error);
    console.error(window.noise().slice(-4000));
    process.exitCode = 2;
  }
} finally {
  await window.close();
  await dispose();
}

/** Not a failure of the grid, so it does not print a stack. */
function Uncomposited() {}
Uncomposited.prototype = Object.create(Error.prototype);
