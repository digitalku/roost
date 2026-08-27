/**
 * Cold start and scroll frames, measured in a real window.
 *
 * `ROADMAP.md` M3 accepts on two numbers: a 100k-asset library open in under
 * 1.5 seconds, and a grid that scrolls at 60fps — **measured rather than
 * eyeballed**. This is the measuring.
 *
 *   node scripts/bench-window.mjs <LIBRARY.roost>
 *
 * Cold start is wall clock from spawning Electron to the first frame that has
 * grid rows in it, which the renderer stamps as `window.roostBench
 * .firstPaintAt`. Not "the window appeared" and not "the engine replied": a
 * window with nothing in it is not a started application.
 *
 * The scroll numbers come from the renderer's own benchmark, which **refuses to
 * report** when the window is not being composited. That refusal is the point.
 * Chromium throttles `requestAnimationFrame` for a hidden or occluded window,
 * and the numbers from one are not slow, they are meaningless — so this exits
 * non-zero rather than printing them, and on a headless machine that is the
 * correct outcome rather than a failure of the grid.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const library = process.argv[2];
if (library === undefined) {
  console.error("usage: node scripts/bench-window.mjs <LIBRARY.roost>");
  process.exit(2);
}

const PORT = 9400 + (process.pid % 100);
const electron = createRequire(import.meta.url)("electron");
if (typeof electron !== "string") {
  console.error("electron is not installed (ELECTRON_SKIP_BINARY_DOWNLOAD?)");
  process.exit(2);
}

// The clock starts before the process does. Everything after this is the
// application's, including Chromium's own start-up.
const spawnedAt = Date.now();
const child = spawn(
  electron,
  [
    "apps/desktop/main/dist/main.js",
    `--remote-debugging-port=${PORT}`,
    "--ozone-platform-hint=auto",
  ],
  { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ROOST_LIBRARY: library } },
);
let noise = "";
child.stderr.on("data", (chunk) => {
  noise += chunk;
});

let cdp;
try {
  cdp = await connect(PORT, noise);
  const openedAt = await open(cdp, library);
  const firstPaintAt = await waitForFirstPaint(cdp);

  console.log(`Library   ${library}`);
  console.log(`Assets    ${(await stats(cdp)).toLocaleString()}`);
  console.log("");
  console.log("Cold start");
  console.log(`  launch to first grid rows   ${firstPaintAt - spawnedAt} ms   (budget 1500)`);
  console.log(`  of which, opening the library ${firstPaintAt - openedAt} ms`);

  const result = await cdp.evaluate("window.roostBench.scroll({ durationMs: 5000 })");
  console.log("");
  if (result.refused !== undefined) {
    console.log(`Scroll    refused: ${result.refused}`);
    console.log("");
    console.log("That is the correct outcome on a machine that is not compositing this");
    console.log("window. Run it on a desktop session with the window visible.");
    process.exitCode = 1;
  } else {
    console.log("Scroll");
    console.log(
      `  frames                      ${result.frames.toLocaleString()} in ${Math.round(result.elapsedMs)} ms`,
    );
    console.log(`  scrolled                    ${result.scrolledPx.toLocaleString()} px`);
    console.log(
      `  rate                        ${result.fps} fps, steady at ~${result.steadyHz} Hz`,
    );
    console.log(`  median frame                ${result.medianMs} ms`);
    console.log(
      `  p95 / p99 / worst           ${result.p95Ms} / ${result.p99Ms} / ${result.worstMs} ms`,
    );
    console.log(`  hitches (1.5x the rhythm)   ${result.missed} (${result.missedPercent}%)`);
    console.log(`  over the 60fps budget       ${result.over60} (${result.over60Percent}%)`);
  }
} finally {
  child.kill("SIGTERM");
  await sleep(300);
  child.kill("SIGKILL");
}

/** A CDP session against the first page target, once one exists. */
async function connect(port, log) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page !== undefined) return await session(page.webSocketDebuggerUrl);
    } catch {
      // The port is not listening yet, which is the ordinary case for the
      // first second of a cold start.
    }
    await sleep(250);
  }
  throw new Error(`no page target after 15s\n${log}`);
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
        throw new Error(JSON.stringify(result.exceptionDetails));
      }
      return result.result.value;
    },
  };
}

/**
 * Opens the library from outside the React tree, then reloads.
 *
 * The window only shows a library it opened itself or found on mount, and there
 * is no scriptable way to click a GTK folder chooser — so it is opened through
 * the bridge and the page is reloaded to let its mount effect find it. The
 * reload is *after* the timer's baseline on purpose: what is being measured is
 * a page starting against a library that is already open, which is what a
 * second launch does.
 */
async function open(cdp, library) {
  const outcome = await cdp.evaluate(
    `window.roost.invoke({ type: "library:open", path: ${JSON.stringify(library)} })`,
  );
  if (outcome?.ok !== true)
    throw new Error(`could not open ${library}: ${JSON.stringify(outcome)}`);
  await cdp.evaluate("location.reload()").catch(() => {});
  return Date.now();
}

async function waitForFirstPaint(cdp) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const at = await cdp.evaluate("window.roostBench?.firstPaintAt ?? null").catch(() => null);
    if (typeof at === "number") return at;
    await sleep(100);
  }
  throw new Error("the grid never painted any rows");
}

async function stats(cdp) {
  const outcome = await cdp.evaluate(
    'window.roost.invoke({ type: "library:stats" }).then((o) => (o.ok ? o.value.assets : 0))',
  );
  return typeof outcome === "number" ? outcome : 0;
}
