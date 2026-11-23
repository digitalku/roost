/**
 * Markdown and plain text in the window (ADR-0070), asserted against a
 * **running window**.
 *
 *     node scripts/check-text.mjs [SCREENSHOT_DIR]
 *
 * The component tests drive the pane against a fake engine. What only a real
 * window shows is the rest: that the derive draws a sheet for a `.md` the grid
 * then loads, that the engine reads and writes the real file, that the editor
 * has the keyboard, and that a file saved from outside is refused rather than
 * overwritten.
 *
 * **It builds its own library** in a temporary directory and deletes it again.
 * Given a directory, it leaves two screenshots there: the rendered Markdown and
 * the editor.
 */
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { importInto, Library } from "@roost/library";
import { ledger } from "./lib/checks.mjs";
import { scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

const shots = process.argv[2];

const { dir, dispose } = await scratch("check-text");
const source = join(dir, "notes");
await mkdir(source, { recursive: true });
await writeFile(
  join(source, "plan.md"),
  "# Plan\n\nA **trip** to [the hills](https://example.com).\n\n- camera\n- jacket\n\n<b>raw</b>\n",
);
await writeFile(join(source, "list.txt"), "milk\nbread\n");
const root = join(dir, "Text.roost");
const made = await Library.create(root, "Text");
let planPath = "";
try {
  await importInto(made, [source]);
  const plan = made.db.repo.allIds().find((id) => made.db.repo.assetDetail(id)?.ext === "md");
  if (plan === undefined) throw new Error("plan.md did not import");
  planPath = made.storage.locate(plan, "md");
} finally {
  await made.close();
}

const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

/** Clicks the middle of the first element in rendered Markdown matching `selector`. */
async function clickText(selector) {
  const at = await window.cdp.evaluate(`(() => {
    const box = document.querySelector(".text-markdown ${selector}").getBoundingClientRect();
    return { x: box.left + 4, y: box.top + box.height / 2 };
  })()`);
  await window.cdp.mouse.click(at.x, at.y);
}

/** The file's text once `ok` holds of it, or as it is after five seconds. */
async function fileSays(path, ok) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const text = await readFile(path, "utf8");
    if (ok(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return readFile(path, "utf8");
}

const cellOf = (stem) => `[...document.querySelectorAll(".cell")]
  .find((cell) => cell.querySelector(".cell-name")?.textContent.startsWith(${JSON.stringify(stem)}))`;

try {
  section("the grid");
  const drawn = await cdp.settle(
    `(() => { const img = ${cellOf("plan")}?.querySelector(".cell-image");
      return img !== undefined && img !== null && img.complete && img.naturalWidth > 0; })()`,
    (yes) => yes === true,
    { attempts: 150 },
  );
  check("a Markdown file has a thumbnail drawn from its lines", drawn === true);

  section("reading");
  const cell = await cdp.evaluate(`(() => { const box = ${cellOf("plan")}.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
  await cdp.mouse.click(cell.x, cell.y, { clickCount: 1 });
  await cdp.mouse.click(cell.x, cell.y, { clickCount: 2 });
  const heading = await cdp.settle(
    `document.querySelector(".text-markdown h1")?.textContent ?? null`,
    (text) => text === "Plan",
  );
  check("the preview draws it rendered", heading === "Plan", String(heading));
  const escaped = await cdp.evaluate(
    `document.querySelector(".text-markdown b") === null && document.querySelector(".text-markdown").textContent.includes("<b>raw</b>")`,
  );
  check("raw HTML is shown as text, not made an element", escaped === true);
  if (shots !== undefined) await cdp.screenshot(join(shots, "text-read.png"));

  section("editing");
  // A click on the text opens the editor with the caret there (ADR-0070 §8.1).
  const words = await cdp.evaluate(`(() => {
    const strong = document.querySelector(".text-markdown strong");
    const box = strong.getBoundingClientRect();
    return { x: box.left + 2, y: box.top + box.height / 2 };
  })()`);
  await cdp.mouse.click(words.x, words.y);
  const focused = await cdp.settle(
    `document.activeElement?.classList.contains("cm-content") ?? false`,
    (yes) => yes === true,
  );
  check("a click on the text opens the editor, and it has the keyboard", focused === true);
  const caretLine = await cdp.evaluate(`(() => {
    const selection = window.getSelection();
    return selection?.anchorNode?.parentElement?.closest(".cm-line")?.textContent ?? null;
  })()`);
  check(
    "the caret is on the line that was clicked",
    String(caretLine).includes("trip"),
    String(caretLine),
  );

  // Typed as a person types, through the input the editor reads.
  const type = (text) =>
    cdp.evaluate(`document.execCommand("insertText", false, ${JSON.stringify(text)})`);
  const bigger = await cdp.evaluate(`(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    const h1 = lines.find((line) => line.classList.contains("cm-md-h1"));
    const body = lines.find((line) => line.textContent.includes("trip"));
    return h1 && body ? parseFloat(getComputedStyle(h1).fontSize) / parseFloat(getComputedStyle(body).fontSize) : null;
  })()`);
  check(
    "a heading is drawn larger while it is edited",
    bigger !== null && bigger > 1.3,
    String(bigger),
  );
  const bullets = await cdp.evaluate(`document.querySelectorAll(".cm-md-bullet").length`);
  check("a list's dashes are drawn as bullets", bullets === 2, String(bullets));

  // To the end of the list, then Enter: the list goes on.
  await cdp.evaluate(`(() => {
    const line = [...document.querySelectorAll(".cm-line")].find((node) => node.textContent.includes("jacket"));
    const range = document.createRange();
    range.selectNodeContents(line);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  })()`);
  await cdp.keyboard.press("Enter");
  await type("hat");
  await cdp.keyboard.press("ArrowLeft");
  const still = await cdp.evaluate(`document.querySelector(".cm-content") !== null`);
  check("an arrow in the editor moves the caret, not to the next asset", still === true);
  if (shots !== undefined) await cdp.screenshot(join(shots, "text-edit.png"));
  const noSave = await cdp.evaluate(
    `![...document.querySelectorAll(".preview-bar button")].some((b) => b.textContent.trim() === "Save")`,
  );
  check("there is no Save button (ADR-0070 §9)", noSave === true);
  // Escape is Done, and Done saves.
  await cdp.keyboard.press("Escape");
  const written = await fileSays(planPath, (text) => text.includes("hat"));
  check(
    "Enter continued the list, and Done wrote it over the file",
    written.includes("- jacket\n- hat\n"),
    JSON.stringify(written.slice(30, 80)),
  );
  const reading = await cdp.settle(
    `document.querySelector(".text-markdown li:last-child")?.textContent ?? null`,
    (item) => item === "hat",
  );
  check("and the pane is reading again, the new item in it", reading === "hat", String(reading));

  section("a save made elsewhere");
  await writeFile(planPath, "# Theirs\n");
  const later = new Date(Date.now() + 5_000);
  await utimes(planPath, later, later);
  await clickText("li:last-child");
  await cdp.settle(
    `document.activeElement?.classList.contains("cm-content") ?? false`,
    (yes) => yes === true,
  );
  await type("X");
  // Closing saves, and this save would undo another application's.
  await cdp.evaluate(
    `[...document.querySelectorAll(".preview-bar button")].find((b) => b.textContent.trim() === "Close").click()`,
  );
  const alert = await cdp.settle(
    `document.querySelector(".text-conflict") !== null`,
    (yes) => yes === true,
  );
  check("Close is refused, the pane stays, and says why", alert === true);
  check(
    "and the file keeps what the other application wrote",
    (await readFile(planPath, "utf8")) === "# Theirs\n",
  );
} catch (error) {
  console.error(error);
  console.error(window.noise().slice(-4000));
  process.exitCode = 2;
} finally {
  await window.close();
  await dispose();
  report();
}
