/**
 * Installing a missing backend from the window, asserted against a **running
 * window** (ADR-0042, `UI_SPEC.md` §3.13).
 *
 *     node scripts/check-install.mjs
 *
 * **It builds its own library** in a temporary directory and deletes it again:
 * one video, imported and derived with ffmpeg hidden, so the queue parks it on
 * `missing:ffmpeg` and the dialog has the group this feature is about. Making
 * the clip needs a real ffmpeg and the derive must not see one, which works
 * because the two ask differently: the fixture runs `ffmpeg` by name, and the
 * engine reads `ROOST_FFMPEG`.
 *
 * **It installs nothing.** The button is clicked only where ffmpeg is *already*
 * installed, which is the path where the package manager answers "already
 * installed" and refuses — and that is the assertion worth having anyway: it
 * proves `capability:install` crossed main's allowlist, reached the engine,
 * started a real process, and brought its words back. On a machine without
 * ffmpeg the click is skipped and the check says so, because a check script
 * that installs software on the machine running it is not a check.
 *
 * Two things here cannot be checked anywhere else. The **request allowlist is
 * main's**, so only a real window proves this request is one the preload will
 * carry. And the **command is the engine's**, chosen from the platform it is
 * actually running on, which is the whole of what was broken on Windows: the
 * dialog printed the words `install ffmpeg`.
 */
import { join } from "node:path";
import { ledger } from "./lib/checks.mjs";
import { launch } from "./lib/window.mjs";

/** A path nothing is at, which is how a backend is hidden from a probe. */
const NOWHERE = join("no", "such", "tool");

const onWindows = process.platform === "win32";

/** Whether this machine has ffmpeg — asked of the PATH, before it is hidden. */
const hasFfmpeg = await onPath("ffmpeg");

/**
 * The override goes on **before anything that reaches `@roost/media` is
 * loaded**, which is why three imports here are dynamic and every other script
 * in this directory has none.
 *
 * `ffmpeg.ts` reads `ROOST_FFMPEG` once, into a module constant. That is right
 * for a process whose environment is fixed at launch and fatal to a script that
 * tries to hide the tool afterwards — and ES modules evaluate every static
 * import before the first line of the body, so assigning it in the body is too
 * late. `fixtures.mjs` counts: it imports `@roost/media` for `gradient`. Two
 * attempts were spent on this on 2026-09-11, both watching the probe answer
 * `available: true` for a path that does not exist.
 *
 * The fixture itself is unaffected and deliberately so: it calls `ffmpeg` by
 * its bare name, so the clip is still encoded by the real one.
 */
process.env.ROOST_FFMPEG = NOWHERE;
process.env.ROOST_FFPROBE = NOWHERE;
const { scratch, videoClip } = await import("./lib/fixtures.mjs");
const { importInto, Library, runDerives } = await import("@roost/library");
const { GRID_SIZE } = await import("@roost/media");

const { dir, dispose } = await scratch("check-install");
const root = await parkedLibrary(dir);

const window = await launch({
  library: root,
  env: { ROOST_FFMPEG: NOWHERE, ROOST_FFPROBE: NOWHERE },
});
const { cdp } = window;
const { check, section, report } = ledger();

/** What the parked group is offering, in one round trip. */
const groupExpression = `
  (() => {
    const dialog = document.querySelector(".dialog");
    if (dialog === null) return null;
    return {
      title: dialog.querySelector(".dialog-title")?.textContent ?? null,
      lines: [...dialog.querySelectorAll(".failure-line")].map((n) => n.textContent),
      command: dialog.querySelector(".failure-install")?.textContent ?? null,
      buttons: [...dialog.querySelectorAll(".failure-install-actions button")]
        .map((n) => n.textContent),
      output: dialog.querySelector(".failure-install-output")?.textContent ?? null,
    };
  })()`;

const statusExpression = `document.querySelector("button.status-job")?.textContent ?? null`;

const clickInGroup = (label) => `
  [...document.querySelectorAll(".failure-install-actions button")]
    .find((button) => button.textContent === ${JSON.stringify(label)})?.click()`;

try {
  section("The parked group, with ffmpeg hidden");

  const opened = await openList();
  check(
    "the list names the backend rather than the file",
    opened.lines.includes("Videos and audio need ffmpeg"),
    opened.lines.join(" · "),
  );

  // The defect this whole change came from: on Windows the table had no branch,
  // so the fallback sentence was printed as though it were a command.
  const expected = onWindows ? "winget install --id Gyan.FFmpeg" : null;
  check(
    onWindows ? "the command is winget's, not the fallback sentence" : "a command is printed",
    onWindows ? opened.command === expected : typeof opened.command === "string",
    opened.command,
  );
  check("the fallback string never reaches the window", opened.command !== "install ffmpeg");

  section("What is offered beside it");

  check(
    "Copy command is offered everywhere",
    opened.buttons.includes("Copy command"),
    opened.buttons.join(" · "),
  );
  check(
    onWindows
      ? "Install it is offered, because winget needs no password"
      : "Install it is withheld, because the line begins with sudo",
    opened.buttons.includes("Install it") === onWindows,
    opened.buttons.join(" · "),
  );
  check("Try again is still there", opened.buttons.includes("Try again"));

  await cdp.evaluate(clickInGroup("Copy command"));
  const copied = await cdp.settle(
    groupExpression,
    (state) => state !== null && state.buttons.includes("Copied"),
  );
  // The renderer has no clipboard of its own (invariant 11), so the label
  // changing at all is the round trip through main having answered true.
  check("Copy command goes through main and comes back", copied.buttons.includes("Copied"));

  section("Running it, on the one path that installs nothing");

  if (!onWindows) {
    console.log("  skip  nothing to run here — and that is the decision, not a gap");
  } else if (!hasFfmpeg) {
    console.log("  skip  ffmpeg is not installed, and this check will not install it");
  } else {
    await cdp.evaluate(clickInGroup("Install it"));
    // winget goes to the network before it decides it has nothing to do, so
    // this is seconds rather than milliseconds.
    const ran = await cdp.settle(
      groupExpression,
      (state) => state !== null && state.output !== null,
      { attempts: 120, everyMs: 500 },
    );
    check(
      "the request crossed main, spawned winget, and brought its words back",
      typeof ran.output === "string" && ran.output.length > 0,
      (ran.output ?? "").split("\n")[0],
    );
    check(
      "the button is offering again rather than stuck on Installing…",
      ran.buttons.includes("Install it"),
      ran.buttons.join(" · "),
    );
  }

  report();
} finally {
  await window.close();
  await dispose();
}

/**
 * A library holding one video the queue could not draw.
 *
 * The clip is real and the derive still parks, because the two ask for ffmpeg
 * differently — the fixture by name, the engine through `ROOST_FFMPEG`. So the
 * reason is `missing:ffmpeg`, which is the group this check is about, rather
 * than a failure, which is a different half of the dialog.
 */
async function parkedLibrary(scratchDir) {
  const source = join(scratchDir, "source");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(source, { recursive: true });
  await videoClip(join(source, "clip.mp4"), { seconds: 1, size: "64x64" });

  const library = await Library.create(join(scratchDir, "Parked.roost"), "Parked");
  try {
    await importInto(library, [source]);
    await runDerives(library, { sizes: [GRID_SIZE] });
    return library.root;
  } finally {
    await library.close();
  }
}

/**
 * Opens the list from the status bar, the way a person does.
 *
 * Lifted from `check-failures.mjs`, and for its reason: the status bar is one
 * element that changes what it is — a `span` while a run is in flight and a
 * `button` when it has stopped — so a click aimed a moment early lands on the
 * span and does nothing at all.
 */
async function openList() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await cdp.settle(statusExpression, (text) => text !== null);
    const box = await cdp.evaluate(`
      (() => {
        const node = document.querySelector("button.status-job");
        if (node === null) return null;
        const rect = node.getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      })()`);
    if (box === null) continue;
    await cdp.mouse.click(box.x, box.y);
    try {
      return await cdp.settle(
        groupExpression,
        (state) => state !== null && state.lines.length > 0,
        {
          attempts: 20,
        },
      );
    } catch {
      // The click landed on the queue rather than on the button. Ask again.
    }
  }
  throw new Error("the parked list never opened");
}

/**
 * Whether a program is on the `PATH`, asked the way ADR-0017 asks: by running
 * it. `which` answers about the `PATH` rather than about a binary that runs.
 */
async function onPath(program) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const proc = spawn(program, ["-version"], { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("exit", (code) => resolve(code === 0));
  });
}
