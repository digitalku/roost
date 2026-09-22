/**
 * The plumbing shared by every check that drives a **real window**.
 *
 * Four scripts each carried a copy of this — spawn Electron, find the page
 * target, open a WebSocket, evaluate an expression, poll until it settles, kill
 * the child on the way out. The fourth copy is where that stopped being
 * acceptable (`TODO.md` §M3), and a fifth was owed to the grid.
 *
 * Two things here are more than a move, and both were paid for by a defect:
 *
 * - **The port is found, not derived.** `9500 + pid % 100` collided between
 *   `check-sandbox` and `check-trash` for any two processes a hundred apart,
 *   which is not rare and is invisible when it happens: the second script
 *   attaches to the first script's window and asserts against the wrong one.
 * - **Input goes through CDP, not through `dispatchEvent`.** A synthetic
 *   `PointerEvent` is not a pointer as far as the browser is concerned, so
 *   `:hover` never matches and `setPointerCapture` throws — the exact reason
 *   the marquee's driver died on its first frame, and the exact reason "hover
 *   erases a selected row's fill" could not be caught from a page expression.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Chromium's modifier bitmask, for `Input.dispatch*Event`. */
const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/**
 * Keys a check reaches for that are not a character.
 *
 * Chromium routes a key event by `windowsVirtualKeyCode`, so a `key` alone
 * arrives as a keypress nothing recognises — which reads as the shortcut being
 * unbound rather than as the event being malformed.
 */
const KEYS = {
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  End: { code: "End", keyCode: 35 },
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  F4: { code: "F4", keyCode: 115 },
  F9: { code: "F9", keyCode: 120 },
  Home: { code: "Home", keyCode: 36 },
  PageDown: { code: "PageDown", keyCode: 34 },
  PageUp: { code: "PageUp", keyCode: 33 },
  Tab: { code: "Tab", keyCode: 9, text: "\t" },
  " ": { code: "Space", keyCode: 32, text: " " },
};

/**
 * A one-character key, spelled the way Chromium's key router wants it.
 *
 * A digit is `Digit1`, not `Key1`: `Ctrl+1` selects a view (ADR-0018) and a
 * physical code the browser does not recognise arrives as a keypress nothing is
 * bound to, which reads as the shortcut being missing.
 */
function single(key) {
  if (key.length !== 1) return undefined;
  const upper = key.toUpperCase();
  const code = upper >= "0" && upper <= "9" ? `Digit${upper}` : `Key${upper}`;
  return { code, keyCode: upper.charCodeAt(0), text: key };
}

/** Where a driven window keeps its profile — never the application's own. */
const PROFILE = join(tmpdir(), "roost-window-checks");

/** Electron's binary, or a clear exit rather than a confusing spawn failure. */
export function electronBinary() {
  const binary = createRequire(import.meta.url)("electron");
  if (typeof binary !== "string") {
    console.error("electron is not installed (ELECTRON_SKIP_BINARY_DOWNLOAD?)");
    process.exit(2);
  }
  return binary;
}

/** A port the kernel says is free right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Starts the desktop application and attaches to its window.
 *
 * `library` is opened by {@link openLibrary} over the debugger once the window
 * is up, because the folder chooser is a native dialog no script can click
 * (`TODO.md` §M3) and the application takes no library on its command line or
 * in its environment — `ROOST_LIBRARY` is the CLI's alone (`SETUP.md` §3).
 * Pass `open: false` for a check whose subject is the window before any library
 * is in it.
 */
export async function launch({ library, args = [], env = {}, open = library !== undefined } = {}) {
  const binary = electronBinary();
  const port = await freePort();
  // Before the process, so a caller measuring cold start counts Chromium's own
  // start-up as the application's — because it is.
  const spawnedAt = Date.now();
  const child = spawn(
    binary,
    [
      "apps/desktop/main/dist/main.js",
      `--remote-debugging-port=${port}`,
      // A profile of the checks' own, because `requestSingleInstanceLock` is
      // scoped to it: on the default profile a Roost already open on the
      // developer's desktop takes the lock, `main.ts` quits before it makes a
      // window, and the attach below waits out its twenty seconds against a
      // debugger port with nothing behind it. Diagnosed on 2026-09-05, after
      // the same script passed and failed on nothing but whether the
      // application happened to be running. Fixed rather than per-run, so a
      // cold-start measurement still starts from a warm code cache.
      `--user-data-dir=${PROFILE}`,
      // Without it the window is blurry on a HiDPI Wayland session and
      // fractional scaling is wrong, which reads as a rendering bug and is not
      // one (`TODO.md` §2).
      "--ozone-platform-hint=auto",
      ...args,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    },
  );

  let noise = "";
  child.stderr.on("data", (chunk) => {
    noise += chunk;
  });

  const window = {
    child,
    spawnedAt,
    noise: () => noise,
    async close() {
      child.kill("SIGTERM");
      await sleep(300);
      child.kill("SIGKILL");
    },
  };

  try {
    window.cdp = await connect(port, () => noise);
  } catch (error) {
    await window.close();
    throw error;
  }

  if (open) {
    await openLibrary(window.cdp, library);
    await firstPaint(window.cdp);
  }
  return window;
}

/**
 * Opens a library and reloads onto it.
 *
 * The reload is what makes the window's whole start-up path the one under test
 * rather than a library swapped in underneath a rendered grid.
 */
export async function openLibrary(cdp, path) {
  const outcome = await cdp.evaluate(
    `window.roost.invoke({ type: "library:open", path: ${JSON.stringify(path)} })`,
  );
  // A refusal here is otherwise invisible: the page reloads onto no library and
  // every check after it waits out its timeout against an empty grid.
  if (outcome?.ok !== true) throw new Error(`could not open ${path}: ${JSON.stringify(outcome)}`);
  await cdp.evaluate("location.reload()").catch(() => {});
  return Date.now();
}

/**
 * Waits for the frame that has grid rows in it.
 *
 * Not "the window appeared" and not "the engine replied": a window with nothing
 * in it is not a started application, which is the same line `bench-window.mjs`
 * measures cold start to.
 */
export function firstPaint(cdp) {
  return cdp.settle("window.roostBench?.firstPaintAt ?? null", (v) => typeof v === "number");
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
  const listeners = new Map();
  socket.onmessage = (message) => {
    const reply = JSON.parse(message.data);
    if (reply.method !== undefined) {
      for (const handler of listeners.get(reply.method) ?? []) handler(reply.params);
      return;
    }
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
  await send("Page.enable");
  await send("Network.enable");

  const cdp = {
    send,

    /** Subscribes to a CDP event; returns the unsubscribe. */
    on(method, handler) {
      const handlers = listeners.get(method) ?? [];
      handlers.push(handler);
      listeners.set(method, handlers);
      return () =>
        listeners.set(
          method,
          (listeners.get(method) ?? []).filter((h) => h !== handler),
        );
    },

    /** The next event of a kind, or `undefined` if `timeoutMs` passes first. */
    once(method, matches = () => true, timeoutMs = 8000) {
      return new Promise((resolve) => {
        const off = cdp.on(method, (params) => {
          if (!matches(params)) return;
          off();
          resolve(params);
        });
        sleep(timeoutMs).then(() => {
          off();
          resolve(undefined);
        });
      });
    },

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

    /**
     * Polls an expression until it satisfies `ok`, so nothing races a render.
     *
     * Throws rather than returning a wrong answer: a check that quietly reads
     * a half-rendered grid asserts about nothing and passes.
     */
    async settle(expression, ok, { attempts = 100, everyMs = 100 } = {}) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const value = await cdp.evaluate(expression).catch(() => undefined);
        if (ok(value)) return value;
        await sleep(everyMs);
      }
      throw new Error(`never settled: ${expression.trim().slice(0, 160)}`);
    },

    /**
     * How many frames the window drew in `overMs` — 0 when nothing is drawing it.
     *
     * Chromium throttles a hidden, occluded or unmapped window to a crawl, and
     * with it every part of the rendering lifecycle: `requestAnimationFrame`,
     * `ResizeObserver`, and `requestVideoFrameCallback` all simply stop. A grid
     * that reflows on a `ResizeObserver` then keeps the width it measured at
     * mount, and a marquee scheduled on an animation frame is never drawn — so a
     * check that reads either reports a defect that is not there.
     *
     * Counted through a global rather than a promise the page resolves on a
     * timer: `setTimeout` is throttled too, and a check that waits on one in a
     * background window waits a very long time.
     */
    async frameRate(overMs = 400) {
      await cdp.evaluate(
        "window.__roostFrames = 0;" +
          "(function tick() { window.__roostFrames += 1; requestAnimationFrame(tick); })();",
      );
      await sleep(overMs);
      return cdp.evaluate("window.__roostFrames");
    },

    /** An element's box in viewport coordinates, or `null` if it is not there. */
    box(selector) {
      return cdp.evaluate(`
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el === null) return null;
          const r = el.getBoundingClientRect();
          return {
            left: Math.round(r.left), top: Math.round(r.top),
            right: Math.round(r.right), bottom: Math.round(r.bottom),
            width: Math.round(r.width), height: Math.round(r.height),
            x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
          };
        })()`);
    },

    /** The whole window as a PNG; writes it too when given a path. */
    async screenshot(path) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      const bytes = Buffer.from(data, "base64");
      if (path !== undefined) await writeFile(path, bytes);
      return bytes;
    },

    mouse: {
      /**
       * A real pointer move. `:hover` matches on this and on nothing a page
       * expression can dispatch.
       */
      async move(x, y, { buttons = 0, modifiers = 0, button } = {}) {
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
          buttons,
          modifiers,
          // Named only when a caller says so. A native drag does not start
          // without it — Chromium reads `buttons` for the state and `button`
          // for what is doing the moving, and a move with no `button` is not a
          // gesture it will hand to the drag controller. Diagnosed on
          // 2026-09-07, against a `dragstart` that fired and went nowhere.
          ...(button === undefined ? {} : { button }),
        });
      },
      async down(x, y, { button = "left", modifiers = 0, clickCount = 1 } = {}) {
        await send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button,
          buttons: button === "right" ? 2 : 1,
          clickCount,
          modifiers,
        });
      },
      async up(x, y, { button = "left", modifiers = 0, clickCount = 1 } = {}) {
        await send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button,
          buttons: 0,
          clickCount,
          modifiers,
        });
      },
      async click(x, y, options = {}) {
        await cdp.mouse.move(x, y, options);
        await cdp.mouse.down(x, y, options);
        await cdp.mouse.up(x, y, options);
      },
      /**
       * A wheel notch at a point, in pixels of `deltaY`.
       *
       * Negative is away from the hand, which is the direction a page scrolls
       * up and a picture zooms in. A page expression can dispatch a `WheelEvent`
       * but not a *cancelable* one Chromium honours, and the handler under test
       * is the one that calls `preventDefault` — so this has to come through
       * the input pipeline like a real notch.
       */
      async wheel(x, y, deltaY, { deltaX = 0, modifiers = 0 } = {}) {
        await cdp.mouse.move(x, y);
        await send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX,
          deltaY,
          modifiers,
          pointerType: "mouse",
        });
      },
      /**
       * A press, a run of moves, and a release.
       *
       * The moves are steps rather than one jump because a gesture that reads
       * the pointer on an animation frame — the marquee's autoscroll does —
       * sees one position for a jump and cannot be told from a stuck one.
       */
      async drag(from, to, { steps = 12, modifiers = 0, restMs = 16, button = "left" } = {}) {
        await cdp.mouse.move(from.x, from.y, { modifiers });
        await cdp.mouse.down(from.x, from.y, { modifiers, button });
        for (let step = 1; step <= steps; step += 1) {
          await cdp.mouse.move(
            Math.round(from.x + ((to.x - from.x) * step) / steps),
            Math.round(from.y + ((to.y - from.y) * step) / steps),
            { buttons: button === "right" ? 2 : 1, modifiers },
          );
          await sleep(restMs);
        }
        await cdp.mouse.up(to.x, to.y, { modifiers, button });
      },
    },

    /**
     * A real HTML5 drag, from one point to another.
     *
     * Chromium hands a native drag to the platform the moment one starts, and
     * from there `Input.dispatchMouseEvent` reaches nothing — the page sees a
     * `dragstart` and then silence, which reads exactly like a drop target that
     * refuses the drag. `Input.setInterceptDrags` keeps the drag inside the
     * browser and hands the payload back through `Input.dragIntercepted`, which
     * is then replayed as `dragEnter`, `dragOver` and `drop` at the
     * destination.
     *
     * Verified on 2026-09-07: without the interception the check hung on a
     * `dragstart` that never became a drop.
     */
    async dragAndDrop(from, to, { steps = 8, modifiers = 0, restMs = 24 } = {}) {
      await send("Input.setInterceptDrags", { enabled: true });
      const intercepted = cdp.once("Input.dragIntercepted");
      await cdp.mouse.move(from.x, from.y);
      await cdp.mouse.down(from.x, from.y);
      // A drag begins on the *second* position: one press and no movement is a
      // click, and Chromium starts the drag only once the pointer has passed
      // its threshold.
      for (let step = 1; step <= steps; step += 1) {
        await cdp.mouse.move(
          Math.round(from.x + ((to.x - from.x) * step) / steps),
          Math.round(from.y + ((to.y - from.y) * step) / steps),
          { buttons: 1, button: "left" },
        );
        // Chromium starts a drag from the *movement*, and a run of positions
        // delivered in one task is one movement as far as its threshold is
        // concerned.
        await sleep(restMs);
      }
      const payload = await intercepted;
      if (payload === undefined) {
        await send("Input.setInterceptDrags", { enabled: false });
        throw new Error("no drag was intercepted; nothing started a drag");
      }
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await send("Input.dispatchDragEvent", {
          type,
          x: to.x,
          y: to.y,
          data: payload.data,
          modifiers,
        });
      }
      await cdp.mouse.up(to.x, to.y);
      await send("Input.setInterceptDrags", { enabled: false });
    },

    keyboard: {
      /** `press("k")`, `press("Delete")`, `press("a", { ctrl: true })`. */
      async press(key, modifierNames = {}) {
        const modifiers = Object.entries(modifierNames)
          .filter(([, on]) => on)
          .reduce((mask, [name]) => mask | (MODIFIERS[name] ?? 0), 0);
        const known = KEYS[key];
        const spelling = known ?? single(key) ?? { code: key, keyCode: 0 };
        // `text` is what makes a key reach an input; a modified key has none,
        // or `Ctrl+A` would type an "a" into the field it was meant to act on.
        const text = modifiers === 0 || modifiers === MODIFIERS.shift ? spelling.text : undefined;
        const common = {
          key,
          code: spelling.code,
          windowsVirtualKeyCode: spelling.keyCode,
          nativeVirtualKeyCode: spelling.keyCode,
          modifiers,
        };
        await send("Input.dispatchKeyEvent", {
          ...common,
          type: text === undefined ? "rawKeyDown" : "keyDown",
          ...(text === undefined ? {} : { text }),
        });
        await send("Input.dispatchKeyEvent", { ...common, type: "keyUp" });
      },
    },
  };
  return cdp;
}
