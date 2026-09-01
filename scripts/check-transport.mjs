/**
 * The video transport, asserted against a running window (ADR-0024).
 *
 * The component tests cover the requests, the state, and the keyboard. None of
 * them can see where a mark lands along a timeline, whether the transport
 * pushes the picture off the bottom of the pane, whether a colour token exists,
 * or whether any of it moves a real decoder — happy-dom lays nothing out and
 * decodes nothing. Two of the controls do not even exist there: `fullscreen`
 * and picture-in-picture are gated on a platform capability, so a window is the
 * only place their absence can be told from their being broken.
 *
 * Builds its own library, with real video from ffmpeg, and deletes it again.
 *
 *     node scripts/check-transport.mjs
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { addComment, importInto, Library, pageOf } from "@roost/library";

const PORT = 9600 + (process.pid % 100);
const electron = createRequire(import.meta.url)("electron");

const scratch = await mkdtemp(join(tmpdir(), "roost-check-transport-"));
const root = join(scratch, "Check.roost");
const short = join(scratch, "short.mp4");
const clip = join(scratch, "clip.mp4");

for (const [file, duration] of [
  [short, 5],
  [clip, 20],
]) {
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=320x240:rate=10:duration=${duration}`,
    // Not the default encoder for `.mp4` here, which is MPEG-4 Part 2 —
    // Chromium refuses it with error 4, and it reads exactly like a broken
    // protocol handler. This build has no libx264 either.
    "-c:v",
    "libopenh264",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
}

const library = await Library.create(root, "Check");
try {
  // The short one first, so the commented clip is newest and the grid opens on
  // it. Two assets, because "the timeline's arrows seek instead of stepping the
  // asset" cannot be seen in a library with one.
  await importInto(library, [short]);
  await sleep(1100);
  await importInto(library, [clip]);
  const hash = pageOf(library, "", { limit: 1 })[0].hash;
  await addComment(library, hash, 5000, "the cut lands early");
  await addComment(library, hash, 15_000, "hold two frames");
  await addComment(library, hash, null, "the export is 8-bit");
} finally {
  await library.close();
}

const child = spawn(
  electron,
  [
    "apps/desktop/main/dist/main.js",
    `--remote-debugging-port=${PORT}`,
    "--ozone-platform-hint=auto",
  ],
  { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ROOST_LIBRARY: root } },
);
let noise = "";
child.stderr.on("data", (chunk) => {
  noise += chunk;
});

const failures = [];
let passed = 0;
function check(name, pass, saw) {
  console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}${saw === undefined ? "" : `   ${saw}`}`);
  if (pass) passed += 1;
  else failures.push(name);
}

const transportExpression = `
  (() => {
    const bar = document.querySelector(".transport");
    const video = document.querySelector("video");
    const stage = document.querySelector(".preview-stage");
    const track = document.querySelector(".transport-timeline .transport-track");
    if (bar === null || video === null || track === null) return null;
    const box = (node) => {
      const r = node.getBoundingClientRect();
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    };
    const thumb = document.querySelector(".transport-thumb");
    const buffered = document.querySelector(".transport-buffered");
    return {
      controls: video.hasAttribute("controls"),
      marks: [...bar.querySelectorAll(".transport-mark")].map((mark) => ({
        left: mark.style.left,
        centre: Math.round(mark.getBoundingClientRect().left + mark.getBoundingClientRect().width / 2),
        label: mark.getAttribute("aria-label"),
        colour: getComputedStyle(mark).backgroundColor,
        width: Math.round(mark.getBoundingClientRect().width),
      })),
      bar: box(bar),
      track: box(track),
      video: box(video),
      stageBottom: Math.round(stage.getBoundingClientRect().bottom),
      valueText: thumb?.getAttribute("aria-valuetext") ?? null,
      valueNow: Number(thumb?.getAttribute("aria-valuenow") ?? Number.NaN),
      role: thumb?.getAttribute("role") ?? null,
      bufferedWidth: buffered === null ? 0 : Math.round(buffered.getBoundingClientRect().width),
      played: Math.round(document.querySelector(".transport-played")?.getBoundingClientRect().width ?? 0),
      controlNames: [...bar.querySelectorAll("button.transport-button")].map((button) => ({
        label: button.getAttribute("aria-label"),
        title: button.getAttribute("title"),
        tabbable: button.tabIndex >= 0,
      })),
      thumbTabbable: (thumb?.tabIndex ?? -1) >= 0,
      currentTime: video.currentTime,
      duration: video.duration,
      paused: video.paused,
      muted: video.muted,
      name: document.querySelector(".preview-name")?.textContent ?? null,
      time: document.querySelector(".transport-time")?.textContent ?? null,
    };
  })()`;

const press = async (label) =>
  cdp.evaluate(
    `[...document.querySelectorAll(".transport-button")]
      .find((button) => button.getAttribute("aria-label") === ${JSON.stringify(label)})
      .click()`,
  );

const key = (selector, name) => `
  document.querySelector(${JSON.stringify(selector)}).dispatchEvent(
    new KeyboardEvent("keydown", { key: ${JSON.stringify(name)}, bubbles: true }),
  )`;

let cdp;
try {
  cdp = await connect(PORT, () => noise);
  await cdp.evaluate(
    `window.roost.invoke({ type: "library:open", path: ${JSON.stringify(root)} })`,
  );
  await cdp.evaluate("location.reload()").catch(() => {});
  await settle(cdp, "window.roostBench?.firstPaintAt ?? null", (v) => typeof v === "number");
  await settle(cdp, "document.querySelectorAll('.cell').length", (n) => n === 2);

  await cdp.evaluate(`
    (() => {
      const cell = document.querySelector(".cell");
      cell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      cell.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
      cell.click();
    })()`);
  await cdp.evaluate(key(".grid", "Enter"));
  const drawn = await settle(
    cdp,
    transportExpression,
    (t) => t !== null && t.marks.length === 2 && Number.isFinite(t.duration),
  );

  console.log("What is drawn");
  check("the browser's own control bar is gone", drawn.controls === false);
  check(
    "the timeline is exactly as wide as the picture it belongs to",
    Math.abs(drawn.bar.left - drawn.video.left) <= 1 &&
      Math.abs(drawn.bar.right - drawn.video.right) <= 1,
    `bar=${drawn.bar.left}..${drawn.bar.right} video=${drawn.video.left}..${drawn.video.right}`,
  );
  check(
    "it sits under the picture rather than over it",
    drawn.bar.top >= drawn.video.bottom - 1,
    `barTop=${drawn.bar.top} videoBottom=${drawn.video.bottom}`,
  );
  check(
    "the player and the transport both fit the pane",
    drawn.bar.bottom <= drawn.stageBottom,
    `barBottom=${drawn.bar.bottom} stage=${drawn.stageBottom}`,
  );
  check(
    "one mark per timed comment, and none for the untimed one",
    drawn.marks.length === 2,
    drawn.marks.map((m) => m.left).join(", "),
  );
  check(
    "each mark lands on its own moment along the timeline",
    drawn.marks[0]?.left === "25%" && drawn.marks[1]?.left === "75%",
    `duration=${drawn.duration}s`,
  );
  check(
    "a mark is centred on its moment rather than starting at it",
    Math.abs(drawn.marks[0].centre - (drawn.track.left + drawn.track.width / 4)) <= 2,
    `centre=${drawn.marks[0].centre} quarter=${Math.round(drawn.track.left + drawn.track.width / 4)}`,
  );
  check(
    "a mark is painted, not a declaration nothing declares",
    drawn.marks[0].colour !== "rgba(0, 0, 0, 0)" && drawn.marks[0].width > 0,
    `${drawn.marks[0].colour} ${drawn.marks[0].width}px`,
  );
  check(
    "the mark names its moment and its words",
    drawn.marks[0].label === "Play from 0:05.0: the cut lands early",
    JSON.stringify(drawn.marks[0].label),
  );
  check(
    "the elapsed and the total are both shown",
    /0:00\.0 \/ 0:20\.0/.test(drawn.time ?? ""),
    JSON.stringify(drawn.time),
  );

  console.log("\nWhat a screen reader is told (UI_SPEC.md §10)");
  check("the timeline is a slider", drawn.role === "slider", JSON.stringify(drawn.role));
  check(
    "it announces a timecode rather than a count of milliseconds",
    drawn.valueText === "0:00.0 of 0:20.0",
    JSON.stringify(drawn.valueText),
  );
  check(
    "every icon control is named, and its tooltip says the same words",
    drawn.controlNames.length >= 3 &&
      drawn.controlNames.every((c) => c.label !== null && c.label === c.title),
    drawn.controlNames.map((c) => c.label).join(", "),
  );
  check(
    "every control can be reached without a pointer",
    drawn.thumbTabbable && drawn.controlNames.every((c) => c.tabbable),
  );
  check(
    "the platform's own controls are offered where the platform has them",
    drawn.controlNames.some((c) => c.label === "Fullscreen") &&
      drawn.controlNames.some((c) => c.label === "Picture in picture"),
    drawn.controlNames.map((c) => c.label).join(", "),
  );

  console.log("\nWhat it does to a real decoder");
  await cdp.evaluate('document.querySelectorAll(".transport-mark")[1].click()');
  const sought = await settle(
    cdp,
    'document.querySelector("video").currentTime',
    (t) => Math.abs(t - 15) < 0.5,
  );
  check("clicking a mark moves the decoder", Math.abs(sought - 15) < 0.5, `t=${sought}`);

  // Autoplay means the first press is the pause, which is the half of the pair
  // that proves the button is drawn from the element rather than from a guess.
  await press("Pause");
  const held = await settle(cdp, transportExpression, (t) => t !== null && t.paused === true);
  check(
    "the button stops it, and renames itself from the element's own event",
    held.controlNames.some((c) => c.label === "Play"),
    held.controlNames.map((c) => c.label).join(", "),
  );

  await press("Play");
  const playing = await settle(cdp, transportExpression, (t) => t !== null && t.paused === false);
  check(
    "and starts it again",
    playing.controlNames.some((c) => c.label === "Pause"),
    playing.controlNames.map((c) => c.label).join(", "),
  );

  const moved = await settle(
    cdp,
    'document.querySelector(".transport-played").getBoundingClientRect().width',
    (width) => width > 0,
  );
  check("the played range follows the playhead", moved > 0, `${Math.round(moved)}px`);
  const bufferedNow = await cdp.evaluate(
    'Math.round(document.querySelector(".transport-buffered").getBoundingClientRect().width)',
  );
  check("what has arrived is drawn behind it", bufferedNow > 0, `${bufferedNow}px`);

  console.log("\nThe keyboard");
  await cdp.evaluate(key(".preview", " "));
  const paused = await settle(cdp, 'document.querySelector("video").paused', (p) => p === true);
  check("Space pauses from the pane", paused === true);

  await cdp.evaluate('document.querySelector("video").currentTime = 2');
  await settle(cdp, transportExpression, (t) => t !== null && Math.abs(t.valueNow - 2000) < 200);
  await cdp.evaluate(key(".preview", "l"));
  // Settled on the *timeline*, not on the element: J and L move the playhead
  // from outside this component, and a transport that only follows the seeks it
  // made itself would sit at the old moment until something else redrew it.
  const nudged = await settle(
    cdp,
    transportExpression,
    (t) => t !== null && Math.abs(t.valueNow - 12_000) < 200,
  );
  check(
    "L seeks ten seconds on, and the timeline follows a seek it did not make",
    Math.abs(nudged.currentTime - 12) < 0.6,
    `t=${nudged.currentTime} timeline=${nudged.valueNow}ms`,
  );

  await cdp.evaluate(key(".preview", "m"));
  const mutedNow = await settle(cdp, transportExpression, (t) => t !== null && t.muted === true);
  check(
    "M mutes, and the button redraws from the element's own event",
    mutedNow.controlNames.some((c) => c.label === "Unmute"),
    mutedNow.controlNames.map((c) => c.label).join(", "),
  );

  // Held still first: a moving playhead makes "it moved by a step" unreadable,
  // and the claim here is about which control took the key rather than about
  // where the film is.
  const before = await settle(cdp, transportExpression, (t) => t !== null && t.paused === true);
  await cdp.evaluate('document.querySelector(".transport-thumb").focus()');
  await cdp.evaluate(key(".transport-thumb", "ArrowRight"));
  const stepped = await settle(
    cdp,
    transportExpression,
    (t) => t !== null && t.valueNow === before.valueNow + 100,
  );
  check(
    "the timeline's own arrows seek by a tenth of a second",
    stepped.currentTime > before.currentTime,
    `${before.valueNow}ms → ${stepped.valueNow}ms, t=${before.currentTime.toFixed(2)}→${stepped.currentTime.toFixed(2)}`,
  );
  check(
    "and the pane does not also step to the next asset",
    stepped.name === before.name,
    JSON.stringify(stepped.name),
  );

  console.log("\nThe panel beside it");
  await cdp.evaluate('[...document.querySelectorAll("button.comment-at")][0].click()');
  const fromList = await settle(
    cdp,
    'document.querySelector("video").currentTime',
    (t) => Math.abs(t - 5) < 0.5,
  );
  check("a comment in the inspector still seeks the player", true, `t=${fromList}`);

  console.log("");
  if (failures.length > 0) {
    console.log(`${failures.length} of ${failures.length + passed} checks failed`);
    process.exitCode = 1;
  } else {
    console.log(`all ${passed} checks passed`);
  }
} catch (error) {
  console.error(error);
  console.error(noise.slice(-4000));
  process.exitCode = 2;
} finally {
  child.kill("SIGTERM");
  await sleep(300);
  child.kill("SIGKILL");
  await rm(scratch, { recursive: true, force: true });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    proc.stderr.on("data", (chunk) => {
      error += chunk;
    });
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(error))));
  });
}

async function settle(cdp, expression, ok) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await cdp.evaluate(expression).catch(() => undefined);
    if (ok(value)) return value;
    await sleep(100);
  }
  throw new Error(`never settled: ${expression.trim().slice(0, 160)}`);
}

async function connect(port, log) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page !== undefined) return await session(page.webSocketDebuggerUrl);
    } catch {
      // The port is not listening yet, which is ordinary for the first second.
    }
    await sleep(250);
  }
  throw new Error(`no page target after 20s\n${log()}`);
}

async function session(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  let id = 0;
  const pending = new Map();
  socket.onmessage = (message) => {
    const reply = JSON.parse(message.data);
    const waiting = pending.get(reply.id);
    if (waiting === undefined) return;
    pending.delete(reply.id);
    if (reply.error) waiting.reject(new Error(JSON.stringify(reply.error)));
    else waiting.resolve(reply.result);
  };

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  return {
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails !== undefined) {
        throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
      }
      return result.result.value;
    },
  };
}
