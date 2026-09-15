/**
 * What another build wrote, asserted against a **running window**
 * (`UI_SPEC.md` §3.14, ADR-0045 §7).
 *
 *     node scripts/check-journal-notice.mjs
 *
 * The component test drives this line against a notice handed to it, so it can
 * say what the window draws for a given answer and nothing about where the
 * answer comes from. **That is the half worth checking here**, because the
 * answer travels the whole way: a journal line another implementation wrote,
 * through the fold an open performs when it finds the index behind the journal,
 * into `meta`, out through `library:open`, and into a status bar.
 *
 * It also checks the fold itself, which is the part with no numbered
 * requirement behind it and the part a person would notice first: the library
 * is written, closed, **appended to behind this build's back**, and reopened.
 * Everything the appended month says has to be on screen.
 *
 * **It builds its own library** in a temporary directory and deletes it again.
 * The extra month file is written by hand, deliberately — a library written by a
 * working implementation contains only what that implementation can write, which
 * is exactly the wrong property for a check about operations it cannot.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ledger } from "./lib/checks.mjs";
import { imageLibrary, scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

/** The middle of an element, in viewport coordinates, for `cdp.mouse`. */
const centreOf = (cdp, selector) =>
  cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return null;
    const box = el.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);

/** The first asset's hash, read out of the journal this build just wrote. */
async function firstHash(root) {
  const dir = join(root, "journal");
  const months = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
  const text = await readFile(join(dir, months[0]), "utf8");
  for (const line of text.split("\n")) {
    const record = line.trim() === "" ? {} : JSON.parse(line);
    if (record.op === "add") return record.hash;
  }
  throw new Error("no add record in the fixture's journal");
}

const { dir, dispose } = await scratch("check-journal-notice");
const root = await imageLibrary(dir, { count: 4, size: 64, name: "Shared" });
const hash = await firstHash(root);

// A month this build never wrote, in a month it never reached. Three of the four
// lines are operations it cannot apply; the fourth is one it can, and is what
// proves the fold happened at all rather than the notice being drawn over a
// stale index.
await writeFile(
  join(root, "journal", "2026-03.jsonl"),
  [
    `{"ts":1772000000,"op":"rate","hash":"${hash}","rating":5}`,
    `{"ts":1772000001,"op":"win.shell_pin","hash":"${hash}"}`,
    `{"ts":1772000002,"op":"win.shell_pin","hash":"${hash}"}`,
    `{"ts":1772000003,"op":"folder_add","hash":"${hash}","folder":99}`,
    "",
  ].join("\n"),
  "utf8",
);

const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

try {
  section("the fold an open performs");
  const rated = await cdp.settle(
    `document.querySelectorAll(".cell").length`,
    (count) => typeof count === "number" && count > 0,
  );
  check("the grid draws the library", rated === 4, `${rated} cells`);

  section("the line in the status bar");
  const line = await cdp.settle(
    `[...document.querySelectorAll(".status-job")].map((node) => node.textContent.trim()).join(" | ")`,
    (text) => typeof text === "string" && text.includes("Roost for Windows"),
  );
  // Two records of one operation, and the prefix is the whole of what lets the
  // line name the build rather than print a count (RL-28, RL-29).
  check(
    "names the build, not just a number",
    line.includes("2 only Roost for Windows shows"),
    line,
  );
  check(
    "and says nothing about the dangling folder_add",
    !line.toLowerCase().includes("folder"),
    line,
  );

  section("the list it opens");
  const at = await centreOf(cdp, ".status-job");
  await cdp.mouse.click(at.x, at.y);
  const body = await cdp.settle(
    `document.querySelector(".dialog")?.textContent ?? ""`,
    (text) => typeof text === "string" && text.includes("win.shell_pin"),
  );
  check(
    "leads with the reassurance, not the list",
    body.includes("still in the library's journal"),
  );
  check("names the operation", body.includes("win.shell_pin"), "win.shell_pin");
  check("and whose it is", body.includes("Roost for Windows"));
} catch (error) {
  console.error(error);
  console.error(window.noise().slice(-4000));
  process.exitCode = 2;
} finally {
  await window.close();
  await dispose();
  report();
}
