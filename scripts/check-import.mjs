/**
 * An import's bar, and the × that stops it, asserted against a **running
 * window** (ADR-0055).
 *
 *   node scripts/check-import.mjs
 *
 * The directory is **dropped**, the way a person brings one in: CDP's
 * `Input.dispatchDragEvent` carries real paths in `files`, and the preload's
 * `pathForFile` hands them to the engine as it would from a file manager. That
 * is the door ADR-0037 §4 wrote could not be driven, and this is the first
 * check through it.
 *
 * The files are six of 512 MiB, 3 GiB in all, because the run has to last long
 * enough for × to be pressed in the middle of it: each file takes the counted
 * copy (ADR-0055 §3.2), and the directory is on `tmpfs`, where no reflink makes
 * the copy free. Built in a temporary directory, and deleted.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ledger } from "./lib/checks.mjs";
import { imageLibrary, scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

const FILES = 6;
const MIB = 1024 * 1024;

const { dir, dispose } = await scratch("check-import");
// Two assets already here, so the counts afterwards are about what arrived.
const root = await imageLibrary(dir, { count: 2, name: "Destination" });
const incoming = join(dir, "incoming");
await mkdir(incoming);
const block = randomBytes(64 * MIB);
for (let file = 0; file < FILES; file += 1) {
  // A different tail per block, so no two files are duplicates of each other.
  const blocks = Array.from({ length: 8 }, (_, part) =>
    Buffer.concat([block, Buffer.from(`${file}:${part}`)]),
  );
  await writeFile(join(incoming, `video-${file}.bin`), Buffer.concat(blocks));
}

const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

const request = (payload) => `window.roost.invoke(${JSON.stringify(payload)})`;
const statusLine = `
  [...document.querySelectorAll("footer.status .status-job")]
    .map((element) => element.textContent ?? "")
    .find((text) => /Counting|Importing|Stopping|stopped|imported|Thumbnails/.test(text)) ?? ""`;

/** Everything in `files/`, finished or not, whatever it is called. */
async function stored() {
  const files = join(root, "files");
  let count = 0;
  for (const shard of await readdir(files)) count += (await readdir(join(files, shard))).length;
  return count;
}

async function drop(path) {
  const grid = await cdp.box(".grid");
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await cdp.send("Input.dispatchDragEvent", {
      type,
      x: grid.x,
      y: grid.y,
      data: { items: [], files: [path], dragOperationsMask: 1 },
    });
  }
}

/** Every distinct status line until `done` says so, polled every 50 ms. */
async function watch(done, { attempts = 1200 } = {}) {
  const lines = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const line = await cdp.evaluate(statusLine);
    if (line !== "" && lines.at(-1) !== line) lines.push(line);
    if (await done(line)) return lines;
    await sleep(50);
  }
  throw new Error(`never finished: ${lines.at(-1) ?? "(nothing)"}`);
}

try {
  section("A directory dropped on the grid");
  await drop(incoming);
  let bar = null;
  let stop = null;
  const running = await watch(async (line) => {
    const percent = Number(/Importing… (\d+)%/.exec(line)?.[1] ?? -1);
    if (percent < 10) return false;
    bar = await cdp.evaluate(
      `document.querySelector('[role="progressbar"][aria-label="Importing"]')?.getAttribute("aria-valuenow") ?? null`,
    );
    stop = await cdp.box('button[aria-label="Stop importing"]').catch(() => null);
    return true;
  });
  const line = running.at(-1) ?? "";
  check(
    "the line counts bytes against a total known from the start",
    /Importing… \d+% · [\d.]+ (MiB|GiB) of 3\.0 GiB · \d of 6/.test(line),
    line,
  );
  check("a bar is drawn, and agrees with the line", bar !== null && line.includes(`${bar}%`), bar);
  check("× is there while files are coming in", stop !== null);
  // Seen or not depending on the machine: six files count in a millisecond.
  const counting = running.find((seen) => seen.startsWith("Counting…"));
  if (counting !== undefined) {
    check("counting says what it found", counting === "Counting… 6 files · 3.0 GiB", counting);
  }

  section("× stops it");
  await cdp.mouse.click(stop.x, stop.y);
  const stopping = await watch(async (seen) => seen.startsWith("Import stopped"));
  const ended = stopping.at(-1) ?? "";
  check("the run says it was stopped", ended.startsWith("Import stopped · "), ended);
  const imported = Number(/(\d+) imported/.exec(ended)?.[1] ?? -1);
  check("and fewer than six arrived", imported >= 0 && imported < FILES, `imported=${imported}`);
  const stats = await cdp.evaluate(request({ type: "library:stats" }));
  check(
    "what arrived is in the library",
    stats?.value?.assets === 2 + imported,
    `assets=${stats?.value?.assets}`,
  );
  const onDisk = await stored();
  check(
    "and nothing else is in files/ — no half copy, under any name",
    onDisk === 2 + imported,
    `files=${onDisk}`,
  );
  check(
    "every source is where it was",
    (await readdir(incoming)).length === FILES,
    `sources=${(await readdir(incoming)).length}`,
  );

  section("Dropping it again brings the rest");
  await drop(incoming);
  const again = await watch(async (seen) => /^\d[\d,]* imported/.test(seen), { attempts: 2400 });
  const finished = again.at(-1) ?? "";
  check(
    "the rest are imported, and what arrived is already here",
    finished.startsWith(`${FILES - imported} imported`) &&
      (imported === 0 || finished.includes(`${imported} already here`)),
    finished,
  );
  const after = await cdp.evaluate(request({ type: "library:stats" }));
  check(
    "all six are in the library once",
    after?.value?.assets === 2 + FILES,
    `assets=${after?.value?.assets}`,
  );
} finally {
  await window.close();
  await dispose();
}

report();
