/**
 * A note written across several assets, checked against a **running window**
 * (ADR-0048).
 *
 * The component tests show what the field sends and when it asks. They cannot
 * show the part that happens between processes. The question is raised on
 * blur, and it goes through the window's own dialog rather than the panel's. A
 * write across three assets has to come back as three notes in the library,
 * which the CLI reads straight from the index.
 *
 *   node scripts/check-notes.mjs
 *
 * **It builds its own library** in a temporary directory and deletes it again.
 */
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { ledger } from "./lib/checks.mjs";
import { imageLibrary, scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

const cli = (...args) =>
  execFileSync(process.execPath, ["packages/cli/dist/main.js", ...args], { encoding: "utf8" });

const { dir, dispose } = await scratch("check-notes");
const root = await imageLibrary(dir, { count: 3 });
const ids = cli("query", "-L", root, "--", "")
  .trim()
  .split("\n")
  .map((line) => line.split(/\s+/)[0]);
// Two different notes and one asset with none: the selection disagrees in both
// ways at once.
cli("note", "-L", root, ids[0], "one");
cli("note", "-L", root, ids[1], "two");

/** The note the index holds for an asset, read by the CLI rather than the window. */
const noteOf = (id) =>
  (
    cli("show", "-L", root, id)
      .split("\n")
      .find((line) => /^\s+note\s/.test(line)) ?? ""
  )
    .replace(/^\s+note\s+/, "")
    .trim();

const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

/** Types into the note, then clicks the source field, which is the blur. */
async function typeNoteAndLeave(text) {
  const note = await cdp.box(".note");
  await cdp.mouse.click(note.x, note.y);
  for (const key of text) await cdp.keyboard.press(key);
  // Past the one-second idle a single asset's note saves on, to show that a
  // mixed one does not.
  await sleep(1400);
  const asked = await cdp.evaluate("document.querySelector('.dialog') !== null");
  const source = await cdp.box(".source-field");
  await cdp.mouse.click(source.x, source.y);
  return asked;
}

const pressDialog = (label) =>
  cdp.evaluate(`
    [...document.querySelectorAll(".dialog button")]
      .find((button) => button.textContent === ${JSON.stringify(label)})
      ?.click()`);

try {
  await cdp.settle("document.querySelectorAll('.cell').length", (n) => n === 3);
  const cell = await cdp.box(".cell");
  await cdp.mouse.click(cell.x, cell.y);
  await cdp.keyboard.press("a", { ctrl: true });
  await cdp.settle(
    "document.querySelector('.inspector-count')?.textContent ?? null",
    (text) => text === "3 assets",
  );

  section("A selection whose notes disagree");
  const placeholder = await cdp.settle(
    "document.querySelector('.note')?.placeholder ?? null",
    (text) => typeof text === "string" && text.startsWith("Mixed"),
  );
  check(
    "says how they disagree, rather than drawing an empty note",
    placeholder === "Mixed — 2 different notes",
    placeholder,
  );

  section("Declining");
  const askedEarly = await typeNoteAndLeave("nope");
  check("nothing is asked while typing, however long the pause", askedEarly === false);
  const body = await cdp.settle(
    "document.querySelector('.dialog-body')?.textContent ?? null",
    (text) => text !== null,
  );
  check(
    "leaving the field asks, and says how many would lose a note",
    body === "Replace the note on 3 assets? 2 of them already have one.",
    body,
  );
  await pressDialog("Cancel");
  await cdp.settle("document.querySelector('.dialog') === null", Boolean);
  check(
    "Cancel empties the field again",
    (await cdp.evaluate("document.querySelector('.note').value")) === "",
  );
  check(
    "and writes nothing",
    noteOf(ids[0]) === "one" && noteOf(ids[1]) === "two" && noteOf(ids[2]) === "",
    `${noteOf(ids[0])} · ${noteOf(ids[1])} · ${noteOf(ids[2]) || "(none)"}`,
  );

  section("Replacing");
  await typeNoteAndLeave("semua");
  await cdp.settle("document.querySelector('.dialog-body') !== null", Boolean);
  await pressDialog("Replace");
  await cdp.settle(
    "document.querySelector('.note')?.placeholder ?? null",
    (text) => text === "Note",
  );
  const notes = ids.map(noteOf);
  check(
    "every asset holds the note, in the index",
    notes.every((note) => note === "semua"),
    notes.join(" · "),
  );
  check(
    "and the field shows it, now that they agree",
    (await cdp.evaluate("document.querySelector('.note').value")) === "semua",
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
