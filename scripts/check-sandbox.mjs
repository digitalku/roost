/**
 * The sandbox, asserted against a **running window** rather than against the
 * values that were passed in.
 *
 * `apps/desktop/main/src/security.test.ts` checks that the right settings are
 * spelled out. That is worth having and it is not the same claim: a setting
 * Electron renamed, a header a session dropped, a policy the page overrode —
 * all of those pass a value test and fail here. `ARCHITECTURE.md` invariant 11
 * is what this file is for, and `ROADMAP.md` M3 does not accept until it passes.
 *
 *   node scripts/check-sandbox.mjs
 *
 * Exits non-zero on the first failure, so it can be a CI step. It needs
 * Electron's binary, which `ELECTRON_SKIP_BINARY_DOWNLOAD` suppresses.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9500 + (process.pid % 100);
const electron = createRequire(import.meta.url)("electron");
if (typeof electron !== "string") {
  console.error("electron is not installed (ELECTRON_SKIP_BINARY_DOWNLOAD?)");
  process.exit(2);
}

const child = spawn(
  electron,
  [
    "apps/desktop/main/dist/main.js",
    `--remote-debugging-port=${PORT}`,
    "--ozone-platform-hint=auto",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let noise = "";
child.stderr.on("data", (chunk) => {
  noise += chunk;
});

/**
 * Each check is a page expression returning `{ ok, saw }`.
 *
 * Written as expressions rather than as a helper injected into the page,
 * because a helper would itself be an inline script and the policy under test
 * is the one that decides whether inline scripts run.
 */
const CHECKS = [
  {
    name: "no Node globals in the renderer",
    why: "nodeIntegration: false and sandbox: true, observed rather than configured",
    expression: `(() => {
      const leaked = ["require", "process", "module", "exports", "global", "Buffer", "__dirname"]
        .filter((name) => typeof globalThis[name] !== "undefined");
      return { ok: leaked.length === 0, saw: leaked.join(", ") || "none" };
    })()`,
  },
  {
    name: "the bridge is the only door",
    why: "contextIsolation: true — the preload's surface and nothing beside it",
    expression: `(() => {
      const keys = Object.keys(window.roost ?? {}).sort();
      const expected = ["invoke", "onEvent", "pathForFile"];
      return { ok: JSON.stringify(keys) === JSON.stringify(expected), saw: keys.join(",") };
    })()`,
  },
  {
    name: "a remote script is refused by the policy",
    why: "the CSP header was applied by Electron, not merely computed by us",
    expression: violation(
      "script",
      `(() => {
      const script = document.createElement("script");
      script.src = "https://example.invalid/x.js";
      document.head.append(script);
    })()`,
    ),
  },
  {
    name: "a remote image is refused by the policy",
    why: "img-src allows 'self', roost:, data: and blob: — and nothing remote",
    expression: violation(
      "img",
      `(() => {
      const image = document.createElement("img");
      image.src = "https://example.invalid/x.png";
      document.body.append(image);
    })()`,
    ),
  },
  {
    name: "a remote stylesheet is refused by the policy",
    why: "no webfont, no CDN — invariant 7 says there is no network at run time",
    expression: violation(
      "style",
      `(() => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://example.invalid/x.css";
      document.head.append(link);
    })()`,
    ),
  },
  {
    name: "window.open answers with nothing",
    why: "setWindowOpenHandler denies every request (window.ts)",
    expression: `(() => {
      const opened = window.open("https://example.invalid/", "_blank");
      return { ok: opened === null, saw: opened === null ? "null" : "a window" };
    })()`,
  },
  {
    name: "navigating away does not navigate away",
    why: "will-navigate is denied for anything but the app's own origin",
    expression: `(async () => {
      const before = location.href;
      try {
        location.href = "https://example.invalid/";
      } catch {
        // A throw is also a refusal.
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { ok: location.href === before, saw: location.href.slice(0, 40) };
    })()`,
  },
  {
    name: "webview has no webview in it",
    why: "webviewTag: false — a webview would be a renderer with its own rules",
    /*
     * Not the constructor name. Chromium knows the tag — `createElement`
     * returns `HTMLElement` for it and `HTMLUnknownElement` for a name it has
     * never heard of — so a name check passes on a build where the tag works
     * and fails on one where it does not. What `webviewTag: false` actually
     * withholds is the API, so that is what is checked.
     */
    expression: `(() => {
      const element = document.createElement("webview");
      const present = ["getWebContentsId", "loadURL", "reload", "goBack", "executeJavaScript"]
        .filter((member) => member in element);
      return { ok: present.length === 0, saw: present.join(", ") || "no webview API" };
    })()`,
  },
];

/**
 * The policy Electron actually served, as opposed to the one we computed.
 *
 * `eval` cannot be tested from here: DevTools is exempt from the page's CSP, so
 * a `new Function` evaluated over CDP runs whatever the header says — the first
 * version of this file reported that as a hole and it was the measurement. The
 * header itself is not exempt from anything, and the violation checks above
 * prove it is being enforced.
 */
const HEADER_CHECKS = [
  { name: "no 'unsafe-eval', in either build", absent: "unsafe-eval" },
  { name: "no inline script in a packaged build", absent: "script-src 'self' 'unsafe-inline'" },
  { name: "nothing is allowed by default", present: "default-src 'none'" },
  { name: "roost: serves images", present: "img-src 'self' roost: data: blob:" },
  { name: "roost: serves media", present: "media-src 'self' roost: blob:" },
  { name: "no remote font, no CDN (invariant 7)", present: "font-src 'self'" },
  { name: "no plugin, no frame", present: "object-src 'none'" },
  { name: "no base tag rewriting the origin", present: "base-uri 'none'" },
];

/**
 * Attempts something the policy should refuse, and resolves with whether the
 * page reported a violation for `directive`.
 *
 * `securitypolicyviolation` is the browser saying it enforced a header it
 * received — which is the difference between this and reading the header back
 * out of our own code.
 */
function violation(directive, attempt) {
  return `(() => new Promise((resolve) => {
    const seen = [];
    const listener = (event) => seen.push(event.violatedDirective);
    document.addEventListener("securitypolicyviolation", listener);
    ${attempt};
    setTimeout(() => {
      document.removeEventListener("securitypolicyviolation", listener);
      const hit = seen.some((d) => d.startsWith(${JSON.stringify(directive)}));
      resolve({ ok: hit, saw: seen.join(", ") || "no violation reported" });
    }, 600);
  }))()`;
}

let failures = 0;
try {
  const cdp = await connect(PORT);

  console.log("The policy Electron served with the document\n");
  const policy = await cdp.documentPolicy();
  if (policy === undefined) {
    failures += 1;
    console.log("  FAIL  no Content-Security-Policy header on the document at all");
  } else {
    for (const check of HEADER_CHECKS) {
      const ok =
        check.present !== undefined
          ? policy.includes(check.present)
          : !policy.includes(check.absent);
      if (!ok) failures += 1;
      console.log(`  ${ok ? "ok  " : "FAIL"}  ${check.name}`);
    }
  }

  console.log("\nSandbox, as the window actually behaves\n");

  for (const check of CHECKS) {
    let result;
    try {
      result = await cdp.evaluate(check.expression);
    } catch (error) {
      result = { ok: false, saw: String(error).slice(0, 80) };
    }
    if (result?.ok !== true) failures += 1;
    console.log(`  ${result?.ok === true ? "ok  " : "FAIL"}  ${check.name} — ${result?.saw}`);
    if (result?.ok !== true) console.log(`        expected: ${check.why}`);
  }

  console.log("");
  const total = CHECKS.length + HEADER_CHECKS.length;
  console.log(failures === 0 ? "All clear." : `${failures} of ${total} failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  child.kill("SIGTERM");
  await sleep(300);
  child.kill("SIGKILL");
}

async function connect(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page !== undefined) return await session(page.webSocketDebuggerUrl);
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  throw new Error(`no page target after 15s\n${noise}`);
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
  await send("Network.enable");

  return {
    /**
     * The `Content-Security-Policy` on the document's own response.
     *
     * Read off the network event rather than out of our source, which is the
     * whole point: a header a session dropped, or one another handler
     * overwrote, is invisible to a test of the function that computes it.
     */
    async documentPolicy() {
      const arrived = new Promise((resolve) => {
        socket.addEventListener("message", (message) => {
          const event = JSON.parse(message.data);
          if (event.method !== "Network.responseReceived") return;
          if (event.params.type !== "Document") return;
          const headers = event.params.response.headers ?? {};
          const name = Object.keys(headers).find(
            (key) => key.toLowerCase() === "content-security-policy",
          );
          resolve(name === undefined ? undefined : headers[name]);
        });
      });
      await this.evaluate("location.reload()").catch(() => {});
      return Promise.race([arrived, sleep(8000).then(() => undefined)]);
    },

    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails !== undefined) {
        throw new Error(JSON.stringify(result.exceptionDetails.exception?.description ?? ""));
      }
      return result.result.value;
    },
  };
}
