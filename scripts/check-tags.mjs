/**
 * The tags page, asserted against a **running window** (ADR-0061).
 *
 *     node scripts/check-tags.mjs
 *
 * The component tests drive the page against a fake engine, and two things
 * they cannot do are the reason this exists: a real HTML5 drag of a tag onto a
 * group, and the context menu's *Move to group* submenu reached by a real
 * pointer, which needs geometry happy-dom does not have. It also asserts that
 * every gesture landed in the journal on disk, and that `Delete` on the page
 * never reached the grid's selection.
 *
 * **It builds its own library** in a temporary directory and deletes it again.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createTagGroup, Library, setTagGroup } from "@roost/library";
import { ledger } from "./lib/checks.mjs";
import { imageLibrary, scratch, tagsOnto } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

const { dir, dispose } = await scratch("check-tags");
const root = await imageLibrary(dir, { count: 4, size: 64, name: "Tags" });
// olahraga on the first two, traveling on the last two, wood on the first.
await tagsOnto(root, ["olahraga"], 2);
await tagsOnto(root, ["traveling"], 2, 2);
await tagsOnto(root, ["wood"], 1);
{
  const library = await Library.open(root);
  try {
    const materials = await createTagGroup(library, "Materials");
    await setTagGroup(library, ["wood"], materials);
  } finally {
    await library.close();
  }
}

const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

/** Where an element is whose own text, or a child's, is exactly `text`. */
const centre = (selector, text, inner = null) =>
  cdp.evaluate(`(() => {
    const found = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => {
      const label = ${inner === null ? "node" : `node.querySelector(${JSON.stringify(inner)})`};
      return label !== null && label.textContent.trim() === ${JSON.stringify(text)};
    });
    if (found === undefined) return null;
    const box = found.getBoundingClientRect();
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  })()`);

const place = async (selector, text, inner = null) => {
  const at = await centre(selector, text, inner);
  if (at === null) throw new Error(`no ${selector} saying ${text}`);
  return at;
};

const tagRow = (name) => place(".tags-row", name, ".tags-name");
const groupRow = (name) => place(".tags-groups .sidebar-row", name, ".sidebar-label");
const menuItem = (name) => place('[role="menuitem"]', name, ".menu-label");

const STATE = `({
    page: document.querySelector(".tags-page") !== null,
    grid: document.querySelector(".grid-frame") !== null,
    inspector: document.querySelector(".inspector") !== null,
    groups: [...document.querySelectorAll(".tags-groups .sidebar-row")].map((row) =>
      row.querySelector(".sidebar-label").textContent + "=" + row.querySelector(".sidebar-count").textContent),
    tags: [...document.querySelectorAll(".tags-row")].map((row) =>
      row.querySelector(".tags-name").textContent + "=" + row.querySelector(".sidebar-count").textContent),
    query: document.querySelector(".search-input")?.value ?? null,
    cells: document.querySelectorAll(".cell:not(.cell-folder)").length,
  })`;
const state = () => cdp.evaluate(STATE);
const settled = (test, attempts = 40) => cdp.settle(STATE, test, { attempts });

/** Every journal line on disk, parsed. */
async function journal() {
  const months = (await readdir(join(root, "journal"))).filter((name) => name.endsWith(".jsonl"));
  const lines = [];
  for (const month of months.sort()) {
    const text = await readFile(join(root, "journal", month), "utf8");
    for (const line of text.split("\n")) if (line !== "") lines.push(JSON.parse(line));
  }
  return lines;
}

try {
  section("A row under Untagged opens the page in the grid's place");
  await cdp.settle('document.querySelectorAll(".cell").length', (n) => n >= 4, { attempts: 100 });
  // A selection in the grid first, to show `Delete` on the page cannot reach it.
  const cell = await cdp.box(".cell");
  await cdp.mouse.click(cell.x, cell.y);
  await cdp.mouse.click(
    ...Object.values(await place("nav.sidebar .sidebar-row", "Tags", ".sidebar-label")),
  );
  const opened = await cdp.settle(`document.querySelectorAll(".tags-row").length`, (n) => n === 3);
  const first = await state();
  check("the page is drawn, with every tag", opened === 3, first.tags.join(", "));
  check("the grid and the inspector are away", !first.grid && !first.inspector);
  check(
    "the groups say how many tags each holds",
    first.groups.join(",") === "All tags=3,Ungrouped=2,Materials=1",
    first.groups.join(","),
  );

  section("Move to group, through the submenu, with a real pointer");
  const olahraga = await tagRow("olahraga");
  await cdp.mouse.click(olahraga.x, olahraga.y);
  await cdp.mouse.click(olahraga.x, olahraga.y, { button: "right" });
  await cdp.settle(`document.querySelectorAll('[role="menuitem"]').length`, (n) => n >= 4);
  // Onto the trigger in steps, then a click, which opens a submenu as surely
  // as a hover and does not depend on how far one move happened to jump.
  const trigger = await menuItem("Move to group");
  for (let step = 1; step <= 8; step += 1) {
    await cdp.mouse.move(
      Math.round(olahraga.x + ((trigger.x - olahraga.x) * step) / 8),
      Math.round(olahraga.y + ((trigger.y - olahraga.y) * step) / 8),
    );
    await sleep(16);
  }
  await cdp.mouse.click(trigger.x, trigger.y);
  await cdp.settle(
    `[...document.querySelectorAll('[role="menuitem"] .menu-label')].some((l) => l.textContent === "New group…")`,
    (open) => open === true,
  );
  // Along the trigger's own row into the submenu, in steps, the way a hand
  // goes: Radix reads which way the pointer is heading from the moves, and one
  // jump reads as leaving for elsewhere. The submenu may open on either side,
  // since the menu is wherever the pointer was.
  const fresh = await menuItem("New group…");
  for (let step = 1; step <= 12; step += 1) {
    await cdp.mouse.move(Math.round(trigger.x + ((fresh.x - trigger.x) * step) / 12), trigger.y);
    await sleep(16);
  }
  for (let step = 1; step <= 6; step += 1) {
    await cdp.mouse.move(fresh.x, Math.round(trigger.y + ((fresh.y - trigger.y) * step) / 6));
    await sleep(16);
  }
  await cdp.mouse.click(fresh.x, fresh.y);
  await cdp.settle('document.querySelector("#name-dialog-field") !== null', (open) => open);
  for (const character of "Sports") await cdp.keyboard.press(character);
  await cdp.keyboard.press("Enter");
  const sports = await cdp.settle(
    `[...document.querySelectorAll(".tags-groups .sidebar-row")].map((r) => r.textContent).join(",")`,
    (text) => text.includes("Sports1"),
  );
  check("New group… makes the group and moves the tag into it", sports.includes("Sports1"), sports);

  section("A tag dragged onto a group goes into it");
  await cdp.dragAndDrop(await tagRow("traveling"), await groupRow("Materials"));
  const dragged = await cdp.settle(
    `[...document.querySelectorAll(".tags-groups .sidebar-row")].map((r) => r.textContent).join(",")`,
    (text) => text.includes("Materials2"),
  );
  check("Materials now holds two", dragged.includes("Materials2"), dragged);

  section("A rename onto a tag that exists says it merges, and does");
  const wood = await tagRow("wood");
  await cdp.mouse.click(wood.x, wood.y);
  await cdp.keyboard.press("F2");
  await cdp.settle('document.querySelector("#name-dialog-field") !== null', (open) => open);
  await cdp.keyboard.press("a", { ctrl: true });
  for (const character of "Traveling") await cdp.keyboard.press(character);
  const verb = await cdp.settle(
    `[...document.querySelectorAll(".dialog-actions button")].map((b) => b.textContent).join(",")`,
    (text) => text.includes("Merge"),
  );
  check("the button reads Merge", verb.includes("Merge"), verb);
  await cdp.keyboard.press("Enter");
  const merged = await settled((seen) => !seen.tags.some((tag) => tag.startsWith("wood=")));
  // traveling was on two assets and wood on a third: one tag on three now.
  check(
    "wood is gone into traveling, on three assets",
    merged.tags.includes("traveling=3"),
    merged.tags.join(", "),
  );

  section("Delete asks, deletes the tag, and leaves the grid's selection alone");
  const doomed = await tagRow("olahraga");
  await cdp.mouse.click(doomed.x, doomed.y);
  await cdp.keyboard.press("Delete");
  const asked = await cdp.settle(
    `document.querySelector('[role="alertdialog"]')?.textContent ?? null`,
    (text) => text !== null,
  );
  check("it asks, with the number of assets", asked.includes("2 assets"), asked);
  await cdp.mouse.click(...Object.values(await place('[role="alertdialog"] button', "Delete")));
  const left = await cdp.settle(
    `[...document.querySelectorAll(".tags-row .tags-name")].map((n) => n.textContent).join(",")`,
    (text) => !text.includes("olahraga"),
  );
  check("olahraga is gone", !left.includes("olahraga"), left);
  const trash = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll("nav.sidebar .sidebar-row")]
      .find((r) => r.querySelector(".sidebar-label")?.textContent === "Trash");
    return row?.querySelector(".sidebar-count")?.textContent ?? "none";
  })()`);
  check("and nothing went to the trash", trash === "0" || trash === "none", `Trash=${trash}`);

  section("A double-click leaves for the grid, showing what carries the tag");
  const traveling = await tagRow("traveling");
  await cdp.mouse.click(traveling.x, traveling.y);
  await cdp.mouse.click(traveling.x, traveling.y, { clickCount: 2 });
  const grid = await settled((s) => !s.page && s.cells === 3);
  check(
    "the grid shows the three that carry it",
    grid.query === "tag:traveling" && grid.cells === 3,
    `${grid.query} → ${grid.cells} cells`,
  );

  section("Every gesture is in the journal on disk");
  await sleep(300);
  const lines = await journal();
  const ops = (op) => lines.filter((line) => line.op === op);
  check(
    "tag_group_set for the drag and for the submenu",
    ops("tag_group_set").some((l) => l.tag === "traveling") &&
      ops("tag_group_set").some((l) => l.tag === "olahraga"),
    ops("tag_group_set")
      .map((l) => `${l.tag}→${l.group}`)
      .join(", "),
  );
  check(
    "tag_group_create for Sports",
    ops("tag_group_create").some((l) => l.name === "Sports"),
  );
  check(
    "tag_rename for the merge",
    ops("tag_rename").some((l) => l.from === "wood" && l.to === "Traveling"),
  );
  check("one tag_delete line", ops("tag_delete").length === 1, JSON.stringify(ops("tag_delete")));
} catch (error) {
  console.error(error);
  console.error(window.noise().slice(-4000));
  process.exitCode = 2;
} finally {
  await window.close();
  await dispose();
  report();
}
