/**
 * Folders, asserted against a **running window** (ADR-0033, and the inspector's
 * chips from the session before it).
 *
 * The unit tests cover what a folder *is* — a row, a membership, two journal
 * ops — and the component tests cover what each control sends. Neither can see
 * the thing this exists for: a sidebar, a tree order computed in the engine, a
 * dialog, and a real browser deciding what is on screen. The defect that
 * prompted all of it was of exactly that kind and was invisible to both:
 * `readSidebar` returned the folders sorted by name, the pane indented them by
 * depth, and every test passed while the window drew a tree that was not one.
 *
 *   node scripts/check-folders.mjs
 *
 * **It builds its own library** in a temporary directory and deletes it again,
 * so it can never touch anything of yours. The folder names are chosen to sort
 * the wrong way on purpose: `Alpha` is inside `Design` and `Beta` is inside
 * `Zebra`, so an alphabetical listing and the tree disagree about every row.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { ledger } from "./lib/checks.mjs";
import { foldersInto, imageLibrary, scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

/** Enough assets to file some and leave some outside every folder. */
const ASSETS = 6;
/** How many of them go into `Design/Alpha`. */
const FILED = 2;

const { dir, dispose } = await scratch("check-folders");
const root = await imageLibrary(dir, { count: ASSETS });
await foldersInto(root, [
  { name: "Design" },
  { name: "Alpha", parent: "Design", assets: FILED },
  { name: "Zebra" },
  { name: "Beta", parent: "Zebra" },
]);

const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

/** Every folder row on screen, in the order it is drawn. */
const treeExpression = `
  [...document.querySelectorAll(".sidebar-branch")].map((branch) => ({
    name: branch.querySelector(".sidebar-label")?.textContent ?? null,
    count: branch.querySelector(".sidebar-count")?.textContent ?? null,
    depth: branch.getAttribute("data-depth") ?? "0",
    twisty: branch.querySelector("button.sidebar-twisty")?.getAttribute("aria-expanded") ?? null,
    // Where the *name* starts, not where the row does. The indent is padding on
    // the branch, so the branch's own left edge never moves — measuring that
    // asserts nothing, and passed for a pane with no indentation at all.
    left: Math.round(
      branch.querySelector(".sidebar-label")?.getBoundingClientRect().left ?? 0,
    ),
  }))`;

/** The folder chips in the inspector, and whether the menu can be pressed. */
const chipsExpression = `
  (() => {
    const block = document.querySelector(".folders");
    if (block === null) return null;
    return {
      chips: [...block.querySelectorAll(".folder")].map((chip) => ({
        path: chip.querySelector("span")?.textContent ?? null,
        partial: chip.hasAttribute("data-partial"),
      })),
      trigger: block.querySelector(".folder-trigger")?.disabled === true ? "disabled" : "ready",
    };
  })()`;

const names = (rows) => rows.map((row) => `${row.depth}:${row.name}`).join(" ");

/** The window's own phrasing, so an expectation cannot be plural where it is not. */
const assetsPhrase = (count) => (count === 1 ? "1 asset" : `${count} assets`);

const tree = () => cdp.evaluate(treeExpression);

/** The row for a folder, by name, as a box the pointer can be aimed at. */
async function rowBox(name) {
  const index = (await tree()).findIndex((row) => row.name === name);
  if (index < 0) throw new Error(`no folder row called ${name}`);
  return cdp.evaluate(`
    (() => {
      const el = document.querySelectorAll(".sidebar-branch")[${index}]
        .querySelector(".sidebar-row");
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
}

async function pressTwisty(name) {
  const index = (await tree()).findIndex((row) => row.name === name);
  const box = await cdp.evaluate(`
    (() => {
      const el = document.querySelectorAll(".sidebar-branch")[${index}]
        .querySelector("button.sidebar-twisty");
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
  if (box === null) throw new Error(`${name} has no disclosure arrow`);
  await cdp.mouse.click(box.x, box.y);
}

/** Right-clicks a folder row and waits for its menu. */
async function folderMenu(name) {
  const box = await rowBox(name);
  await cdp.mouse.click(box.x, box.y, { button: "right" });
  return cdp.settle(
    "[...document.querySelectorAll('[role=menuitem]')].map((i) => i.textContent)",
    (list) => Array.isArray(list) && list.length > 0,
  );
}

const clickMenuItem = (label) => `
  [...document.querySelectorAll("[role=menuitem]")]
    .find((item) => item.textContent === ${JSON.stringify(label)})?.click()`;

async function clickFirstCell() {
  const cell = await cdp.box(".cell");
  await cdp.mouse.click(cell.x, cell.y);
  await cdp.settle(
    "document.querySelectorAll('.cell[aria-selected=\"true\"]').length",
    (n) => n > 0,
  );
}

/**
 * A folder's count, asked of the engine rather than read off the pane.
 *
 * The pane is what is under test, so a check that reads its own subject would
 * agree with it whatever either of them says.
 */
const folderCount = async (name) => {
  const rows = await cdp.evaluate(
    'window.roost.invoke({ type: "library:sidebar" }).then((o) => o.value.folders)',
  );
  return rows.find((row) => row.name === name)?.count ?? -1;
};

const liveCount = () =>
  cdp.evaluate('window.roost.invoke({ type: "assets:count", query: "" }).then((o) => o.value)');

const trashedCount = () =>
  cdp.evaluate(
    'window.roost.invoke({ type: "assets:count", query: "is:trashed" }).then((o) => o.value)',
  );

try {
  section("The tree, in the order it is drawn");
  const initial = await cdp.settle(
    treeExpression,
    (rows) => Array.isArray(rows) && rows.length > 0,
  );
  // The defect ADR-0033 §2 is about. Sorted by name these are Alpha, Beta,
  // Design, Zebra — and indented by depth, `Alpha` would be drawn one step in
  // under nothing at all.
  check(
    "the top level is drawn, and only the top level",
    names(initial) === "0:Design 0:Zebra",
    names(initial),
  );
  check(
    "a closed branch still says how much is under it",
    initial.find((row) => row.name === "Design")?.count === String(FILED),
    `Design=${initial.find((row) => row.name === "Design")?.count}`,
  );
  check(
    "a folder with children has an arrow, and it reads closed",
    initial.every((row) => row.twisty === "false"),
    initial.map((row) => `${row.name}=${row.twisty}`).join(" "),
  );

  section("Expanding and collapsing");
  await pressTwisty("Design");
  const opened = await cdp.settle(treeExpression, (rows) => rows.length === 3);
  check(
    "the arrow opens exactly one branch",
    names(opened) === "0:Design 1:Alpha 0:Zebra",
    names(opened),
  );
  check(
    "the child is indented past its parent",
    (opened[1]?.left ?? 0) > (opened[0]?.left ?? 0),
    `Design=${opened[0]?.left}px Alpha=${opened[1]?.left}px`,
  );
  check(
    "a leaf gets no arrow rather than one that does nothing",
    opened[1]?.twisty === null,
    `Alpha twisty=${opened[1]?.twisty}`,
  );
  check("and the parent's arrow now reads open", opened[0]?.twisty === "true");

  await pressTwisty("Design");
  const closed = await cdp.settle(treeExpression, (rows) => rows.length === 2);
  check("pressing it again closes it", names(closed) === "0:Design 0:Zebra", names(closed));

  section("Making a folder from the pane");
  const plus = await cdp.box(".sidebar-add");
  await cdp.mouse.click(plus.x, plus.y);
  await cdp.settle(
    "document.querySelector('[role=dialog] .dialog-title')?.textContent ?? null",
    (t) => t === "New folder",
  );
  // Typed into whatever the dialog focused, which is the claim: a dialog that
  // opens without the caret in its field is one nobody can answer by typing.
  for (const letter of "Logos") await cdp.keyboard.press(letter);
  const typed = await cdp.evaluate("document.activeElement?.value ?? null");
  check("the caret starts in the field", typed === "Logos", `field=${JSON.stringify(typed)}`);
  await cdp.keyboard.press("Enter");
  const withLogos = await cdp.settle(treeExpression, (rows) => rows.length === 3);
  check(
    "the folder arrives at the top level, in tree order",
    names(withLogos) === "0:Design 0:Logos 0:Zebra",
    names(withLogos),
  );

  section("A subfolder, and a name the engine refuses");
  let items = await folderMenu("Logos");
  check(
    "the row's menu offers the three commands",
    ["New subfolder…", "Rename…", "Delete folder…"].every((label) => items.includes(label)),
    items.join(" · "),
  );
  await cdp.evaluate(clickMenuItem("New subfolder…"));
  await cdp.settle("document.querySelector('[role=dialog]') !== null", (there) => there === true);
  const inside = await cdp.evaluate(
    "document.querySelector('[role=dialog] .dialog-body')?.textContent ?? null",
  );
  check(
    "the dialog says which folder it is inside",
    inside === "Inside Logos.",
    `body=${JSON.stringify(inside)}`,
  );

  // A `/` is refused by `@roost/library`, and the window has no copy of that
  // rule — so this is the only place the refusal can be seen at all.
  for (const letter of "a/b") await cdp.keyboard.press(letter);
  await cdp.keyboard.press("Enter");
  const refusal = await cdp.settle(
    "document.querySelector('.dialog-problem')?.textContent ?? null",
    (text) => typeof text === "string" && text.length > 0,
    { attempts: 30 },
  );
  check("a name with a slash is refused, and the dialog says why", true, refusal);
  check(
    "and the dialog stays open with the name still in it",
    (await cdp.evaluate("document.querySelector('[role=dialog] input')?.value ?? null")) === "a/b",
  );
  await cdp.keyboard.press("Escape");
  await cdp.settle("document.querySelector('[role=dialog]') === null", (gone) => gone === true);

  section("Renaming");
  items = await folderMenu("Zebra");
  await cdp.evaluate(clickMenuItem("Rename…"));
  await cdp.settle(
    "document.querySelector('[role=dialog] input')?.value ?? null",
    (value) => value === "Zebra",
  );
  await cdp.evaluate("document.querySelector('[role=dialog] input').select()");
  for (const letter of "Aardvark") await cdp.keyboard.press(letter);
  await cdp.keyboard.press("Enter");
  const renamed = await cdp.settle(
    treeExpression,
    (rows) => Array.isArray(rows) && rows.every((row) => row.name !== "Zebra"),
  );
  // Renamed *and* re-sorted: siblings are alphabetical, so the row moves.
  check(
    "the tree re-sorts around the new name",
    names(renamed) === "0:Aardvark 0:Design 0:Logos",
    names(renamed),
  );
  // It used to: `onDone` revealed the folder it had just renamed, so a gesture
  // about a name sprang the branch open under it.
  check(
    "and renaming does not spring the branch open",
    renamed.every((row) => row.name !== "Beta"),
    names(renamed),
  );

  section("The folder chips in the inspector");
  await pressTwisty("Design");
  const alpha = await rowBox("Alpha");
  await cdp.mouse.click(alpha.x, alpha.y);
  await cdp.settle("document.querySelectorAll('.cell').length", (n) => n === FILED);
  await clickFirstCell();
  const chips = await cdp.settle(chipsExpression, (state) => state?.chips.length > 0);
  check(
    "an asset shows the whole path of the folder it is in",
    chips.chips[0]?.path === "Design/Alpha",
    `chips=${JSON.stringify(chips.chips)}`,
  );

  // `Ctrl+Delete` is bound on the window, and what it acts on is the folder
  // whose query is on screen (`UI_SPEC.md` §9).
  await cdp.keyboard.press("Delete", { ctrl: true });
  // The grid re-pages only when the library's counts move, and taking an asset
  // out of a folder moves neither — so this passes only because the window
  // drops the row itself. Without that it went on showing an asset the status
  // bar had just said was gone.
  await cdp.settle("document.querySelectorAll('.cell').length", (n) => n === FILED - 1);
  check(
    "Ctrl+Delete takes the selection out of the folder on screen",
    true,
    `${FILED} -> ${FILED - 1}`,
  );
  check(
    "it is not a delete: the library still holds every asset",
    (await liveCount()) === ASSETS,
    `live=${await liveCount()}`,
  );
  check(
    "and the status bar says which folder it left",
    (await cdp.evaluate("document.querySelector('.status-note')?.textContent ?? null")) ===
      "Removed 1 asset from Alpha",
  );

  section("Dragging assets onto a folder");
  // Back to everything, so there is no folder to move *out* of: the same drop
  // means add here and move from inside a folder, and both are asserted.
  await cdp.evaluate(`
    [...document.querySelectorAll(".sidebar-row")]
      .find((row) => row.querySelector(".sidebar-label")?.textContent === "All assets")?.click()`);
  await cdp.settle("document.querySelectorAll('.cell').length", (n) => n === ASSETS);
  await clickFirstCell();
  const dragged = await cdp.evaluate(
    "document.querySelector('.cell[aria-selected=\"true\"]')?.dataset.hash ?? null",
  );

  // The ghost only exists between `dragstart` and the next frame, so it is
  // measured from inside the page — a `dragstart` listener on the document runs
  // after the grid's own, which is where it is made.
  await cdp.evaluate(`
    window.__ghost = null;
    document.addEventListener("dragstart", () => {
      const el = document.querySelector(".drag-ghost");
      const box = el?.getBoundingClientRect();
      window.__ghost = box === undefined ? null : { w: Math.round(box.width), h: Math.round(box.height) };
      window.__ghostCount = el?.querySelector(".drag-ghost-count")?.textContent ?? null;
    });`);

  const cell = await cdp.box(".cell[aria-selected='true']");
  await cdp.dragAndDrop(cell, await rowBox("Aardvark"));

  const ghost = await cdp.evaluate("window.__ghost");
  // The browser's own drag image is a snapshot of the cell, which at this zoom
  // is most of the content column — it covered the sidebar it was being
  // dragged to (reported 2026-09-07).
  check(
    "the drag carries a thumbnail-sized picture, not the whole cell",
    ghost?.w === 64 && ghost?.h === 64,
    `ghost=${JSON.stringify(ghost)}`,
  );
  check(
    "and it is taken out of the document again",
    (await cdp.evaluate("document.querySelectorAll('.drag-ghost').length")) === 0,
  );
  await cdp.settle(
    "document.querySelector('.status-note')?.textContent ?? null",
    (note) => note === "Added 1 asset to Aardvark",
    { attempts: 40 },
  );
  check("a drop from All assets adds, because there is nothing to leave", true);
  check(
    "and the folder's count follows",
    (await tree()).find((row) => row.name === "Aardvark")?.count === "1",
    `Aardvark=${(await tree()).find((row) => row.name === "Aardvark")?.count}`,
  );

  // From inside a folder the same gesture is a move, which is the half that
  // needs the grid to drop the row as well as the engine to write two ops.
  const aardvark = await rowBox("Aardvark");
  await cdp.mouse.click(aardvark.x, aardvark.y);
  await cdp.settle("document.querySelectorAll('.cell').length", (n) => n === 1);
  await clickFirstCell();
  const moved = await cdp.box(".cell[aria-selected='true']");
  await cdp.dragAndDrop(moved, await rowBox("Design"));
  await cdp.settle(
    "document.querySelector('.status-note')?.textContent ?? null",
    (note) => note === "Moved 1 asset from Aardvark to Design",
    { attempts: 40 },
  );
  check("a drop from inside a folder moves", true, `${dragged?.slice(0, 8)}…`);
  check(
    "and the grid drops the row it was dragged out of",
    (await cdp.evaluate("document.querySelectorAll('.cell').length")) === 0,
    `cells=${await cdp.evaluate("document.querySelectorAll('.cell').length")}`,
  );
  // The claim is about the asset, not about two counts: a folder count is a
  // *subtree* count, so `Design` legitimately reads 2 — its own new member and
  // the one still in `Alpha`.
  const filedIn = await cdp.evaluate(
    `window.roost
      .invoke({ type: "asset:detail", hash: ${JSON.stringify(dragged)} })
      .then((o) => o.value.folders.map((f) => f.path))`,
  );
  check(
    "a move leaves one membership, not two",
    Array.isArray(filedIn) && filedIn.length === 1 && filedIn[0] === "Design",
    `folders=${JSON.stringify(filedIn)}`,
  );

  // Several at once. The payload is the **selection**, not the cell the drag
  // started on, so this is the same code path with a longer list — and the
  // ghost has to say so, or a picture of one asset stands over a drag of two.
  await cdp.evaluate(`
    [...document.querySelectorAll(".sidebar-row")]
      .find((row) => row.querySelector(".sidebar-label")?.textContent === "All assets")?.click()`);
  await cdp.settle("document.querySelectorAll('.cell').length", (n) => n === ASSETS);
  const cells = await cdp.evaluate(`
    [...document.querySelectorAll(".cell")].slice(0, 2).map((cell) => {
      const r = cell.getBoundingClientRect();
      return { hash: cell.dataset.hash, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })`);
  await cdp.mouse.click(cells[0].x, cells[0].y);
  // A real Ctrl-click, so the selection is built the way a person builds one.
  await cdp.mouse.click(cells[1].x, cells[1].y, { modifiers: 2 });
  await cdp.settle(
    "document.querySelectorAll('.cell[aria-selected=\"true\"]').length",
    (n) => n === 2,
  );

  // Measured again rather than reused: clicking a cell moves the roving focus,
  // and the grid scrolls to it — so a box taken before the clicks can point at
  // the background by the time the drag starts, where a press begins a marquee
  // instead of a drag.
  const second = await cdp.evaluate(`
    (() => {
      const el = document.querySelector('.cell[data-hash="${cells[1].hash}"]');
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
  await cdp.dragAndDrop(second, await rowBox("Logos"));
  await cdp.settle(
    "document.querySelector('.status-note')?.textContent ?? null",
    (note) => note === "Added 2 assets to Logos",
    { attempts: 40 },
  );
  check("a drag started on one selected cell carries all of them", true, "2 assets");
  check(
    "and the ghost says how many are coming",
    (await cdp.evaluate("window.__ghostCount")) === "2",
    `badge=${JSON.stringify(await cdp.evaluate("window.__ghostCount"))}`,
  );
  check(
    "both arrive, and the folder's count says two",
    (await folderCount("Logos")) === 2,
    `Logos=${await folderCount("Logos")}`,
  );

  section("Dragging a folder onto another");
  // `Design` is open from the section above, so its subtree is on screen and
  // the row that arrives can be seen without pressing anything.
  await cdp.dragAndDrop(await rowBox("Aardvark"), await rowBox("Design"));
  const reparented = await cdp.settle(
    treeExpression,
    (rows) => rows.length === 4 && rows[0]?.name === "Design",
  );
  check(
    "it becomes a child, sorted among its new siblings",
    names(reparented) === "0:Design 1:Aardvark 1:Alpha 0:Logos",
    names(reparented),
  );

  // The one refusal the engine makes and the pane cannot: a folder into its own
  // subtree cuts that subtree off from the root. The pane refuses only the
  // self-drop, because it is the case a `dragover` can see without the tree.
  await cdp.dragAndDrop(await rowBox("Design"), await rowBox("Alpha"));
  const refused = await cdp.settle(
    "document.querySelector('.problem')?.textContent ?? null",
    (text) => typeof text === "string" && text.length > 0,
    { attempts: 40 },
  );
  check("a folder dropped into its own subtree is refused, and says so", true, refused.trim());
  check(
    "and the tree is unchanged by the refusal",
    names(await tree()) === "0:Design 1:Aardvark 1:Alpha 0:Logos",
    names(await tree()),
  );

  // Back out again, through the keyboard's half of the same gesture.
  await folderMenu("Aardvark");
  await cdp.evaluate(clickMenuItem("Move to top level"));
  const back = await cdp.settle(
    treeExpression,
    (rows) => rows[0]?.name === "Aardvark" && rows[0]?.depth === "0",
  );
  check(
    "Move to top level brings it back out",
    names(back) === "0:Aardvark 0:Design 1:Alpha 0:Logos",
    names(back),
  );

  section("Deleting a folder, leaving its assets alone");
  // `Aardvark` is the empty one by now — what it held was moved to `Design`
  // above, and `Logos` has the two that were dropped on it.
  items = await folderMenu("Aardvark");
  await cdp.evaluate(clickMenuItem("Delete folder…"));
  const empty = await cdp.settle(
    `(() => {
      const el = document.querySelector("[role=alertdialog]");
      return el === null ? null : {
        title: el.querySelector(".dialog-title")?.textContent ?? null,
        option: el.querySelector(".dialog-option") === null ? "none" : "offered",
      };
    })()`,
    (state) => state !== null,
  );
  // Nothing is in `Logos`, so there is nothing to ask about — and a checkbox
  // offering to trash nothing is a question with one answer.
  check("an empty folder is not asked about its contents", empty.option === "none", empty.option);
  await cdp.evaluate(
    "[...document.querySelectorAll('[role=alertdialog] button')].find((b) => b.textContent === 'Delete folder')?.click()",
  );
  await cdp.settle(treeExpression, (rows) => !rows.some((row) => row.name === "Aardvark"));
  check("it goes", true, "Aardvark gone");

  section("Deleting a folder and its contents");
  // Taken from the row rather than from a constant: the drags above changed
  // what is in there, and the dialog's own number comes from the same place.
  const held = Number((await tree()).find((row) => row.name === "Design")?.count ?? 0);
  await folderMenu("Design");
  await cdp.evaluate(clickMenuItem("Delete folder…"));
  const asked = await cdp.settle(
    `(() => {
      const el = document.querySelector("[role=alertdialog]");
      if (el === null) return null;
      const box = el.querySelector(".dialog-option input");
      return {
        body: el.querySelector(".dialog-body")?.textContent ?? null,
        label: el.querySelector(".dialog-option span")?.textContent ?? null,
        checked: box?.checked ?? null,
        focused: document.activeElement?.textContent ?? null,
      };
    })()`,
    (state) => state !== null,
  );
  check(
    "the count in the question is the folder's own subtree count",
    asked.label === `Also move ${assetsPhrase(held)} to the trash`,
    `label=${JSON.stringify(asked.label)}`,
  );
  check("the box starts unticked", asked.checked === false);
  check(
    "and focus starts on Cancel, as an alert dialog's does",
    asked.focused === "Cancel",
    `focus=${JSON.stringify(asked.focused)}`,
  );

  await cdp.evaluate("document.querySelector('.dialog-option input').click()");
  await sleep(50);
  check(
    "ticking it is a real state change, not a label",
    (await cdp.evaluate("document.querySelector('.dialog-option input')?.checked ?? null")) ===
      true,
  );
  await cdp.evaluate(
    "[...document.querySelectorAll('[role=alertdialog] button')].find((b) => b.textContent === 'Delete folder')?.click()",
  );
  await cdp.settle(treeExpression, (rows) => !rows.some((row) => row.name === "Design"));

  check(
    "the assets in it went to the trash",
    (await trashedCount()) === held,
    `trashed=${await trashedCount()}`,
  );
  check(
    "trashed, not removed — the library still holds them",
    (await liveCount()) === ASSETS - held,
    `live=${await liveCount()}`,
  );
  check(
    "and the status bar says both halves of what it did",
    (await cdp.evaluate("document.querySelector('.status-note')?.textContent ?? null")) ===
      `Deleted Design, and moved ${assetsPhrase(held)} to the trash`,
    JSON.stringify(
      await cdp.evaluate("document.querySelector('.status-note')?.textContent ?? null"),
    ),
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
